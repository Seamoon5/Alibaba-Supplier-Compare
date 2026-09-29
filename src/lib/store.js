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
const K_LAST_CAPTURE = `${NS}:lastCapture`;
const K_LAST_TAB = `${NS}:lastTab`;

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

/**
 * Insert or update many records in one pass.
 *
 * A results page can hold 20+ cards. Upserting them one at a time would do two
 * storage reads and a write per card; this reads once and writes once.
 *
 * @returns {{records: object[], added: number, updated: number}}
 */
export async function upsertRecords(incoming) {
  const records = await getRecords();
  const index = new Map(records.map((r, i) => [recordKey(r), i]));
  let added = 0;
  let updated = 0;

  for (const record of incoming) {
    const key = recordKey(record);
    if (index.has(key)) {
      records[index.get(key)] = record;
      updated += 1;
    } else {
      index.set(key, records.length);
      records.push(record);
      added += 1;
    }
  }

  await saveRecords(records);
  return { records, added, updated };
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

/**
 * The most recent capture result, stored rather than only broadcast.
 *
 * Pressing the toolbar button is what opens the side panel, so the panel
 * usually finishes loading AFTER the capture has already run. A broadcast-only
 * design therefore drops the result message exactly when it is needed most,
 * and the user sees no feedback at all.
 */
export async function saveLastCapture(entry) {
  const value = {
    at: entry?.at || Date.now(),
    result: entry?.result || null,
  };
  await writeKey(K_LAST_CAPTURE, value);
  return value;
}

export async function getLastCapture() {
  return (await readKey(K_LAST_CAPTURE)) || null;
}

export async function clearLastCapture() {
  await removeKey(K_LAST_CAPTURE);
}

/**
 * The last tab URL we legitimately had access to.
 *
 * Kept because the extension asks for activeTab, not the broad "tabs"
 * permission. Storing it is not a privacy expansion: the value is only ever a
 * page the user themselves pointed the extension at.
 */
export async function saveLastTab(entry) {
  const value = { url: entry?.url || '', at: entry?.at || Date.now() };
  await writeKey(K_LAST_TAB, value);
  return value;
}

export async function getLastTab() {
  return (await readKey(K_LAST_TAB)) || null;
}

export const KEYS = { K_RECORDS, K_SETTINGS, K_DIAG, K_LAST_CAPTURE, K_LAST_TAB };
