/**
 * Loads a small, realistic dataset so the overview has something to show.
 * `npm run seed` — refuses to touch a database that already has plants unless
 * you pass --force.
 */
import * as store from './store.js';

const force = process.argv.includes('--force');
if (store.read('plants').length && !force) {
  console.error('Database already has plants. Re-run with --force to replace it.');
  process.exit(1);
}
for (const collection of ['plants', 'offers', 'allocations', 'production', 'imports']) {
  await store.replace(collection, []);
}

const PLANTS = [
  { name: 'Croatia', country: 'Croatia', contact: 'M. Novak' },
  { name: 'Poland', country: 'Poland', contact: 'K. Zieliński' },
  { name: 'Portugal', country: 'Portugal', contact: 'A. Ferreira' },
  { name: 'Turkey', country: 'Turkey', contact: 'E. Demir' },
];
const plants = Object.fromEntries(
  PLANTS.map((p) => [p.name, store.insert('plants', { ...p, note: '', active: true })]),
);

const OFFERS = [
  ['Croatia', 'inline', '2026-09', 200000], ['Croatia', 'diecut', '2026-09', 60000],
  ['Croatia', 'inline', '2026-10', 180000], ['Poland', 'diecut', '2026-09', 150000],
  ['Poland', 'diecut', '2026-10', 150000], ['Poland', 'inline', '2026-10', 80000],
  ['Portugal', 'inline', '2026-09', 120000], ['Portugal', 'inline', '2026-10', 120000],
  ['Turkey', 'diecut', '2026-10', 300000], ['Turkey', 'inline', '2026-10', 100000],
];
for (const [plant, orderType, period, sqm] of OFFERS) {
  store.insert('offers', { plantId: plants[plant].id, orderType, period, sqm, note: '' });
}

const ALLOCATIONS = [
  ['Croatia', 'inline', '2026-09', 150000, 'ordered', 'List CRO-09A'],
  ['Croatia', 'inline', '2026-10', 60000, 'sent', 'List CRO-10A'],
  ['Poland', 'diecut', '2026-09', 140000, 'ordered', 'List PL-09'],
  ['Poland', 'diecut', '2026-10', 90000, 'quoted', 'List PL-10'],
  ['Portugal', 'inline', '2026-09', 135000, 'approved', 'List PT-09'],
  ['Turkey', 'diecut', '2026-10', 80000, 'list_prepared', 'List TR-10 draft'],
  ['Turkey', 'inline', '2026-10', 40000, 'rejected', 'Price too high'],
];
for (const [plant, orderType, period, sqm, status, reference] of ALLOCATIONS) {
  store.insert('allocations', {
    plantId: plants[plant].id, orderType, period, sqm, status, reference, price: null, note: '',
  });
}

const PRODUCTION = [
  ['Croatia', 'inline', '2026-09-03', 48000], ['Croatia', 'inline', '2026-09-11', 61500],
  ['Croatia', 'diecut', '2026-09-17', 22000], ['Poland', 'diecut', '2026-09-08', 74200],
  ['Poland', 'diecut', '2026-09-22', 53000], ['Portugal', 'inline', '2026-09-15', 90000],
];
for (const [plant, orderType, date, sqm] of PRODUCTION) {
  store.insert('production', {
    plantId: plants[plant].id, orderType, date, sqm, reference: '', source: 'manual',
  });
}

await store.flush();
console.log(`Seeded ${PLANTS.length} plants, ${OFFERS.length} offers, ${ALLOCATIONS.length} pipeline batches, ${PRODUCTION.length} production rows.`);
console.log(`Database: ${store.dbPath}`);
