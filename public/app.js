/* Outsourcing tracker — single-page client. No build step, no dependencies. */

const state = {
  view: location.hash.replace('#', '') || 'overview',
  meta: { orderTypes: ['diecut', 'inline'], statuses: [] },
  data: { plants: [], offers: [], allocations: [], production: [], imports: [] },
  overview: null,
  filter: { period: '', orderType: '', plantId: '' },
  pipelineFilter: { plantId: '', status: '', orderType: '' },
  importDraft: { csv: '', report: null, createMissingPlants: false, defaultOrderType: '' },
};

/* ------------------------------------------------------------- plumbing */

async function api(path, options = {}) {
  const res = await fetch(`/api/${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error || `request failed (${res.status})`);
  return payload;
}

const fmt = new Intl.NumberFormat('en-US');
const sqm = (n) => `${fmt.format(Math.round(n || 0))} m²`;
const short = (n) => {
  const v = Math.round(n || 0);
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(v % 1e6 ? 2 : 0)}M`;
  if (Math.abs(v) >= 1e4) return `${Math.round(v / 1e3)}k`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return fmt.format(v);
};
const pct = (n) => `${Math.round((n || 0) * 100)}%`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const monthName = (period) => {
  if (!/^\d{4}-\d{2}$/.test(period)) return period;
  const [y, m] = period.split('-');
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'][Number(m) - 1]} ${y}`;
};
const thisPeriod = () => new Date().toISOString().slice(0, 7);
const statusLabel = (key) => state.meta.statuses.find((s) => s.key === key)?.label || key;
const plantName = (id) => state.data.plants.find((p) => p.id === id)?.name || '—';

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

/* ---------------------------------------------------------------- modal */

const backdrop = document.getElementById('modal-backdrop');

function openModal(title, bodyHtml, onMount) {
  document.getElementById('modal-title').textContent = title;
  const body = document.getElementById('modal-body');
  body.innerHTML = bodyHtml;
  backdrop.hidden = false;
  onMount?.(body);
  body.querySelector('input, select, textarea')?.focus();
}
const closeModal = () => { backdrop.hidden = true; };

document.getElementById('modal-close').addEventListener('click', closeModal);
backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

/* ---------------------------------------------------------- form pieces */

const optionList = (items, selected) => items
  .map(({ value, label }) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`)
  .join('');

const plantOptions = (selected, { includeAll = false, allLabel = 'All plants' } = {}) => optionList([
  ...(includeAll ? [{ value: '', label: allLabel }] : []),
  ...state.data.plants.map((p) => ({ value: p.id, label: p.country ? `${p.name} (${p.country})` : p.name })),
], selected);

const typeOptions = (selected, { includeAll = false } = {}) => optionList([
  ...(includeAll ? [{ value: '', label: 'Both types' }] : []),
  ...state.meta.orderTypes.map((t) => ({ value: t, label: t === 'diecut' ? 'Diecut' : 'Inline' })),
], selected);

const statusOptions = (selected, { includeAll = false } = {}) => optionList([
  ...(includeAll ? [{ value: '', label: 'Any stage' }] : []),
  ...state.meta.statuses.map((s) => ({ value: s.key, label: s.label })),
], selected);

const periodOptions = (selected) => optionList([
  { value: '', label: 'All months' },
  ...(state.overview?.periods || []).map((p) => ({ value: p, label: monthName(p) })),
], selected);

const field = (label, control) => `<label class="field">${esc(label)}${control}</label>`;

/* -------------------------------------------------------------- gauges */

/**
 * Stacked capacity bar: produced (actuals) + still-open reservations against
 * the offered volume. Anything above the offer is drawn as an overflow segment
 * on top of a full bar so over-booking is impossible to miss.
 */
function capacityBar(b, { slim = false } = {}) {
  const scale = Math.max(b.offered, b.used) || 1;
  const withinProduced = Math.min(b.produced, b.offered || 0);
  const withinReserved = Math.min(b.openReserved, Math.max(0, (b.offered || 0) - b.produced));
  const seg = (value, cls) => (value > 0 ? `<div class="seg ${cls}" style="width:${(value / scale) * 100}%"></div>` : '');
  const mark = b.over > 0 && b.offered > 0
    ? `<div class="bar-mark" style="left:${(b.offered / scale) * 100}%" title="Offered ${sqm(b.offered)}"></div>` : '';
  return `<div class="bar${slim ? ' slim' : ''}" title="${esc(barTitle(b))}">
    ${seg(withinProduced, 'produced')}${seg(withinReserved, 'reserved')}${seg(b.over, 'over')}${mark}
  </div>`;
}

const barTitle = (b) => [
  `Offered ${sqm(b.offered)}`,
  `Produced ${sqm(b.produced)}`,
  `Open pipeline ${sqm(b.openReserved)}`,
  b.over > 0 ? `Over by ${sqm(b.over)}` : `Free ${sqm(b.free)}`,
].join(' · ');

const fillClass = (b) => (b.over > 0 ? 'over' : b.fill >= 0.95 ? 'full' : b.fill >= 0.75 ? 'warn' : '');

/* ---------------------------------------------------------------- views */

function overviewView() {
  const o = state.overview;
  if (!o) return '<div class="empty">Loading…</div>';
  const t = o.totals;

  const kpis = `
    <div class="kpis">
      <div class="kpi"><div class="label">Offered</div><div class="value">${short(t.offered)}</div>
        <div class="sub">m² across ${o.plants.length} plant${o.plants.length === 1 ? '' : 's'}</div></div>
      <div class="kpi produced"><div class="label">Produced</div><div class="value">${short(t.produced)}</div>
        <div class="sub">m² from imported data</div></div>
      <div class="kpi reserved"><div class="label">In processing</div><div class="value">${short(t.openReserved)}</div>
        <div class="sub">m² in the pipeline</div></div>
      <div class="kpi"><div class="label">Still free</div><div class="value">${short(t.free)}</div>
        <div class="sub">m² we can still place</div></div>
      <div class="kpi ${t.over > 0 ? 'over' : ''}"><div class="label">Utilisation</div><div class="value">${pct(t.fill)}</div>
        <div class="sub">${t.over > 0 ? `over by ${short(t.over)} m²` : 'of offered capacity'}</div></div>
    </div>`;

  const byType = o.byOrderType.filter((b) => b.offered || b.used).map((b) => `
    <div class="card card-pad">
      <div class="row"><span class="pill ${b.orderType}">${b.orderType === 'diecut' ? 'Diecut' : 'Inline'}</span>
        <span class="spacer"></span>
        <strong class="num">${pct(b.fill)}</strong></div>
      <div style="margin:9px 0 7px">${capacityBar(b)}</div>
      <div class="muted num" style="font-size:12px">${sqm(b.used)} used of ${sqm(b.offered)} offered</div>
    </div>`).join('');

  const cards = o.plants.length
    ? `<div class="plant-grid">${o.plants.map(plantCard).join('')}</div>`
    : `<div class="card empty">No plants yet. Add one on the <a href="#plants">Plants</a> tab, or import production data.</div>`;

  return `
    <div class="view-head">
      <div>
        <h1>Capacity overview</h1>
        <p>How full each partner plant is against what it offered us: green is produced, amber is what we already have in the pipeline.</p>
      </div>
      <div class="filters">
        ${field('Month', `<select data-filter="period">${periodOptions(state.filter.period)}</select>`)}
        ${field('Order type', `<select data-filter="orderType">${typeOptions(state.filter.orderType, { includeAll: true })}</select>`)}
      </div>
    </div>
    ${kpis}
    ${byType ? `<div class="section"><h2>By order type</h2><div class="kpis">${byType}</div></div>` : ''}
    <div class="section">
      <div class="row" style="margin-bottom:10px">
        <h2>Plants</h2><span class="spacer"></span>
        <div class="legend">
          <span class="key"><i class="swatch produced"></i>Produced</span>
          <span class="key"><i class="swatch reserved"></i>In processing</span>
          <span class="key"><i class="swatch free"></i>Free</span>
          <span class="key"><i class="swatch over"></i>Over offer</span>
        </div>
      </div>
      ${cards}
    </div>`;
}

function plantCard(entry) {
  const { plant, buckets } = entry;
  const rows = buckets
    .filter((b) => b.offered || b.used)
    .map((b) => `
      <div class="breakdown-row">
        <span class="lbl">${esc(monthName(b.period).replace(/ \d{4}$/, ''))} · ${b.orderType === 'diecut' ? 'DC' : 'IL'}</span>
        ${capacityBar(b, { slim: true })}
        <span class="val">${short(b.used)} / ${short(b.offered)}</span>
      </div>`).join('');

  return `
    <div class="plant-card${entry.over > 0 ? ' is-over' : ''}">
      <div class="plant-top">
        <div>
          <div class="plant-name">${esc(plant.name)}</div>
          <div class="plant-sub">${esc(plant.country || 'No country set')}${plant.active === false ? ' · inactive' : ''}</div>
        </div>
        <div class="fill-figure">
          <div class="fill-pct ${fillClass(entry)}">${entry.offered ? pct(entry.fill) : '—'}</div>
          <div class="plant-sub num">${short(entry.used)} / ${short(entry.offered)} m²</div>
        </div>
      </div>
      ${capacityBar(entry)}
      <div class="legend num">
        <span class="key"><i class="swatch produced"></i>${short(entry.produced)}</span>
        <span class="key"><i class="swatch reserved"></i>${short(entry.openReserved)}</span>
        <span class="key"><i class="swatch free"></i>${short(entry.free)} free</span>
        ${entry.over > 0 ? `<span class="key"><i class="swatch over"></i>${short(entry.over)} over</span>` : ''}
      </div>
      ${rows ? `<div class="breakdown">${rows}</div>` : '<div class="faint" style="font-size:12px">Nothing offered or booked in this view.</div>'}
      <div class="plant-actions">
        <button class="btn small primary" data-action="quick-allocate" data-plant="${plant.id}">+ In processing</button>
        <button class="btn small" data-action="quick-offer" data-plant="${plant.id}">+ Offer</button>
        <span class="spacer"></span>
        <button class="btn small" data-action="filter-plant" data-plant="${plant.id}">Pipeline</button>
      </div>
    </div>`;
}

/* ------------------------------------------------------------- pipeline */

function pipelineView() {
  const f = state.pipelineFilter;
  const rows = state.data.allocations
    .filter((a) => (!f.plantId || a.plantId === f.plantId)
      && (!f.status || a.status === f.status)
      && (!f.orderType || a.orderType === f.orderType))
    .sort((a, b) => b.period.localeCompare(a.period) || (b.createdAt || '').localeCompare(a.createdAt || ''));

  const total = rows.reduce((sum, r) => sum + r.sqm, 0);

  const body = rows.map((a) => `
    <tr data-id="${a.id}">
      <td>${esc(plantName(a.plantId))}</td>
      <td><span class="pill ${a.orderType}">${a.orderType === 'diecut' ? 'Diecut' : 'Inline'}</span></td>
      <td>${esc(monthName(a.period))}</td>
      <td class="right num">${sqm(a.sqm)}</td>
      <td><select data-action="set-status" data-id="${a.id}">${statusOptions(a.status)}</select></td>
      <td>${esc(a.reference || '')}</td>
      <td class="right num">${a.price != null && a.price !== '' ? esc(a.price) : ''}</td>
      <td class="muted">${esc(a.note || '')}</td>
      <td class="right"><button class="icon-btn" data-action="delete-allocation" data-id="${a.id}" title="Delete">✕</button></td>
    </tr>`).join('');

  return `
    <div class="view-head">
      <div>
        <h1>Pipeline</h1>
        <p>Every batch we are placing with a plant, from the first draft list through to orders opened in the system. Everything except rejected batches counts as reserved capacity.</p>
      </div>
      <button class="btn primary" data-action="quick-allocate">+ Add batch</button>
    </div>
    <div class="card card-pad section">
      <div class="filters">
        ${field('Plant', `<select data-pipeline-filter="plantId">${plantOptions(f.plantId, { includeAll: true })}</select>`)}
        ${field('Stage', `<select data-pipeline-filter="status">${statusOptions(f.status, { includeAll: true })}</select>`)}
        ${field('Order type', `<select data-pipeline-filter="orderType">${typeOptions(f.orderType, { includeAll: true })}</select>`)}
        <div class="spacer"></div>
        <div class="num"><strong>${sqm(total)}</strong> <span class="muted">in ${rows.length} batch${rows.length === 1 ? '' : 'es'}</span></div>
      </div>
    </div>
    ${rows.length ? `<div class="table-wrap card"><table>
      <thead><tr><th>Plant</th><th>Type</th><th>Month</th><th class="right">Quantity</th><th>Stage</th>
        <th>Reference</th><th class="right">Price</th><th>Note</th><th></th></tr></thead>
      <tbody>${body}</tbody></table></div>`
      : '<div class="card empty">No batches match this filter.</div>'}`;
}

/* ------------------------------------------------------ offered capacity */

function capacityView() {
  const rows = [...state.data.offers].sort(
    (a, b) => a.period.localeCompare(b.period) || plantName(a.plantId).localeCompare(plantName(b.plantId)),
  );
  const body = rows.map((o) => `
    <tr>
      <td>${esc(plantName(o.plantId))}</td>
      <td><span class="pill ${o.orderType}">${o.orderType === 'diecut' ? 'Diecut' : 'Inline'}</span></td>
      <td>${esc(monthName(o.period))}</td>
      <td class="right num">${sqm(o.sqm)}</td>
      <td class="muted">${esc(o.note || '')}</td>
      <td class="right"><button class="icon-btn" data-action="delete-offer" data-id="${o.id}" title="Delete">✕</button></td>
    </tr>`).join('');

  return `
    <div class="view-head">
      <div>
        <h1>Offered capacity</h1>
        <p>What each plant told us it can take: quantity, order type and month. This is the denominator behind every bar on the overview.</p>
      </div>
    </div>
    <div class="card card-pad section">
      <form class="form-grid" data-form="offer">
        ${field('Plant', `<select name="plantId" required>${plantOptions('')}</select>`)}
        ${field('Order type', `<select name="orderType">${typeOptions('inline')}</select>`)}
        ${field('Month', '<input type="month" name="period" required value="' + thisPeriod() + '" />')}
        ${field('Quantity (m²)', '<input name="sqm" required placeholder="200000 or 200k" />')}
        ${field('Note', '<input name="note" placeholder="optional" />')}
        <div class="actions"><button class="btn primary" type="submit">Add offer</button></div>
      </form>
    </div>
    ${rows.length ? `<div class="table-wrap card"><table>
      <thead><tr><th>Plant</th><th>Type</th><th>Month</th><th class="right">Offered</th><th>Note</th><th></th></tr></thead>
      <tbody>${body}</tbody></table></div>`
      : '<div class="card empty">No offers recorded yet.</div>'}`;
}

/* ----------------------------------------------------------- production */

function productionView() {
  const rows = [...state.data.production].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 400);
  const total = state.data.production.reduce((sum, r) => sum + r.sqm, 0);

  const body = rows.map((p) => `
    <tr>
      <td>${esc(p.date)}</td>
      <td>${esc(plantName(p.plantId))}</td>
      <td><span class="pill ${p.orderType}">${p.orderType === 'diecut' ? 'Diecut' : 'Inline'}</span></td>
      <td class="right num">${sqm(p.sqm)}</td>
      <td>${esc(p.reference || '')}</td>
      <td class="faint">${esc(p.source || 'manual')}</td>
      <td class="right"><button class="icon-btn" data-action="delete-production" data-id="${p.id}" title="Delete">✕</button></td>
    </tr>`).join('');

  return `
    <div class="view-head">
      <div>
        <h1>Production</h1>
        <p>Actual produced volume, normally loaded on the <a href="#import">Import</a> tab. ${sqm(total)} recorded in ${state.data.production.length} rows.</p>
      </div>
    </div>
    <div class="card card-pad section">
      <form class="form-grid" data-form="production">
        ${field('Plant', `<select name="plantId" required>${plantOptions('')}</select>`)}
        ${field('Order type', `<select name="orderType">${typeOptions('inline')}</select>`)}
        ${field('Date', '<input type="date" name="date" required />')}
        ${field('Quantity (m²)', '<input name="sqm" required placeholder="12500" />')}
        ${field('Reference', '<input name="reference" placeholder="optional" />')}
        <div class="actions"><button class="btn primary" type="submit">Add row</button></div>
      </form>
    </div>
    ${rows.length ? `<div class="table-wrap card"><table>
      <thead><tr><th>Date</th><th>Plant</th><th>Type</th><th class="right">Quantity</th><th>Reference</th><th>Source</th><th></th></tr></thead>
      <tbody>${body}</tbody></table></div>${state.data.production.length > rows.length
        ? `<p class="faint" style="margin-top:8px">Showing the ${rows.length} most recent rows of ${state.data.production.length}.</p>` : ''}`
      : '<div class="card empty">No production data yet.</div>'}`;
}

/* --------------------------------------------------------------- plants */

function plantsView() {
  const body = state.data.plants.map((p) => `
    <tr>
      <td>${esc(p.name)}</td>
      <td>${esc(p.country || '')}</td>
      <td>${esc(p.contact || '')}</td>
      <td class="muted">${esc(p.note || '')}</td>
      <td><span class="pill">${p.active === false ? 'Inactive' : 'Active'}</span></td>
      <td class="right">
        <button class="btn small" data-action="toggle-plant" data-id="${p.id}">${p.active === false ? 'Activate' : 'Deactivate'}</button>
        <button class="icon-btn" data-action="delete-plant" data-id="${p.id}" title="Delete plant and its data">✕</button>
      </td>
    </tr>`).join('');

  return `
    <div class="view-head">
      <div><h1>Plants</h1><p>The partner plants we can outsource to.</p></div>
    </div>
    <div class="card card-pad section">
      <form class="form-grid" data-form="plant">
        ${field('Name', '<input name="name" required placeholder="Croatia — Zagreb" />')}
        ${field('Country', '<input name="country" placeholder="Croatia" />')}
        ${field('Contact', '<input name="contact" placeholder="optional" />')}
        ${field('Note', '<input name="note" placeholder="optional" />')}
        <div class="actions"><button class="btn primary" type="submit">Add plant</button></div>
      </form>
    </div>
    ${state.data.plants.length ? `<div class="table-wrap card"><table>
      <thead><tr><th>Name</th><th>Country</th><th>Contact</th><th>Note</th><th>Status</th><th></th></tr></thead>
      <tbody>${body}</tbody></table></div>`
      : '<div class="card empty">No plants yet.</div>'}`;
}

/* --------------------------------------------------------------- import */

function importView() {
  const d = state.importDraft;
  const r = d.report;

  const reportCard = !r ? `<div class="card empty">Paste or choose a file, then press <strong>Check file</strong> to see what would be imported.</div>` : `
    <div class="card card-pad">
      <h2 style="margin-bottom:8px">${r.committed ? 'Imported' : 'Preview'}</h2>
      <div class="report-line"><span>Rows read</span><strong class="num">${r.totalRows}</strong></div>
      <div class="report-line"><span>Rows accepted</span><strong class="num">${r.accepted}</strong></div>
      <div class="report-line"><span>Rows rejected</span><strong class="num" style="color:${r.rejected ? 'var(--over)' : 'inherit'}">${r.rejected}</strong></div>
      <div class="report-line"><span>Total quantity</span><strong class="num">${sqm(r.totalSqm)}</strong></div>
      ${r.newPlants.length ? `<div class="report-line"><span>New plants</span><strong>${r.newPlants.map(esc).join(', ')}</strong></div>` : ''}
      <div class="report-line"><span>Columns matched</span><span class="faint">${Object.entries(r.columns).map(([k, v]) => `${k}→${esc(v)}`).join(', ')}</span></div>
      ${r.errors.length ? `<h3 style="margin:14px 0 7px;font-size:13px">Rejected rows</h3>
        <ul class="errors">${r.errors.map((e) => `<li><strong>Line ${e.line}</strong>: ${esc(e.problems.join('; '))}<br><span class="faint">${esc(e.raw)}</span></li>`).join('')}</ul>` : ''}
      ${!r.committed && r.accepted ? `<div class="row" style="margin-top:14px">
        <button class="btn primary" data-action="commit-import">Import ${r.accepted} rows</button>
        <span class="faint">Nothing is saved until you press this.</span></div>` : ''}
    </div>`;

  const batches = state.data.imports.length ? `
    <div class="card section">
      <div class="card-pad" style="border-bottom:1px solid var(--line)"><h2>Import history</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th>When</th><th class="right">Rows</th><th class="right">Quantity</th><th class="right">Skipped</th><th></th></tr></thead>
        <tbody>${[...state.data.imports].reverse().map((b) => `
          <tr>
            <td>${esc(new Date(b.createdAt).toLocaleString())}</td>
            <td class="right num">${b.rows}</td>
            <td class="right num">${sqm(b.sqm)}</td>
            <td class="right num">${b.skipped}</td>
            <td class="right"><button class="btn small danger" data-action="undo-import" data-id="${b.id}">Undo</button></td>
          </tr>`).join('')}</tbody>
      </table></div>
    </div>` : '';

  return `
    <div class="view-head">
      <div>
        <h1>Import production data</h1>
        <p>Drop in the file you get back from the plants. Columns are matched by name, so most exports work as-is; anything unrecognised is listed instead of silently dropped.</p>
      </div>
    </div>
    <div class="import-grid section">
      <div class="card card-pad">
        <div class="row" style="margin-bottom:10px">
          <input type="file" id="csv-file" accept=".csv,.txt,.tsv" style="max-width:280px" />
          <span class="spacer"></span>
          <button class="btn small" data-action="load-sample">Load example</button>
        </div>
        <textarea id="csv-text" rows="14" spellcheck="false"
          placeholder="plant,type,sqm,date,reference&#10;Croatia,inline,48000,2026-09-04,ORD-1043">${esc(d.csv)}</textarea>
        <div class="row" style="margin-top:11px">
          <label class="checkline"><input type="checkbox" id="create-plants" ${d.createMissingPlants ? 'checked' : ''} /> Create plants that don't exist yet</label>
          <label class="checkline">Default type if missing
            <select id="default-type" style="width:auto">${optionList([{ value: '', label: 'none' },
              { value: 'diecut', label: 'Diecut' }, { value: 'inline', label: 'Inline' }], d.defaultOrderType)}</select></label>
          <span class="spacer"></span>
          <button class="btn primary" data-action="check-import">Check file</button>
        </div>
        <p class="faint" style="margin-bottom:0">Recognised columns: <code class="mono">plant</code> (or factory, supplier, country),
          <code class="mono">type</code> (diecut / inline), <code class="mono">sqm</code> (m², quantity),
          <code class="mono">date</code> (or month/period) and optionally <code class="mono">reference</code>.
          Quantities like <code class="mono">200k</code>, <code class="mono">1 234,50</code> and dates like
          <code class="mono">04.09.2026</code> or <code class="mono">September 2026</code> are understood.</p>
      </div>
      ${reportCard}
    </div>
    ${batches}`;
}

const VIEWS = {
  overview: overviewView,
  pipeline: pipelineView,
  capacity: capacityView,
  production: productionView,
  plants: plantsView,
  import: importView,
};

/* --------------------------------------------------------------- render */

async function refresh() {
  const query = new URLSearchParams(Object.entries(state.filter).filter(([, v]) => v));
  const [data, overview] = await Promise.all([api('state'), api(`overview?${query}`)]);
  state.data = { ...state.data, ...data };
  state.overview = overview;
}

function render() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === state.view);
  });
  document.getElementById('view').innerHTML = (VIEWS[state.view] || overviewView)();
}

async function reload() {
  try {
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
  render();
}

/* --------------------------------------------------------------- modals */

function quickAllocateModal(plantId = '') {
  openModal('Add batch to the pipeline', `
    <form data-form="allocation" style="display:grid;gap:13px">
      <div class="form-grid">
        ${field('Plant', `<select name="plantId" required>${plantOptions(plantId)}</select>`)}
        ${field('Order type', `<select name="orderType">${typeOptions('inline')}</select>`)}
      </div>
      <div class="form-grid">
        ${field('Month', `<input type="month" name="period" required value="${state.filter.period || thisPeriod()}" />`)}
        ${field('Quantity (m²)', '<input name="sqm" required placeholder="150000 or 150k" />')}
      </div>
      <div class="form-grid">
        ${field('Stage', `<select name="status">${statusOptions('list_prepared')}</select>`)}
        ${field('Price (optional)', '<input name="price" placeholder="e.g. 0.42" />')}
      </div>
      ${field('Reference', '<input name="reference" placeholder="list name / order numbers" />')}
      ${field('Note', '<input name="note" placeholder="optional" />')}
      <div class="actions">
        <button type="button" class="btn" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn primary">Add to pipeline</button>
      </div>
    </form>`);
}

function quickOfferModal(plantId = '') {
  openModal('Record offered capacity', `
    <form data-form="offer" style="display:grid;gap:13px">
      <div class="form-grid">
        ${field('Plant', `<select name="plantId" required>${plantOptions(plantId)}</select>`)}
        ${field('Order type', `<select name="orderType">${typeOptions('inline')}</select>`)}
      </div>
      <div class="form-grid">
        ${field('Month', `<input type="month" name="period" required value="${state.filter.period || thisPeriod()}" />`)}
        ${field('Quantity (m²)', '<input name="sqm" required placeholder="200000 or 200k" />')}
      </div>
      ${field('Note', '<input name="note" placeholder="who told us, any conditions" />')}
      <div class="actions">
        <button type="button" class="btn" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn primary">Save offer</button>
      </div>
    </form>`);
}

/* ----------------------------------------------------------- form posts */

const formToObject = (form) => Object.fromEntries(new FormData(form).entries());

const SUBMITTERS = {
  plant: (body) => api('plants', { method: 'POST', body }),
  offer: (body) => api('offers', { method: 'POST', body }),
  allocation: (body) => api('allocations', { method: 'POST', body }),
  production: (body) => api('production', { method: 'POST', body }),
};

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form;
  try {
    await SUBMITTERS[kind](formToObject(form));
    closeModal();
    toast(`${kind[0].toUpperCase()}${kind.slice(1)} saved`);
    await reload();
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* -------------------------------------------------------------- actions */

const ACTIONS = {
  'close-modal': closeModal,

  'quick-allocate': (el) => quickAllocateModal(el.dataset.plant || ''),
  'quick-offer': (el) => quickOfferModal(el.dataset.plant || ''),

  'filter-plant': async (el) => {
    state.pipelineFilter.plantId = el.dataset.plant;
    location.hash = 'pipeline';
  },

  'delete-allocation': async (el) => {
    if (!confirm('Delete this batch from the pipeline?')) return;
    await api(`allocations/${el.dataset.id}`, { method: 'DELETE' });
    await reload();
  },
  'delete-offer': async (el) => {
    if (!confirm('Delete this offer?')) return;
    await api(`offers/${el.dataset.id}`, { method: 'DELETE' });
    await reload();
  },
  'delete-production': async (el) => {
    if (!confirm('Delete this production row?')) return;
    await api(`production/${el.dataset.id}`, { method: 'DELETE' });
    await reload();
  },
  'delete-plant': async (el) => {
    const plant = state.data.plants.find((p) => p.id === el.dataset.id);
    if (!confirm(`Delete "${plant?.name}"? Its offers, pipeline batches and production rows go with it.`)) return;
    await api(`plants/${el.dataset.id}`, { method: 'DELETE' });
    await reload();
  },
  'toggle-plant': async (el) => {
    const plant = state.data.plants.find((p) => p.id === el.dataset.id);
    await api(`plants/${el.dataset.id}`, { method: 'PATCH', body: { active: plant.active === false } });
    await reload();
  },

  'load-sample': async () => {
    state.importDraft.csv = await fetch('/sample-production.csv').then((r) => r.text());
    state.importDraft.report = null;
    render();
  },
  'check-import': () => runImport(false),
  'commit-import': () => runImport(true),
  'undo-import': async (el) => {
    if (!confirm('Remove every production row that came from this import?')) return;
    const result = await api(`imports/${el.dataset.id}`, { method: 'DELETE' });
    toast(`Removed ${result.rows} rows`);
    await reload();
  },
};

async function runImport(commit) {
  const d = state.importDraft;
  d.csv = document.getElementById('csv-text').value;
  d.createMissingPlants = document.getElementById('create-plants').checked;
  d.defaultOrderType = document.getElementById('default-type').value;
  if (!d.csv.trim()) return toast('Nothing to import yet', 'error');

  const report = await api('imports', {
    method: 'POST',
    body: {
      csv: d.csv,
      commit,
      createMissingPlants: d.createMissingPlants,
      defaultOrderType: d.defaultOrderType || null,
    },
  });
  d.report = report;
  if (commit) {
    toast(`Imported ${report.accepted} rows (${sqm(report.totalSqm)})`);
    d.csv = '';
  }
  await reload();
}

document.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT') return;
  const action = ACTIONS[el.dataset.action];
  if (!action) return;
  event.preventDefault();
  try {
    await action(el);
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.addEventListener('change', async (event) => {
  const el = event.target;
  try {
    if (el.dataset.action === 'set-status') {
      await api(`allocations/${el.dataset.id}`, { method: 'PATCH', body: { status: el.value } });
      toast(`Moved to "${statusLabel(el.value)}"`);
      return reload();
    }
    if (el.dataset.filter) {
      state.filter[el.dataset.filter] = el.value;
      return reload();
    }
    if (el.dataset.pipelineFilter) {
      state.pipelineFilter[el.dataset.pipelineFilter] = el.value;
      return render();
    }
    if (el.id === 'csv-file' && el.files?.[0]) {
      state.importDraft.csv = await el.files[0].text();
      state.importDraft.report = null;
      return render();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* Keep the textarea's content across re-renders triggered by other controls. */
document.addEventListener('input', (event) => {
  if (event.target.id === 'csv-text') state.importDraft.csv = event.target.value;
});

document.getElementById('tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) location.hash = tab.dataset.view;
});

window.addEventListener('hashchange', () => {
  state.view = location.hash.replace('#', '') || 'overview';
  render();
});

/* ------------------------------------------------------------ bootstrap */

(async function start() {
  try {
    state.meta = await api('meta');
  } catch (err) {
    toast(`Could not reach the server: ${err.message}`, 'error');
  }
  await reload();
})();
