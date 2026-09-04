import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBuckets, totalBuckets, reservesCapacity, periodOf } from '../server/domain.js';
import { parseCsv, parseSqm, parseDate, parseOrderType, mapHeaders, detectDelimiter } from '../server/csv.js';

const data = {
  plants: [{ id: 'p1', name: 'Croatia' }],
  offers: [{ plantId: 'p1', orderType: 'inline', period: '2026-09', sqm: 200000 }],
  allocations: [
    { plantId: 'p1', orderType: 'inline', period: '2026-09', sqm: 150000, status: 'ordered' },
    { plantId: 'p1', orderType: 'inline', period: '2026-09', sqm: 40000, status: 'rejected' },
  ],
  production: [{ plantId: 'p1', orderType: 'inline', date: '2026-09-11', sqm: 60000 }],
};

test('rejected batches do not reserve capacity', () => {
  assert.equal(reservesCapacity('rejected'), false);
  assert.equal(reservesCapacity('list_prepared'), true);
});

test('produced volume consumes its own reservation instead of double counting', () => {
  const [b] = buildBuckets(data);
  assert.equal(b.offered, 200000);
  assert.equal(b.reserved, 150000);
  assert.equal(b.produced, 60000);
  assert.equal(b.openReserved, 90000);
  assert.equal(b.used, 150000);
  assert.equal(b.free, 50000);
  assert.equal(b.over, 0);
  assert.equal(b.fill, 0.75);
});

test('production beyond the reservation shows as over-booked', () => {
  const [b] = buildBuckets({
    ...data,
    allocations: [],
    production: [{ plantId: 'p1', orderType: 'inline', date: '2026-09-11', sqm: 260000 }],
  });
  assert.equal(b.used, 260000);
  assert.equal(b.over, 60000);
  assert.equal(b.free, 0);
});

test('filters narrow buckets by plant, period and order type', () => {
  assert.equal(buildBuckets(data, { period: '2026-10' }).length, 0);
  assert.equal(buildBuckets(data, { orderType: 'diecut' }).length, 0);
  assert.equal(buildBuckets(data, { plantId: 'p1', period: '2026-09' }).length, 1);
});

test('production is bucketed by the month of its date', () => {
  assert.equal(periodOf('2026-09-11'), '2026-09');
});

test('totals re-derive ratios from the summed volumes', () => {
  const total = totalBuckets(buildBuckets(data));
  assert.equal(total.offered, 200000);
  assert.equal(total.used, 150000);
  assert.equal(total.fill, 0.75);
});

test('quantities survive thousands separators, decimals and k/M suffixes', () => {
  assert.equal(parseSqm('200000'), 200000);
  assert.equal(parseSqm('200k'), 200000);
  assert.equal(parseSqm('1.5M'), 1500000);
  assert.equal(parseSqm('48 000'), 48000);
  assert.equal(parseSqm('1,234.50'), 1234.5);
  assert.equal(parseSqm('1.234,50'), 1234.5);
  assert.equal(parseSqm('12,5'), 12.5);
  assert.equal(parseSqm('48,000'), 48000);
  assert.ok(Number.isNaN(parseSqm('n/a')));
});

test('dates are read in the formats plants actually send', () => {
  assert.equal(parseDate('2026-09-04'), '2026-09-04');
  assert.equal(parseDate('04.09.2026'), '2026-09-04');
  assert.equal(parseDate('4/9/26'), '2026-09-04');
  assert.equal(parseDate('2026-09'), '2026-09-01');
  assert.equal(parseDate('September 2026'), '2026-09-01');
  assert.equal(parseDate('sep-26'), '2026-09-01');
  assert.equal(parseDate('rubbish'), null);
});

test('order types tolerate the plants own spelling', () => {
  assert.equal(parseOrderType('Die-Cut'), 'diecut');
  assert.equal(parseOrderType('INLINE'), 'inline');
  assert.equal(parseOrderType('offset'), null);
});

test('CSV reader handles quotes, semicolons and CRLF', () => {
  const rows = parseCsv('a;b\r\n"x;1";"say ""hi"""\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x;1', 'say "hi"']]);
  assert.equal(detectDelimiter('a;b;c'), ';');
});

test('headers map through common aliases', () => {
  const map = mapHeaders(['Factory', 'Order Type', 'M2', 'Production Date', 'Order No']);
  assert.deepEqual(map, { plant: 0, orderType: 1, sqm: 2, date: 3, reference: 4 });
});
