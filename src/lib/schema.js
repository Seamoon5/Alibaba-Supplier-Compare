/**
 * schema.js — the shape of a saved supplier record, and the metadata that
 * describes it to the UI and to exporters.
 *
 * Kept free of any `chrome.*` usage so it can be imported by the test runner.
 */

/** Bump when the stored record shape changes incompatibly. */
export const SCHEMA_VERSION = 1;

/** Where a field's value came from. Stored per field so breakage is diagnosable. */
export const PROVENANCE = {
  TIER1: 'blob:path',      // known componentsVO / globalData path
  TIER2: 'blob:fuzzy',     // recursive key-pattern walk of the same blob
  TIER3: 'ld+json',        // schema.org JSON-LD
  TIER4: 'dom',            // label scan of the rendered page
  MISSING: 'missing',      // not found by any tier
};

/** Fields whose absence makes a record untrustworthy. */
export const CORE_FIELDS = ['title', 'priceTiers', 'moqQty', 'companyName'];

/**
 * Search results carry no tier ladder and often no price at all — a supplier
 * card is a company profile, not an offer. Demanding a price ladder there would
 * mark nearly every row "partial" and drown the signal that matters.
 */
export const SEARCH_CORE_FIELDS = ['companyName'];

/** Fields we attempt to capture, with display labels used by the panel and exporters. */
export const FIELD_LABELS = {
  title: 'Product',
  companyName: 'Supplier',
  unitPrice: 'Unit price',
  total: 'Total',
  moqQty: 'MOQ',
  moqUnit: 'MOQ unit',
  yearsOnPlatform: 'Years on Alibaba',
  verifiedSupplier: 'Verified supplier',
  tradeAssurance: 'Trade Assurance',
  businessType: 'Business type',
  country: 'Country',
  currency: 'Currency',
  responseRate: 'Response time',
  onTimeDelivery: 'On-time delivery',
  reorderRate: 'Reorder rate',
  onlineRevenue: 'Online revenue',
  leadTime: 'Lead time',
  tierCount: 'Price tiers',
  capturedAt: 'Captured',
  sourceUrl: 'URL',
  companyUrl: 'Supplier URL',
};

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function toNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  // Handles "1,234.00", "$1,234", "12 pcs", "1.5 tons"
  const m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Percentages arrive as numbers or as "95%" strings. Keep a sane 0..100. */
function pct(v) {
  const n = toNum(v);
  if (n === null) return null;
  if (n < 0 || n > 100) return null;
  return n;
}

/** Normalise one price tier into { minQty, maxQty, unitPrice }. maxQty null = open ended. */
export function normalizeTier(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const minQty = toNum(raw.minQty ?? raw.min ?? raw.start ?? raw.minQuantity);
  const unitPrice = toNum(raw.unitPrice ?? raw.price ?? raw.amount ?? raw.value);
  if (minQty === null || unitPrice === null || minQty < 0 || unitPrice < 0) return null;

  let maxQty = toNum(raw.maxQty ?? raw.max ?? raw.end ?? raw.maxQuantity);
  if (maxQty !== null && maxQty < minQty) maxQty = null;

  return { minQty, maxQty, unitPrice };
}

/**
 * Normalise a price ladder. Drops invalid rows, sorts ascending by minQty and
 * de-duplicates identical bands. Always returns an array, never null.
 */
export function normalizeTiers(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const row of raw) {
    const t = normalizeTier(row);
    if (!t) continue;
    const key = `${t.minQty}:${t.maxQty}:${t.unitPrice}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  out.sort((a, b) => a.minQty - b.minQty || (a.maxQty ?? Infinity) - (b.maxQty ?? Infinity));
  return out;
}

/** Build a complete record from loosely-shaped extraction output. */
export function makeRecord(input = {}) {
  const priceTiers = normalizeTiers(input.priceTiers);
  const moqQty = toNum(input.moqQty);
  const yearsOnPlatform = toNum(input.yearsOnPlatform);

  const record = {
    schemaVersion: SCHEMA_VERSION,
    productId: str(input.productId) || str(input.sourceUrl),
    title: str(input.title),
    sourceUrl: str(input.sourceUrl),
    companyName: str(input.companyName),
    companyUrl: str(input.companyUrl),
    country: str(input.country),
    businessType: str(input.businessType),
    currency: str(input.currency) || 'USD',
    image: str(input.image),

    priceTiers,
    moqQty: moqQty !== null && moqQty >= 0 ? moqQty : null,
    moqUnit: str(input.moqUnit),
    yearsOnPlatform,
    verifiedSupplier: input.verifiedSupplier === true,
    tradeAssurance: input.tradeAssurance === true,
    responseRate: str(input.responseRate),
    onTimeDelivery: pct(input.onTimeDelivery),
    reorderRate: pct(input.reorderRate),
    onlineRevenue: str(input.onlineRevenue),
    leadTime: str(input.leadTime),

    /** Where this row came from: a product page, or a search results list. */
    origin: input.origin === 'search' ? 'search' : 'product',

    provenance: { ...input.provenance },
    missing: Array.isArray(input.missing) ? input.missing.slice() : [],
    confidence: input.confidence === 'low' ? 'low' : 'high',
    capturedAt: input.capturedAt || new Date().toISOString(),
    note: str(input.note),
  };

  // Re-derive missing list and confidence from the data we actually ended up with.
  const core = record.origin === 'search' ? SEARCH_CORE_FIELDS : CORE_FIELDS;
  record.missing = core.filter((f) => isEmpty(record[f]));
  if (record.missing.length > 0) record.confidence = 'low';
  if (record.provenance['__lowConfidence'] === 'true') record.confidence = 'low';

  return record;
}

function isEmpty(v) {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

export function isCoreComplete(record) {
  return CORE_FIELDS.every((f) => !isEmpty(record?.[f]));
}

/** Stable identity for de-duplication. */
export function recordKey(record) {
  return record.productId || record.sourceUrl || `${record.companyName}|${record.title}`;
}
