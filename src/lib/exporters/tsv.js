/**
 * exporters/tsv.js — machine-readable export.
 *
 * Tab-separated on purpose: pasting into any cell in Google Sheets (or Excel,
 * or Numbers) puts each value in its own cell with no import dialog and no
 * delimiter guessing.
 */

import { resolveSupplier } from '../compare.js';

/** True when a record publishes a range, i.e. the high end means something. */
const isHigher = (r) =>
  Number.isFinite(Number(r.priceTo)) &&
  Number(r.priceTo) > Number(r.priceTiers?.[0]?.unitPrice);

const isHigherOffer = (p) => Number.isFinite(Number(p.to)) && Number(p.to) > Number(p.from);

/**
 * Column order is the contract. Appending a column is backwards compatible;
 * renaming or reordering is not.
 *
 * v2.0 inserted the range and product-strip columns directly after the unit
 * price, because a supplier publishes "US$1,250-4,500" and a sheet that only
 * ever shows the low end quietly misquotes it.
 *
 * `get` receives (ctx, record) where ctx = { resolved, settings, targetQty }.
 */
const COLUMNS = [
  { label: 'Product', get: (c, r) => r.title },
  { label: 'Supplier', get: (c, r) => r.companyName },
  { label: 'Country', get: (c, r) => r.country },
  { label: 'Business type', get: (c, r) => r.businessType },
  { label: 'Currency', get: (c, r) => r.currency },
  { label: 'Unit price at Qty', get: (c) => c.unitPrice ?? '' },
  { label: 'Unit price up to', get: (c, r) => (c.unitPrice !== null && isHigher(r) ? r.priceTo : '') },
  { label: 'Target qty', get: (c, r) => c.targetQty ?? '' },
  { label: 'Order qty used', get: (c) => c.orderQty ?? '' },
  { label: 'Total', get: (c) => c.total ?? '' },
  { label: 'Products listed', get: (_c, r) => (Array.isArray(r.products) ? r.products.length : 0) },
  {
    label: 'Other products',
    get: (_c, r) =>
      (Array.isArray(r.products) ? r.products.slice(1) : [])
        .map((p) => `${p.title} ${p.from}${isHigherOffer(p) ? '-' + p.to : ''}`)
        .join(' | '),
  },
  { label: 'MOQ', get: (c, r) => r.moqQty ?? '' },
  { label: 'MOQ unit', get: (c, r) => r.moqUnit },
  { label: 'Below MOQ at target', get: (c) => (c.belowMoq ? 'YES' : 'no') },
  { label: 'Price tiers', get: (c, r) => r.priceTiers.length },
  { label: 'Lowest unit price', get: (c, r) => r.priceTiers[0]?.unitPrice ?? '' },
  { label: 'Lowest price from qty', get: (c, r) => r.priceTiers[0]?.minQty ?? '' },
  { label: 'Years on Alibaba', get: (c, r) => r.yearsOnPlatform ?? '' },
  { label: 'Verified supplier', get: (c, r) => (r.verifiedSupplier ? 'YES' : 'no') },
  { label: 'Trade Assurance', get: (c, r) => (r.tradeAssurance ? 'YES' : 'no') },
  { label: 'Response rate', get: (c, r) => r.responseRate },
  { label: 'Lead time', get: (c, r) => r.leadTime },
  { label: 'Data confidence', get: (c, r) => r.confidence },
  { label: 'Missing fields', get: (c, r) => r.missing.join(', ') },
  { label: 'Product URL', get: (c, r) => r.sourceUrl },
  { label: 'Supplier URL', get: (c, r) => r.companyUrl },
  { label: 'Captured at', get: (c, r) => r.capturedAt },
];

function buildContext(records, settings = {}) {
  const targetQty = settings.targetQty ?? 1;
  const resolved = new Map();
  for (const record of records) {
    resolved.set(record, { ...resolveSupplier(record, targetQty), targetQty });
  }
  return { settings, targetQty, resolved };
}

/** Tabs and newlines inside a cell would break the row/column structure. */
const flatten = (v) =>
  v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' ').trim();

export const tsv = {
  id: 'tsv',
  label: 'Copy for Sheets',
  description: 'Tab separated, one row per supplier. Paste straight into a cell.',
  mime: 'text/tab-separated-values',
  extension: 'tsv',
  build(records, settings) {
    const ctx = buildContext(records, settings);
    const lines = [COLUMNS.map((col) => flatten(col.label)).join('\t')];
    for (const record of records) {
      const c = ctx.resolved.get(record);
      lines.push(COLUMNS.map((col) => flatten(col.get(c, record))).join('\t'));
    }
    return lines.join('\n');
  },
};

/** Same data, comma separated, RFC 4180 quoting. */
export const csv = {
  id: 'csv',
  label: 'Download CSV',
  description: 'Comma separated, for emailing or importing into Excel.',
  mime: 'text/csv',
  extension: 'csv',
  build(records, settings) {
    const ctx = buildContext(records, settings);
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [COLUMNS.map((col) => esc(col.label)).join(',')];
    for (const record of records) {
      const c = ctx.resolved.get(record);
      lines.push(COLUMNS.map((col) => esc(col.get(c, record))).join(','));
    }
    return lines.join('\r\n');
  },
};

export { COLUMNS as TSV_COLUMNS };
