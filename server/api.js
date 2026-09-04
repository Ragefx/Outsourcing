import * as store from './store.js';
import {
  ORDER_TYPES, ALLOCATION_STATUSES, isPeriod, isDate, periodOf,
  summarisePlants, buildBuckets, totalBuckets,
} from './domain.js';
import { parseCsv, mapHeaders, parseSqm, parseDate, parseOrderType } from './csv.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (message) => { throw new HttpError(400, message); };
const notFound = (what) => { throw new HttpError(404, `${what} not found`); };

const STATUS_KEYS = new Set(ALLOCATION_STATUSES.map((s) => s.key));

function snapshot() {
  return {
    plants: store.read('plants'),
    offers: store.read('offers'),
    allocations: store.read('allocations'),
    production: store.read('production'),
  };
}

function requireSqm(value) {
  const sqm = typeof value === 'number' ? value : parseSqm(value);
  if (!Number.isFinite(sqm) || sqm <= 0) bad('sqm must be a positive number');
  return Math.round(sqm);
}

function requirePlant(plantId) {
  const plant = store.read('plants').find((p) => p.id === plantId);
  if (!plant) bad('unknown plantId');
  return plant;
}

function requireOrderType(value) {
  const type = ORDER_TYPES.includes(value) ? value : parseOrderType(value);
  if (!type) bad(`orderType must be one of ${ORDER_TYPES.join(', ')}`);
  return type;
}

function requirePeriod(value) {
  const period = isDate(value) ? periodOf(value) : value;
  if (!isPeriod(period)) bad('period must be YYYY-MM');
  return period;
}

const trim = (value, fallback = '') => (typeof value === 'string' ? value.trim() : fallback);

/* ---------------------------------------------------------------- plants */

function createPlant(body) {
  const name = trim(body.name);
  if (!name) bad('name is required');
  const existing = store.read('plants').find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing) bad(`a plant named "${name}" already exists`);
  return store.insert('plants', {
    name,
    country: trim(body.country),
    contact: trim(body.contact),
    note: trim(body.note),
    active: body.active !== false,
  });
}

function updatePlant(id, body) {
  const patch = {};
  for (const field of ['name', 'country', 'contact', 'note']) {
    if (body[field] !== undefined) patch[field] = trim(body[field]);
  }
  if (body.active !== undefined) patch.active = Boolean(body.active);
  if (patch.name === '') bad('name is required');
  return store.update('plants', id, patch) || notFound('plant');
}

function deletePlant(id) {
  requirePlant(id);
  const counts = {
    offers: store.removeWhere('offers', (r) => r.plantId === id),
    allocations: store.removeWhere('allocations', (r) => r.plantId === id),
    production: store.removeWhere('production', (r) => r.plantId === id),
  };
  store.remove('plants', id);
  return { deleted: true, cascaded: counts };
}

/* ---------------------------------------------------------------- offers */

function offerFrom(body) {
  requirePlant(body.plantId);
  return {
    plantId: body.plantId,
    orderType: requireOrderType(body.orderType),
    period: requirePeriod(body.period),
    sqm: requireSqm(body.sqm),
    note: trim(body.note),
  };
}

/* ----------------------------------------------------------- allocations */

function allocationFrom(body) {
  requirePlant(body.plantId);
  const status = body.status || 'list_prepared';
  if (!STATUS_KEYS.has(status)) bad(`unknown status "${status}"`);
  return {
    plantId: body.plantId,
    orderType: requireOrderType(body.orderType),
    period: requirePeriod(body.period),
    sqm: requireSqm(body.sqm),
    status,
    reference: trim(body.reference),
    price: body.price === '' || body.price == null ? null : Number(body.price),
    note: trim(body.note),
  };
}

function updateAllocation(id, body) {
  const current = store.read('allocations').find((r) => r.id === id) || notFound('allocation');
  const patch = {};
  if (body.status !== undefined) {
    if (!STATUS_KEYS.has(body.status)) bad(`unknown status "${body.status}"`);
    patch.status = body.status;
  }
  if (body.sqm !== undefined) patch.sqm = requireSqm(body.sqm);
  if (body.orderType !== undefined) patch.orderType = requireOrderType(body.orderType);
  if (body.period !== undefined) patch.period = requirePeriod(body.period);
  if (body.plantId !== undefined) patch.plantId = requirePlant(body.plantId).id;
  for (const field of ['reference', 'note']) {
    if (body[field] !== undefined) patch[field] = trim(body[field]);
  }
  if (body.price !== undefined) patch.price = body.price === '' || body.price === null ? null : Number(body.price);
  return store.update('allocations', current.id, patch);
}

/* ------------------------------------------------------------ production */

function productionFrom(body) {
  requirePlant(body.plantId);
  const date = isDate(body.date) ? body.date : parseDate(body.date);
  if (!date) bad('date must be a valid date');
  return {
    plantId: body.plantId,
    orderType: requireOrderType(body.orderType),
    date,
    sqm: requireSqm(body.sqm),
    reference: trim(body.reference),
    source: 'manual',
  };
}

/* --------------------------------------------------------------- imports */

/**
 * Turn a pasted/uploaded CSV into production rows. Always returns a full report
 * so the UI can show what would happen before anything is written (`commit`).
 */
function importProduction({ csv, commit = false, createMissingPlants = false, defaultOrderType = null }) {
  if (!trim(csv)) bad('csv content is required');
  const rows = parseCsv(csv);
  if (rows.length < 2) bad('CSV needs a header row and at least one data row');

  const header = rows[0];
  const columns = mapHeaders(header);
  const missing = ['plant', 'sqm', 'date'].filter((f) => columns[f] === undefined);
  if (missing.length) {
    bad(`could not find column(s) for: ${missing.join(', ')}. Header was: ${header.join(', ')}`);
  }

  const plants = store.read('plants');
  const byName = new Map(plants.map((p) => [p.name.trim().toLowerCase(), p]));
  const newPlantNames = new Set();
  const accepted = [];
  const errors = [];

  rows.slice(1).forEach((cells, i) => {
    const lineNo = i + 2;
    const at = (field) => (columns[field] === undefined ? '' : (cells[columns[field]] ?? '').trim());
    const plantName = at('plant');
    const sqm = parseSqm(at('sqm'));
    const date = parseDate(at('date'));
    const orderType = parseOrderType(at('orderType')) || defaultOrderType;

    const problems = [];
    if (!plantName) problems.push('missing plant');
    if (!Number.isFinite(sqm) || sqm <= 0) problems.push(`bad sqm "${at('sqm')}"`);
    if (!date) problems.push(`bad date "${at('date')}"`);
    if (!orderType) problems.push(`bad order type "${at('orderType')}" (expected diecut or inline)`);

    const key = plantName.toLowerCase();
    const plant = byName.get(key);
    if (plantName && !plant && !createMissingPlants) problems.push(`unknown plant "${plantName}"`);

    if (problems.length) {
      errors.push({ line: lineNo, problems, raw: cells.join(' | ') });
      return;
    }
    if (!plant) newPlantNames.add(plantName);
    accepted.push({
      plantName, plantKey: key, orderType, date, sqm: Math.round(sqm), reference: at('reference'), line: lineNo,
    });
  });

  const report = {
    committed: false,
    totalRows: rows.length - 1,
    accepted: accepted.length,
    rejected: errors.length,
    totalSqm: accepted.reduce((sum, r) => sum + r.sqm, 0),
    newPlants: [...newPlantNames],
    errors: errors.slice(0, 50),
    preview: accepted.slice(0, 10),
    columns: Object.fromEntries(Object.entries(columns).map(([k, v]) => [k, header[v]])),
  };
  if (!commit || !accepted.length) return report;

  for (const name of newPlantNames) {
    byName.set(name.toLowerCase(), store.insert('plants', {
      name, country: '', contact: '', note: 'Created by CSV import', active: true,
    }));
  }
  const batch = store.insert('imports', {
    rows: accepted.length,
    sqm: report.totalSqm,
    skipped: errors.length,
  });
  store.insertMany('production', accepted.map((r) => ({
    plantId: byName.get(r.plantKey).id,
    orderType: r.orderType,
    date: r.date,
    sqm: r.sqm,
    reference: r.reference,
    source: 'import',
    batchId: batch.id,
  })));

  return { ...report, committed: true, batchId: batch.id };
}

function deleteImportBatch(batchId) {
  const removed = store.removeWhere('production', (r) => r.batchId === batchId);
  store.remove('imports', batchId);
  return { deleted: true, rows: removed };
}

/* -------------------------------------------------------------- overview */

function overview(query) {
  const filter = {
    plantId: query.plantId || null,
    period: query.period || null,
    orderType: query.orderType || null,
  };
  const data = snapshot();
  const plants = summarisePlants(data, filter);
  const all = buildBuckets(data, filter);
  const periods = [...new Set([
    ...data.offers.map((o) => o.period),
    ...data.allocations.map((a) => a.period),
    ...data.production.map((p) => periodOf(p.date)),
  ])].filter(Boolean).sort();

  return {
    filter,
    periods,
    totals: totalBuckets(all),
    byOrderType: ORDER_TYPES.map((orderType) => ({
      orderType,
      ...totalBuckets(all.filter((b) => b.orderType === orderType)),
    })),
    plants: plants.sort((a, b) => b.fill - a.fill || a.plant.name.localeCompare(b.plant.name)),
  };
}

/* --------------------------------------------------------------- routing */

const collectionRoutes = {
  offers: { build: offerFrom },
  production: { build: productionFrom },
};

export function handle(method, segments, body, query) {
  const [resource, id, sub] = segments;

  if (resource === 'meta' && method === 'GET') {
    return { orderTypes: ORDER_TYPES, statuses: ALLOCATION_STATUSES };
  }
  if (resource === 'overview' && method === 'GET') return overview(query);

  if (resource === 'plants') {
    if (method === 'GET' && !id) return store.read('plants');
    if (method === 'POST' && !id) return createPlant(body);
    if (method === 'PATCH' && id) return updatePlant(id, body);
    if (method === 'DELETE' && id) return deletePlant(id);
  }

  if (resource === 'allocations') {
    if (method === 'GET' && !id) return store.read('allocations');
    if (method === 'POST' && !id) return store.insert('allocations', allocationFrom(body));
    if (method === 'PATCH' && id) return updateAllocation(id, body);
    if (method === 'DELETE' && id) return store.remove('allocations', id) ? { deleted: true } : notFound('allocation');
  }

  if (collectionRoutes[resource]) {
    const { build } = collectionRoutes[resource];
    if (method === 'GET' && !id) return store.read(resource);
    if (method === 'POST' && !id) return store.insert(resource, build(body));
    if (method === 'DELETE' && id) return store.remove(resource, id) ? { deleted: true } : notFound(resource);
  }

  if (resource === 'imports') {
    if (method === 'GET' && !id) return store.read('imports');
    if (method === 'POST' && !id) return importProduction(body || {});
    if (method === 'DELETE' && id) return deleteImportBatch(id);
  }

  if (resource === 'state' && method === 'GET') return { ...snapshot(), imports: store.read('imports') };

  if (resource && sub) notFound('route');
  throw new HttpError(404, `no route for ${method} /api/${segments.join('/')}`);
}

export { HttpError, importProduction };
