/** Shared vocabulary and the capacity maths used by both the API and the tests. */

export const ORDER_TYPES = ['diecut', 'inline'];

/**
 * The lifecycle of an outsourced batch, from "we drafted a list" to "orders are
 * in the system". Everything except `rejected` reserves capacity at the plant.
 */
export const ALLOCATION_STATUSES = [
  { key: 'list_prepared', label: 'List prepared', reserves: true },
  { key: 'sent', label: 'Sent to plant', reserves: true },
  { key: 'quoted', label: 'Prices received', reserves: true },
  { key: 'approved', label: 'Prices OK', reserves: true },
  { key: 'ordered', label: 'Orders opened', reserves: true },
  { key: 'rejected', label: 'Rejected / cancelled', reserves: false },
];

const RESERVING = new Set(ALLOCATION_STATUSES.filter((s) => s.reserves).map((s) => s.key));

export function reservesCapacity(status) {
  return RESERVING.has(status);
}

export function isPeriod(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function periodOf(date) {
  return String(date).slice(0, 7);
}

export function periodLabel(period) {
  if (!isPeriod(period)) return period;
  const [year, month] = period.split('-');
  const name = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'][Number(month) - 1];
  return `${name} ${year}`;
}

const bucketKey = (plantId, period, orderType) => `${plantId}|${period}|${orderType}`;

function emptyBucket(plantId, period, orderType) {
  return { plantId, period, orderType, offered: 0, reserved: 0, produced: 0 };
}

/**
 * Roll offers, allocations and imported production into per
 * plant/period/order-type buckets.
 *
 * Production is what a plant actually made; reservations are what we have in the
 * pipeline for it. A batch we reserved and that has since been produced would
 * otherwise be counted twice, so produced volume consumes the reservation in
 * its own bucket first — `openReserved` is only the part not yet covered.
 */
export function buildBuckets({ offers = [], allocations = [], production = [] }, filter = {}) {
  const matches = (row, period) =>
    (!filter.plantId || row.plantId === filter.plantId) &&
    (!filter.period || period === filter.period) &&
    (!filter.orderType || row.orderType === filter.orderType);

  const buckets = new Map();
  const bucket = (plantId, period, orderType) => {
    const key = bucketKey(plantId, period, orderType);
    if (!buckets.has(key)) buckets.set(key, emptyBucket(plantId, period, orderType));
    return buckets.get(key);
  };

  for (const offer of offers) {
    if (!matches(offer, offer.period)) continue;
    bucket(offer.plantId, offer.period, offer.orderType).offered += Number(offer.sqm) || 0;
  }
  for (const alloc of allocations) {
    if (!reservesCapacity(alloc.status)) continue;
    if (!matches(alloc, alloc.period)) continue;
    bucket(alloc.plantId, alloc.period, alloc.orderType).reserved += Number(alloc.sqm) || 0;
  }
  for (const record of production) {
    const period = periodOf(record.date);
    if (!matches(record, period)) continue;
    bucket(record.plantId, period, record.orderType).produced += Number(record.sqm) || 0;
  }

  return [...buckets.values()].map(withDerived).sort(
    (a, b) => a.period.localeCompare(b.period) || a.orderType.localeCompare(b.orderType),
  );
}

function withDerived(b) {
  const openReserved = Math.max(0, b.reserved - b.produced);
  const used = b.produced + openReserved;
  return {
    ...b,
    openReserved,
    used,
    free: Math.max(0, b.offered - used),
    over: Math.max(0, used - b.offered),
    fill: b.offered > 0 ? used / b.offered : 0,
  };
}

/** Sum a set of buckets into one, re-deriving the ratios from the totals. */
export function totalBuckets(buckets, seed = {}) {
  const sum = buckets.reduce(
    (acc, b) => {
      acc.offered += b.offered;
      acc.reserved += b.reserved;
      acc.produced += b.produced;
      acc.openReserved += b.openReserved;
      return acc;
    },
    { offered: 0, reserved: 0, produced: 0, openReserved: 0 },
  );
  const used = sum.produced + sum.openReserved;
  return {
    ...seed,
    ...sum,
    used,
    free: Math.max(0, sum.offered - used),
    over: Math.max(0, used - sum.offered),
    fill: sum.offered > 0 ? used / sum.offered : 0,
  };
}

/** Per-plant summary plus the buckets behind it, ready for the overview page. */
export function summarisePlants(data, filter = {}) {
  const buckets = buildBuckets(data, filter);
  const byPlant = new Map();
  for (const b of buckets) {
    if (!byPlant.has(b.plantId)) byPlant.set(b.plantId, []);
    byPlant.get(b.plantId).push(b);
  }
  return data.plants
    .filter((p) => !filter.plantId || p.id === filter.plantId)
    .map((plant) => {
      const own = byPlant.get(plant.id) || [];
      return { plant, buckets: own, ...totalBuckets(own) };
    });
}
