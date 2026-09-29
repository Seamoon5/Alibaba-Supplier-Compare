/**
 * store.js — persistence for saved records and panel settings.
 *
 * Everything stays in chrome.storage.local on the user's machine. There is no
 * server, no account and no telemetry anywhere in this extension, which is both
 * a product decision and what keeps it inside the Chrome Web Store's rules.
 */

import { recordKey, makeRecord } from './schema.js';

const NS = 'asc';
const K_RECORDS = `${NS}:records`;
const K_SETTINGS = `${NS}:settings`;
const K_DIAG = `${NS}:diagnostics`;

export const DEFAULT_SETTINGS = {
  targetQty: 1,
  hideBelowMoq: false,
  verifiedOnly: false,
  manufacturersOnly: false,
  hideLowConfidence: false,
  sortBy: 'price',
  lastDiagnostics: null,
};

let memoryFallback = null; // used when chrome.storage is unavailable (tests)

function area() {
  const g = globalThis;
  if (g.chrome?.storage?.local) return g.chrome.storage.local;
  return null;
}

function promisify(fn, ...args) {
  return new Promise((resolve) => {
    try {
      const maybe = fn(...args, (result) => resolve(result));
      if (maybe && typeof maybe.then === 'function') maybe.then(resolve, () => resolve(undefined));
    } catch {
      resolve(undefined);
    }
  });
}

async function readKey(key) {
  const a = area();
  if (!a) {
    memoryFallback = memoryFallback || {};
    return memoryFallback[key];
  }
  const res = await promisify(a.get.bind(a), key);
  return res?.[key];
}

async function writeKey(key, value) {
  const a = area();
  if (!a) {
    memoryFallback = memoryFallback || {};
    memoryFallback[key] = value;
    return;
  }
  await promisify(a.set.bind(a), { [key]: value });
}

async function removeKey(key) {
  const a = area();
  if (!a) {
    if (memoryFallback) delete memoryFallback[key];
    return;
  }
  await promisify(a.remove.bind(a), key);
}

// ------------------------------------------------------------------ records

export async function getRecords() {
  const raw = await readKey(K_RECORDS);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => (r && typeof r === 'object' ? makeRecord(r) : null))
    .filter(Boolean);
}

export async function saveRecords(records) {
  await writeKey(K_RECORDS, records);
  return records;
}

/**
 * Insert or update by identity. Re-adding a product updates it in place rather
 * than creating a duplicate row.
 * @returns {{records: object[], action: 'added'|'updated'}}
 */
export async function upsertRecord(record) {
  const records = await getRecords();
  const key = recordKey(record);
  const idx = records.findIndex((r) => recordKey(r) === key);
  let action = 'added';
  if (idx >= 0) {
    records[idx] = record;
    action = 'updated';
  } else {
    records.push(record);
  }
  await saveRecords(records);
  return { records, action };
}

export async function removeRecord(key) {
  const records = await getRecords();
  const next = records.filter((r) => recordKey(r) !== key);
  await saveRecords(next);
  return next;
}

export async function clearRecords() {
  await writeKey(K_RECORDS, []);
  return [];
}

export async function hasRecord(key) {
  const records = await getRecords();
  return records.some((r) => recordKey(r) === key);
}

// ----------------------------------------------------------------- settings

export async function getSettings() {
  const raw = await readKey(K_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await writeKey(K_SETTINGS, next);
  return next;
}

export async function resetSettings() {
  await removeKey(K_SETTINGS);
  return { ...DEFAULT_SETTINGS };
}

// -------------------------------------------------------------- diagnostics

export async function saveDiagnostics(diag) {
  const trimmed = {
    ...diag,
    keyPaths: Array.isArray(diag?.keyPaths) ? diag.keyPaths.slice(0, 400) : [],
    savedAt: new Date().toISOString(),
  };
  await writeKey(K_DIAG, trimmed);
  return trimmed;
}

export async function getDiagnostics() {
  return (await readKey(K_DIAG)) || null;
}

export const KEYS = { K_RECORDS, K_SETTINGS, K_DIAG };
