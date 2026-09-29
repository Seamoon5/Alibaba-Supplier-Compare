/**
 * normalize.js — turn raw harvested material into a record, recording where
 * every field came from.
 *
 * Four tiers, tried in order per field, cheapest and most reliable first:
 *   1. KNOWN PATH  documented componentsVO / globalData locations
 *   2. FUZZY WALK  recursive key-pattern search of the same blob
 *   3. LD+JSON     schema.org block, if the page has one
 *   4. DOM         label scan of the rendered page text
 *
 * The fuzzy tier is what keeps this extension working after Alibaba renames a
 * field. The recorded provenance is what tells us which tier broke, instead of
 * us guessing during a bug report.
 */

import { PROVENANCE, makeRecord, normalizeTiers } from '../lib/schema.js';

// --------------------------------------------------------------- primitives

function getPath(root, dotted) {
  let node = root;
  for (const key of dotted.split('.')) {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) {
      node = node[0];
      if (node === null || node === undefined) return undefined;
    }
    node = node[key];
  }
  return node;
}

function toNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function toStr(v) {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/**
 * Loosely interpret whatever the page called "verified".
 *
 * Returns null for anything unrecognised. Returning false here would be a real
 * bug: a boolean field whose tier 1 path is simply absent must be reported as
 * "not found" so the walk can try tier 2, not as a confident "No".
 */
function toBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (typeof v === 'number') return v > 0;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^(true|yes|1)$/i.test(t)) return true;
    if (/^(false|no|0|null|none|)$/i.test(t)) return false;
    if (/(verified|assessed|premium|gold)/i.test(t)) return true;
  }
  return null;
}

/** Booleans are only accepted as booleans, so a stray string cannot become a No. */
const isBoolean = (v) => typeof v === 'boolean';

const CURRENCY_RE = /\b(USD|EUR|GBP|AUD|CAD|JPY|CNY|RMB|INR|SAR|AED|TRY|PLN)\b/i;
function detectCurrency(...sources) {
  for (const s of sources) {
    if (typeof s !== 'string' || !s) continue;
    const m = s.toUpperCase().match(CURRENCY_RE);
    if (m) return m[1] === 'RMB' ? 'CNY' : m[1];
  }
  for (const s of sources) {
    if (typeof s === 'string' && s.includes('$')) return 'USD';
    if (typeof s === 'string' && s.includes('€')) return 'EUR';
    if (typeof s === 'string' && s.includes('£')) return 'GBP';
  }
  return '';
}

// ------------------------------------------------------------ field specs

/**
 * Each spec drives tiers 1 and 2. `paths` are tried literally; `keys` are
 * regexes matched against every object key in the blob, breadth first.
 */
const SPECS = {
  productId: {
    paths: [
      'globalData.product.productId',
      'componentsVO.productModule.productId',
      'globalData.productId',
    ],
    keys: [/^product_?id$/i, /^offer_?id$/i],
    parse: toStr,
    validate: (v) => v.length > 3,
  },
  title: {
    paths: [
      'globalData.product.subject',
      'componentsVO.productModule.subject',
      'globalData.product.title',
    ],
    // `name` is generic, but the walker is breadth first, so a shallow product
    // name wins over a deep attribute called "Colour name".
    keys: [/^(subject|product_?title|title|name)$/i],
    parse: toStr,
    validate: (v) => v.length > 3,
  },
  companyName: {
    paths: [
      'componentsVO.companyModule.companyName',
      'globalData.company.companyName',
      'componentsVO.companyModule.company',
    ],
    keys: [/^company_?name$/i, /^company_?title$/i, /^supplier_?name$/i],
    parse: toStr,
    validate: (v) => v.length > 1 && !/^alibaba/i.test(v),
  },
  companyId: {
    paths: ['componentsVO.companyModule.companyId', 'globalData.company.companyId'],
    keys: [/^company_?id$/i],
    parse: toStr,
    validate: (v) => v.length > 2,
  },
  companyUrl: {
    paths: ['componentsVO.companyModule.companyUrl', 'globalData.company.companyUrl'],
    keys: [/^company_?url$/i, /^supplier_?url$/i],
    parse: toStr,
    validate: (v) => /company_profile|company\//.test(v),
  },
  country: {
    paths: ['componentsVO.companyModule.countryName', 'globalData.company.countryName'],
    keys: [/^country_?name$/i, /_?country$/i],
    parse: toStr,
    validate: (v) => v.length > 1 && v.length < 40,
  },
  businessType: {
    paths: ['componentsVO.companyModule.businessType', 'globalData.company.businessType'],
    keys: [/^(business|company|supplier)_?type$/i],
    parse: toStr,
    validate: (v) => v.length > 1 && v.length < 60,
  },
  yearsOnPlatform: {
    paths: ['componentsVO.companyModule.year', 'globalData.company.year'],
    keys: [
      /^years?$/i,
      /^company_?years?$/i,
      /^supplier_?years?$/i,
      /^join_?year$/i,
      /^years?on.*$/i,
      /^company_?age$/i,
      /^(?:years?_?)?(?:alibaba_?)?years?$/i,
    ],
    parse: (v) => {
      const n = toNum(v);
      if (n === null) return null;
      // A join year is a year, not a count of years.
      if (n > 1900 && n < 2100) {
        const age = new Date().getFullYear() - n;
        return age >= 0 && age < 100 ? age : null;
      }
      return n >= 0 && n < 100 ? n : null;
    },
    validate: (v) => Number.isFinite(v) && v >= 0 && v < 100,
  },
  verifiedSupplier: {
    paths: ['componentsVO.companyModule.verifiedSupplier', 'globalData.company.verifiedSupplier'],
    keys: [/^verified_?supplier$/i, /^is_?verified$/i, /^verified$/i, /^assessed_?supplier$/i],
    parse: toBool,
    validate: isBoolean,
  },
  tradeAssurance: {
    paths: ['componentsVO.tradeModule.tradeAssurance', 'globalData.trade.tradeAssurance'],
    keys: [/^trade_?assurance$/i, /^has_?trade_?assurance$/i],
    parse: toBool,
    validate: isBoolean,
  },
  responseRate: {
    paths: ['componentsVO.companyModule.responseRate', 'globalData.company.responseRate'],
    keys: [/^response_?rate$/i],
    parse: toStr,
    validate: (v) => v.length > 0 && v.length < 20,
  },
  leadTime: {
    paths: ['componentsVO.shippingModule.leadTime', 'globalData.shipping.leadTime'],
    keys: [/^lead_?time$/i],
    parse: (v) => {
      if (typeof v === 'string') return v.trim().slice(0, 40);
      if (Array.isArray(v)) {
        const d = v.map((x) => toNum(x?.days ?? x?.day ?? x)).find(Number.isFinite);
        return d === undefined ? '' : `${d} days`;
      }
      const n = toNum(v);
      return n === null ? '' : `${n} days`;
    },
    validate: (v) => typeof v === 'string' && v.length > 0,
  },
  moqQty: {
    paths: ['componentsVO.tradeModule.moqNumber', 'globalData.trade.moqNumber'],
    // Covers moq, moqNumber, moqQty, minOrder, min_order_qty, minimumOrderQuantity.
    keys: [
      /^moq_?(number|qty|quantity|amount|value)?$/i,
      /^min(imum)?_?order_?(qty|quantity|number|amount|value)?$/i,
      /^min(imum)?_?(qty|quantity)$/i,
    ],
    parse: toNum,
    validate: (v) => Number.isFinite(v) && v > 0,
  },
  moqUnit: {
    paths: ['componentsVO.tradeModule.moqUnit', 'globalData.trade.moqUnit'],
    keys: [/^moq_?unit$/i, /^quantity_?unit$/i, /^order_?unit$/i, /^unit$/i],
    parse: toStr,
    validate: (v) => v.length > 0 && v.length < 24,
  },
  currency: {
    paths: ['componentsVO.priceModule.currencyCode', 'globalData.trade.currencyCode'],
    keys: [/^currency_?code$/i, /^currency$/i],
    parse: (v) => toStr(v).toUpperCase().slice(0, 5),
    validate: (v) => /^[A-Z]{3}$/.test(v),
  },
  priceDisplay: {
    paths: ['componentsVO.priceModule.formatPrice', 'globalData.product.formatPrice'],
    keys: [/^format_?price$/i, /^price_?range$/i],
    parse: toStr,
    validate: (v) => v.length > 0,
  },
};
const QTY_KEYS = [/^min/i, /^max/i, /qty/i, /quantity/i, /start/i, /end/i, /count/i];
const PRICE_KEYS = [/price/i, /amount/i, /value/i, /cost/i];

function isTierLike(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  const hasQty = keys.some((k) => QTY_KEYS.some((re) => re.test(k)));
  const hasPrice = keys.some((k) => PRICE_KEYS.some((re) => re.test(k)));
  return hasQty && hasPrice;
}

/** Map an arbitrary ladder object onto our shape without assuming key names. */
function readTierRow(row) {
  if (!row || typeof row !== 'object') return null;
  const keys = Object.keys(row);
  let min = null;
  let max = null;
  let price = null;

  for (const k of keys) {
    const n = toNum(row[k]);
    if (n === null) continue;
    if (price === null && PRICE_KEYS.some((re) => re.test(k))) price = n;
    else if (min === null && /min|start|begin|from/i.test(k)) min = n;
    else if (max === null && /max|end|to/i.test(k)) max = n;
    else if (min === null && /qty|quantity|count|num/i.test(k)) min = n;
  }
  if (price === null || min === null) return null;
  if (max !== null && max < min) max = null;
  return { minQty: min, maxQty: max, unitPrice: price };
}

// ------------------------------------------------------------- fuzzy walker

/**
 * Breadth-first search for the shallowest object key matching any pattern.
 * BFS is deliberate: a key named `moq` at depth 2 is far more likely to be the
 * field we want than one at depth 7 inside an unrelated sub-module.
 */
function findByKeys(root, keyPatterns, { maxDepth = 10, test = null, limit = 20000 } = {}) {
  if (!root || typeof root !== 'object') return undefined;
  const queue = [[root, 0]];
  let visited = 0;

  while (queue.length) {
    const [node, depth] = queue.shift();
    if (!node || typeof node !== 'object' || depth > maxDepth) continue;
    if (++visited > limit) return undefined;

    if (Array.isArray(node)) {
      for (const item of node.slice(0, 300)) queue.push([item, depth + 1]);
      continue;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (keyPatterns.some((re) => re.test(key))) {
        if (!test || test(value)) return value;
      }
      if (value && typeof value === 'object') queue.push([value, depth + 1]);
    }
  }
  return undefined;
}

/** Breadth-first search for a price ladder array. */
function findTierArray(root, { maxDepth = 10, limit = 20000 } = {}) {
  if (!root || typeof root !== 'object') return undefined;
  const queue = [[root, 0]];
  let visited = 0;

  while (queue.length) {
    const [node, depth] = queue.shift();
    if (!node || typeof node !== 'object' || depth > maxDepth) continue;
    if (++visited > limit) return undefined;

    if (Array.isArray(node)) {
      const rows = node.slice(0, 30).filter(isTierLike);
      // Two convincing rows is enough; one row could be a price echo.
      if (rows.length >= 2) return rows;
      for (const item of node.slice(0, 300)) queue.push([item, depth + 1]);
      continue;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (key === '__lowConfidence') continue;
      if (Array.isArray(value) && value.slice(0, 30).filter(isTierLike).length >= 2) return value;
      if (value && typeof value === 'object') queue.push([value, depth + 1]);
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ tier 3

function readLd(ldArray) {
  const out = {};
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!out.title && typeof node.name === 'string' && node.name.length > 1) {
      if (!out['@type'] || String(node['@type']).match(/Product|Organization/i)) {
        out.title = out.title || node.name;
      }
    }
    if (!out.image) {
      const img = node.image;
      if (typeof img === 'string') out.image = img;
      else if (Array.isArray(img) && typeof img[0] === 'string') out.image = img[0];
      else if (img && typeof img === 'object' && typeof img.url === 'string') out.image = img.url;
    }
    if (!out.sku && node.sku) out.sku = String(node.sku);
    if (!out.mpn && node.mpn) out.mpn = String(node.mpn);
    if (!out.brand && typeof node.brand === 'string') out.brand = node.brand;
    Object.values(node).forEach(walk);
  };
  ldArray.forEach(walk);
  return out;
}

// ------------------------------------------------------------------ tier 4

const DOM_PATTERNS = {
  moqQty: {
    re: /(?:min(?:imum)?\.?\s*order|moq|min\.?\s*(?:order\s*)?quantity|min\.?\s*qty)\D{0,24}([\d][\d,\.]*)/i,
    parse: (m) => toNum(m[1]),
  },
  moqUnit: {
    re: /(?:min(?:imum)?\.?\s*order|moq)\D{0,24}[\d][\d,\.]*\s*([a-zA-Z]{2,12})/i,
    parse: (m) => m[1].toLowerCase(),
  },
  yearsOnPlatform: {
    re: /(\d{1,2})\s*\+?\s*(?:yrs?|years?)\b/i,
    parse: (m) => {
      const n = toNum(m[1]);
      return n !== null && n < 100 ? n : null;
    },
  },
  companySince: {
    re: /(?:since|established|since\s+establishment\s+of)\s*(\d{4})/i,
    parse: (m) => {
      const y = toNum(m[1]);
      if (y === null) return null;
      const age = new Date().getFullYear() - y;
      return age >= 0 && age < 100 ? age : null;
    },
  },
  // A published price range such as "US $4,500-5,200". Only used when no price
  // ladder was found, so it never overrides a real tier structure.
  priceDisplay: {
    re: /(?:US|EU|CA|AU)?\s*[$€£]\s?[\d][\d,]*(?:\.\d+)?(?:\s*[-–—]\s*[\d][\d,]*(?:\.\d+)?)?/,
    parse: (m) => m[0].trim(),
  },
};

// ------------------------------------------------------------------ normalise

/**
 * @param {object} harvest - result of harvestPage()
 * @returns {{record: object, diagnostics: object}}
 */
export function normalize(harvest = {}) {
  const provenance = {};
  const values = {};
  const diagnostics = { layers: [], blobName: harvest.blobName, blobVia: harvest.blobVia };

  const blob = harvest.blob || null;
  const dom = harvest.dom || {};
  const ldRaw = Array.isArray(harvest.ld) ? harvest.ld : [];
  const ld = ldRaw.length ? readLd(ldRaw) : {};

  // ---- tiers 1 + 2 for every scalar spec
  for (const [field, spec] of Object.entries(SPECS)) {
    let value;
    let via = null;

    // Tier 1 — known path
    if (blob) {
      for (const p of spec.paths || []) {
        const raw = getPath(blob, p);
        const parsed = spec.parse(raw);
        if (parsed !== undefined && parsed !== null && parsed !== '' && spec.validate(parsed)) {
          value = parsed;
          via = PROVENANCE.TIER1;
          break;
        }
      }
    }

    // Tier 2 — fuzzy walk
    if (value === undefined && blob && spec.keys?.length) {
      const raw = findByKeys(blob, spec.keys, { test: (v) => v !== null && v !== '' });
      const parsed = spec.parse(raw);
      if (parsed !== undefined && parsed !== null && parsed !== '' && spec.validate(parsed)) {
        value = parsed;
        via = PROVENANCE.TIER2;
      }
    }

    // Tier 3 — JSON-LD
    if (value === undefined && ld[field]) {
      value = ld[field];
      via = PROVENANCE.TIER3;
    }

    // Tier 4 — DOM
    if (value === undefined) {
      const pat = DOM_PATTERNS[field];
      if (pat && dom.text) {
        const m = dom.text.match(pat.re);
        const parsed = m ? pat.parse(m) : null;
        if (parsed !== null && parsed !== undefined && parsed !== '') {
          value = parsed;
          via = PROVENANCE.TIER4;
        }
      }
      if (value === undefined && field === 'yearsOnPlatform' && dom.text) {
        const m = dom.text.match(DOM_PATTERNS.companySince.re);
        const parsed = m ? DOM_PATTERNS.companySince.parse(m) : null;
        if (parsed !== null) {
          value = parsed;
          via = PROVENANCE.TIER4;
        }
      }
    }

    // Record provenance for every field we attempted, including the ones we
    // failed to read. Without this, "not published" and "published as No" are
    // indistinguishable downstream, and the panel would claim a supplier is
    // unverified when we simply never found the field.
    if (value !== undefined) {
      values[field] = value;
      provenance[field] = via || PROVENANCE.MISSING;
    } else {
      provenance[field] = PROVENANCE.MISSING;
    }
  }

  // ---- price ladder (special-cased: it is structured, not scalar)
  let priceTiers = [];
  let tiersVia = null;

  if (blob) {
    for (const p of [
      'componentsVO.priceModule.productLadderPrices',
      'globalData.product.productLadderPrices',
      'componentsVO.priceModule.ladderPrices',
    ]) {
      const raw = getPath(blob, p);
      const parsed = normalizeTiers(
        (Array.isArray(raw) ? raw : []).map((r) => ({
          minQty: r?.min ?? r?.minQty ?? r?.start,
          maxQty: r?.max ?? r?.maxQty ?? r?.end,
          unitPrice: r?.price ?? r?.unitPrice,
        })),
      );
      if (parsed.length) {
        priceTiers = parsed;
        tiersVia = PROVENANCE.TIER1;
        break;
      }
    }
  }
  if (!priceTiers.length && blob) {
    const raw = findTierArray(blob);
    if (raw) {
      const parsed = normalizeTiers(raw.map(readTierRow));
      if (parsed.length >= 2) {
        priceTiers = parsed;
        tiersVia = PROVENANCE.TIER2;
      }
    }
  }
  if (!priceTiers.length && values.priceDisplay) {
    // Last resort: a "US $1,234 - 5,678" style range, treated as one flat tier.
    const nums = String(values.priceDisplay).match(/[\d][\d,]*(?:\.\d+)?/g) || [];
    const parsed = nums.map((n) => toNum(n)).filter((n) => n !== null);
    if (parsed.length) {
      // A range like "1,234 - 5,678" is not a ladder, so we keep only the
      // floor as a single flat tier and the row shows 1 tier, not a fake curve.
      priceTiers = [{ minQty: 1, maxQty: null, unitPrice: Math.min(...parsed) }];
      tiersVia = PROVENANCE.TIER4;
    }
  }
  if (priceTiers.length) {
    values.priceTiers = priceTiers;
    provenance.priceTiers = tiersVia;
  } else {
    provenance.priceTiers = PROVENANCE.MISSING;
  }

  // ---- fallbacks that are not speculative field extraction
  if (!values.title) {
    const dTitle = dom.title || ld.title || '';
    if (dTitle) {
      values.title = dTitle;
      provenance.title = dom.title ? PROVENANCE.TIER4 : PROVENANCE.TIER3;
    }
  }
  if (!values.companyName && dom.companyName) {
    values.companyName = dom.companyName;
    provenance.companyName = PROVENANCE.TIER4;
  }
  if (!values.companyUrl && dom.companyUrl) {
    values.companyUrl = dom.companyUrl;
    provenance.companyUrl = PROVENANCE.TIER4;
  }
  if (!values.image && dom.image) {
    values.image = dom.image;
    provenance.image = PROVENANCE.TIER4;
  }
  if (!values.productId) {
    const m = (dom.url || harvest.url || '').match(/_(\d{6,})\.html/);
    if (m) {
      values.productId = m[1];
      provenance.productId = PROVENANCE.TIER4;
    }
  }
  if (!values.currency) {
    const cur = detectCurrency(values.priceDisplay, dom.text, dom.title);
    if (cur) {
      values.currency = cur;
      provenance.currency = PROVENANCE.TIER4;
    }
  }
  if (values.verifiedSupplier === undefined && dom.text) {
    values.verifiedSupplier = /(verified|assessed)\s+supplier/i.test(dom.text);
    provenance.verifiedSupplier = PROVENANCE.TIER4;
  }
  if (values.tradeAssurance === undefined && dom.text) {
    values.tradeAssurance = /trade\s*assurance/i.test(dom.text);
    provenance.tradeAssurance = PROVENANCE.TIER4;
  }

  // ---- diagnostics for the in-panel "why is this wrong" report
  for (const key of Object.keys(provenance)) {
    const v = values[key];
    diagnostics.layers.push({ field: key, via: provenance[key], ok: v !== undefined && v !== null });
  }
  const tierCounts = diagnostics.layers.reduce((acc, l) => {
    acc[l.via] = (acc[l.via] || 0) + 1;
    return acc;
  }, {});
  diagnostics.tierCounts = tierCounts;
  diagnostics.foundAnyBlob = Boolean(blob);
  diagnostics.sawLd = ldRaw.length > 0;
  diagnostics.keyPaths = harvest.keyPaths || [];
  diagnostics.blobTruncated = Boolean(harvest.blobTruncated);

  const record = makeRecord({
    ...values,
    sourceUrl: dom.url || harvest.url || '',
    provenance,
    capturedAt: new Date().toISOString(),
  });

  return { record, diagnostics };
}
