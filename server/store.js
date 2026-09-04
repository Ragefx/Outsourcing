import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DB_PATH || path.join(root, 'data', 'db.json');

const EMPTY = { plants: [], offers: [], allocations: [], production: [], imports: [] };

let db = null;
let writeQueue = Promise.resolve();

function load() {
  if (db) return db;
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    db = { ...EMPTY, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    db = structuredClone(EMPTY);
  }
  return db;
}

/** Writes are serialised and atomic: full file to a temp path, then rename. */
function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writeQueue = writeQueue.then(async () => {
    await fs.promises.mkdir(path.dirname(DB_PATH), { recursive: true });
    const tmp = `${DB_PATH}.tmp`;
    await fs.promises.writeFile(tmp, snapshot, 'utf8');
    await fs.promises.rename(tmp, DB_PATH);
  });
  return writeQueue;
}

export function read(collection) {
  return load()[collection];
}

export function replace(collection, rows) {
  load()[collection] = rows;
  return persist();
}

export function insert(collection, row) {
  const rows = read(collection);
  const record = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...row };
  rows.push(record);
  persist();
  return record;
}

export function insertMany(collection, newRows) {
  const rows = read(collection);
  const stamp = new Date().toISOString();
  const records = newRows.map((row) => ({ id: crypto.randomUUID(), createdAt: stamp, ...row }));
  rows.push(...records);
  persist();
  return records;
}

export function update(collection, id, patch) {
  const rows = read(collection);
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  rows[idx] = { ...rows[idx], ...patch, id, updatedAt: new Date().toISOString() };
  persist();
  return rows[idx];
}

export function remove(collection, id) {
  const rows = read(collection);
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  rows.splice(idx, 1);
  persist();
  return true;
}

export function removeWhere(collection, predicate) {
  const rows = read(collection);
  const kept = rows.filter((r) => !predicate(r));
  const removed = rows.length - kept.length;
  if (removed) replace(collection, kept);
  return removed;
}

export function flush() {
  return writeQueue;
}

export const dbPath = DB_PATH;
