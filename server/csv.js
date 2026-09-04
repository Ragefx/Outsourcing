/** Minimal RFC-4180-ish CSV reader: quoted fields, escaped quotes, CRLF, ; or , or tab. */

export function detectDelimiter(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const counts = [',', ';', '\t'].map((d) => [d, line.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ',';
}

export function parseCsv(text, delimiter = detectDelimiter(text)) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const normalise = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Column aliases, so a plant's own export usually imports without editing. */
const ALIASES = {
  plant: ['plant', 'factory', 'supplier', 'country', 'plantname', 'location', 'site'],
  orderType: ['type', 'ordertype', 'production', 'process', 'kind'],
  sqm: ['sqm', 'm2', 'squaremeters', 'squaremetres', 'quantity', 'qty', 'area'],
  date: ['date', 'productiondate', 'deliverydate', 'week', 'month', 'period'],
  reference: ['reference', 'ref', 'order', 'ordernumber', 'orderno', 'job', 'item'],
};

export function mapHeaders(header) {
  const map = {};
  header.forEach((raw, index) => {
    const key = normalise(raw);
    for (const [field, aliases] of Object.entries(ALIASES)) {
      if (map[field] === undefined && aliases.includes(key)) map[field] = index;
    }
  });
  return map;
}

/** "1 234,50", "1,234.50" and "200k" all mean what you'd expect. */
export function parseSqm(value) {
  let text = String(value).trim().toLowerCase().replace(/\s|m2|sqm|㎡/g, '');
  let multiplier = 1;
  if (/[km]$/.test(text)) {
    multiplier = text.endsWith('k') ? 1e3 : 1e6;
    text = text.slice(0, -1);
  }
  if (text.includes(',') && text.includes('.')) {
    text = text.lastIndexOf(',') > text.lastIndexOf('.')
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (text.includes(',')) {
    text = /,\d{3}$/.test(text) ? text.replace(/,/g, '') : text.replace(',', '.');
  }
  const num = Number(text);
  return Number.isFinite(num) ? num * multiplier : NaN;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Accepts ISO dates, D/M/YYYY, YYYY-MM and "September 2026" / "sep-26". */
export function parseDate(value, fallbackYear = new Date().getFullYear()) {
  const text = String(value).trim();
  if (!text) return null;

  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = text.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-01`;

  m = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }

  m = text.toLowerCase().match(/^([a-z]{3,})[\s-]*(\d{2,4})?$/);
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3));
    if (month >= 0) {
      const year = m[2] ? (m[2].length === 2 ? `20${m[2]}` : m[2]) : String(fallbackYear);
      return `${year}-${String(month + 1).padStart(2, '0')}-01`;
    }
  }
  return null;
}

export function parseOrderType(value) {
  const key = normalise(value);
  if (key.includes('diecut') || key === 'dc' || key.includes('die')) return 'diecut';
  if (key.includes('inline') || key === 'il') return 'inline';
  return null;
}
