/**
 * compare.js — the arithmetic the extension exists to perform.
 *
 * Given a set of saved supplier records and a target quantity, resolve each
 * supplier to an effective unit price, flag MOQ problems, and rank them.
 *
 * Every function here is pure and free of `chrome.*` so it can be unit tested.
 */

import { recordKey } from './schema.js';

/**
 * Find the price tier that applies to `qty`.
 *
 * Selection rule: among tiers whose minQty <= qty, take the one with the
 * largest minQty. This is deliberately NOT "the tier where min <= qty <= max",
 * because Alibaba ladders sometimes leave gaps or overlap at the boundary
 * (e.g. {2..99} and {100..999} presented as inclusive-exclusive). Choosing
 * the highest matching minQty is the only rule that is correct at every
 * boundary, including when the top tier has no upper bound.
 *
 * @returns {{minQty:number,maxQty:number|null,unitPrice:number}|null}
 */
export function tierForQuantity(tiers, qty) {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  if (!Number.isFinite(qty)) return null;

  const eligible = tiers.filter(
    (t) => Number.isFinite(t?.minQty) && Number.isFinite(t?.unitPrice) && t.minQty <= qty,
  );
  if (eligible.length === 0) return null;

  return eligible.reduce((best, t) => (t.minQty > best.minQty ? t : best));
}

/**
 * Effective orderable quantity for a record at the requested quantity.
 * A supplier with no published MOQ is treated as accepting 1 unit.
 */
export function effectiveMoq(record) {
  const moq = Number(record?.moqQty);
  if (!Number.isFinite(moq) || moq <= 0) return 1;
  return moq;
}

/**
 * Resolve one supplier against a target quantity.
 *
 * @returns {{
 *   key:string, record:object, ok:boolean, unitPrice:number|null,
 *   total:number|null, belowMoq:boolean, orderQty:number,
 *   unitPriceAtMoq:number|null, atLowestTier:boolean, reason:string|null
 * }}
 */
export function resolveSupplier(record, targetQty) {
  const key = recordKey(record);
  const moq = effectiveMoq(record);
  const qty = Number.isFinite(targetQty) && targetQty > 0 ? targetQty : moq;
  const belowMoq = qty < moq;

  // Price the order at the requested quantity, or at the MOQ when the request
  // is under it, so the number shown is always one you could actually order.
  const orderQty = belowMoq ? moq : qty;
  const tier = tierForQuantity(record.priceTiers, orderQty);
  const firstTier = Array.isArray(record.priceTiers) && record.priceTiers.length
    ? record.priceTiers[0]
    : null;

  const unitPrice = tier ? tier.unitPrice : null;
  const moqTier = tierForQuantity(record.priceTiers, moq);

  let reason = null;
  if (!Array.isArray(record.priceTiers) || record.priceTiers.length === 0) {
    reason = 'no-price-tiers';
  } else if (!tier) {
    reason = 'quantity-below-lowest-tier';
  }

  return {
    key,
    record,
    ok: unitPrice !== null,
    unitPrice,
    total: unitPrice === null ? null : round2(unitPrice * orderQty),
    belowMoq,
    orderQty,
    // Reference price if the buyer raised the order up to the MOQ instead.
    unitPriceAtMoq: moqTier ? moqTier.unitPrice : (firstTier ? firstTier.unitPrice : null),
    atLowestTier: Boolean(tier && firstTier && tier.minQty === firstTier.minQty),
    reason,
    currency: record.currency || 'USD',
  };
}

/** Group resolved suppliers by currency and rank each group by unit price. */
export function rank(records, targetQty, filters = {}) {
  const {
    hideBelowMoq = false,
    verifiedOnly = false,
    manufacturersOnly = false,
    hideLowConfidence = false,
  } = filters;

  const resolved = records.map((r) => resolveSupplier(r, targetQty));

  // Three outcomes, kept distinct. A supplier with no published price is a
  // normal thing to find on a supplier search, and lumping it in with "hidden
  // by your filters" both hides useful rows and tells the user a lie.
  const unpriced = [];
  const filtered = [];

  const kept = [];
  for (const r of resolved) {
    if (!r.ok) {
      unpriced.push(r);
      continue;
    }
    if ((hideBelowMoq && r.belowMoq) ||
        (verifiedOnly && r.record.verifiedSupplier !== true) ||
        (manufacturersOnly && !isManufacturer(r.record.businessType)) ||
        (hideLowConfidence && r.record.confidence === 'low')) {
      filtered.push(r);
      continue;
    }
    kept.push(r);
  }

  const byCurrency = new Map();
  for (const r of kept) {
    const cur = r.currency || 'USD';
    if (!byCurrency.has(cur)) byCurrency.set(cur, []);
    byCurrency.get(cur).push(r);
  }

  // Rank within a currency. Cross-currency comparison would need a live rate
  // source; showing one would risk a confidently wrong "winner".
  //
  // Groups are ordered by how many suppliers they contain, not alphabetically.
  // The panel reads left to right, so the currency the user is most likely
  // looking at (usually the one with the most quotes) must come first.
  const groups = [...byCurrency.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([currency, rows]) => {
      const sorted = rows.slice().sort((a, b) => {
        const p = a.unitPrice - b.unitPrice;
        if (Math.abs(p) > 1e-9) return p;
        // Tie: prefer the longer-established supplier.
        return (b.record.yearsOnPlatform ?? -1) - (a.record.yearsOnPlatform ?? -1);
      });
      return {
        currency,
        rows: sorted,
        bestKey: sorted.length ? sorted[0].key : null,
        bestTotal: sorted.length ? sorted[0].total : null,
      };
    });

  return {
    groups,
    multipleCurrencies: groups.length > 1,
    totalConsidered: resolved.length,
    totalShown: kept.length,
    unpriced,
    filtered,
  };
}

const MANUFACTURER_RE = /manufactur|factory|producer|plant|制造|工厂|生产商/i;
const TRADING_RE = /trading|co\.?,?\s*ltd|commerce|import|export|agent|wholesale|贸易|有限/i;

export function isManufacturer(businessType) {
  const s = String(businessType || '');
  if (!s) return false;
  if (TRADING_RE.test(s) && !MANUFACTURER_RE.test(s)) return false;
  return MANUFACTURER_RE.test(s);
}

/**
 * Compact representation of a price ladder for the panel's sparkline.
 * Returns a list of points normalised to 0..1 for plotting.
 */
export function tierShape(tiers, targetQty) {
  if (!Array.isArray(tiers) || tiers.length === 0) return [];
  const prices = tiers.map((t) => t.unitPrice).filter(Number.isFinite);
  if (prices.length === 0) return [];
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = hi - lo || 1;
  return tiers
    .filter((t) => Number.isFinite(t.minQty) && Number.isFinite(t.unitPrice))
    .map((t) => ({
      minQty: t.minQty,
      maxQty: t.maxQty ?? null,
      price: t.unitPrice,
      norm: 1 - (t.unitPrice - lo) / span, // 1 = cheapest
      isTarget: Number.isFinite(targetQty) && t.minQty <= targetQty &&
        (t.maxQty === null || targetQty <= t.maxQty),
    }));
}

/** Round to 2dp without float dust. */
export function round2(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Format a price for display, keeping it compact for a narrow panel. */
export function formatPrice(value, currency) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
  const body = n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return currency ? `${body} ${currency}` : body;
}
