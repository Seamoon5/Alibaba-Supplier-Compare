/**
 * compare.test.js — the arithmetic the extension exists to do.
 *
 * These are the cases that produce a confidently wrong "winner" if they are
 * wrong, so each boundary is asserted explicitly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tierForQuantity, resolveSupplier, rank, effectiveMoq,
  isManufacturer, tierShape, formatPrice, round2,
} from '../src/lib/compare.js';
import { makeRecord } from '../src/lib/schema.js';
import { getExporter } from '../src/lib/exporters/index.js';

const supplier = (over = {}) =>
  makeRecord({
    productId: over.id || 'p1',
    title: 'Chenille embroidery machine',
    companyName: over.company || 'Supplier A',
    currency: over.currency || 'USD',
    moqQty: over.moq === undefined ? 1 : over.moq,
    moqUnit: over.moqUnit || 'set',
    yearsOnPlatform: over.years ?? 5,
    verifiedSupplier: over.verified ?? false,
    businessType: over.businessType || 'Manufacturer',
    priceTiers: over.tiers || [
      { minQty: 1, maxQty: 1, unitPrice: 5000 },
      { minQty: 2, maxQty: 4, unitPrice: 4800 },
      { minQty: 5, maxQty: null, unitPrice: 4500 },
    ],
    ...over,
  });

// ------------------------------------------------------------ tier selection

test('tierForQuantity picks the tier whose minQty is the highest match', () => {
  const tiers = [
    { minQty: 1, maxQty: 1, unitPrice: 5000 },
    { minQty: 2, maxQty: 4, unitPrice: 4800 },
    { minQty: 5, maxQty: null, unitPrice: 4500 },
  ];
  assert.equal(tierForQuantity(tiers, 1).unitPrice, 5000);
  assert.equal(tierForQuantity(tiers, 2).unitPrice, 4800);
  assert.equal(tierForQuantity(tiers, 4).unitPrice, 4800);
  assert.equal(tierForQuantity(tiers, 5).unitPrice, 4500);
});

test('tierForQuantity is correct exactly on a tier boundary', () => {
  const tiers = [
    { minQty: 2, maxQty: 99, unitPrice: 100 },
    { minQty: 100, maxQty: 999, unitPrice: 80 },
  ];
  assert.equal(tierForQuantity(tiers, 99).unitPrice, 100, 'last unit of the first tier');
  assert.equal(tierForQuantity(tiers, 100).unitPrice, 80, 'first unit of the second tier');
});

test('tierForQuantity handles overlapping tiers by taking the deepest discount', () => {
  // Some ladders are published with an overlap rather than a clean handoff.
  const tiers = [
    { minQty: 1, maxQty: 100, unitPrice: 100 },
    { minQty: 50, maxQty: 200, unitPrice: 90 },
  ];
  assert.equal(tierForQuantity(tiers, 60).unitPrice, 90);
});

test('tierForQuantity returns null below the lowest tier and above an array', () => {
  const tiers = [{ minQty: 10, maxQty: null, unitPrice: 5 }];
  assert.equal(tierForQuantity(tiers, 9), null);
  assert.equal(tierForQuantity(tiers, 1e6).unitPrice, 5, 'open ended top tier absorbs big orders');
  assert.equal(tierForQuantity([], 5), null);
  assert.equal(tierForQuantity(null, 5), null);
  assert.equal(tierForQuantity(tiers, NaN), null);
});

// ---------------------------------------------------------------- MOQ rules

test('effectiveMoq treats a missing or zero MOQ as 1', () => {
  assert.equal(effectiveMoq({ moqQty: 10 }), 10);
  assert.equal(effectiveMoq({ moqQty: 0 }), 1);
  assert.equal(effectiveMoq({ moqQty: null }), 1);
  assert.equal(effectiveMoq({}), 1);
  assert.equal(effectiveMoq({ moqQty: -5 }), 1);
});

test('a target below MOQ is flagged and priced at the MOQ instead', () => {
  const r = resolveSupplier(supplier({ moq: 5 }), 2);
  assert.equal(r.belowMoq, true);
  assert.equal(r.orderQty, 5, 'priced at the quantity that could actually be ordered');
  assert.equal(r.unitPrice, 4500);
  assert.equal(r.total, 22500);
  assert.equal(r.unitPriceAtMoq, 4500);
});

test('a target at or above MOQ is not flagged', () => {
  assert.equal(resolveSupplier(supplier({ moq: 5 }), 5).belowMoq, false);
  assert.equal(resolveSupplier(supplier({ moq: 5 }), 6).belowMoq, false);
});

test('a supplier with no price tiers reports a reason rather than a zero', () => {
  const r = resolveSupplier(supplier({ tiers: [] }), 1);
  assert.equal(r.ok, false);
  assert.equal(r.unitPrice, null);
  assert.equal(r.total, null);
  assert.equal(r.reason, 'no-price-tiers');
});

test('a quantity below the lowest published tier is explained, not guessed', () => {
  const r = resolveSupplier(supplier({ tiers: [{ minQty: 10, maxQty: null, unitPrice: 7 }], moq: 1 }), 2);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'quantity-below-lowest-tier');
});

// ------------------------------------------------------------------ ranking

test('rank orders by unit price, not by total spend', () => {
  const a = supplier({ id: 'a', company: 'A', tiers: [{ minQty: 1, maxQty: null, unitPrice: 100 }], moq: 1 });
  const b = supplier({ id: 'b', company: 'B', tiers: [{ minQty: 1, maxQty: null, unitPrice: 90 }], moq: 1 });
  const res = rank([a, b], 10);
  assert.equal(res.groups.length, 1);
  assert.equal(res.groups[0].rows[0].record.companyName, 'B', 'B is cheaper per unit');
  assert.equal(res.groups[0].bestKey, b.productId);
});

test('rank breaks a price tie in favour of the longer established supplier', () => {
  const a = supplier({ id: 'a', company: 'Young', years: 2, moq: 1 });
  const b = supplier({ id: 'b', company: 'Old', years: 14, moq: 1 });
  const res = rank([a, b], 1);
  assert.equal(res.groups[0].rows[0].record.companyName, 'Old');
});

test('rank never compares across currencies', () => {
  const usd = supplier({ id: 'a', company: 'US', currency: 'USD', moq: 1,
    tiers: [{ minQty: 1, maxQty: null, unitPrice: 100 }] });
  const eur = supplier({ id: 'b', company: 'EU', currency: 'EUR', moq: 1,
    tiers: [{ minQty: 1, maxQty: null, unitPrice: 90 }] });
  const res = rank([usd, eur], 1);
  assert.equal(res.groups.length, 2);
  assert.equal(res.multipleCurrencies, true);
  assert.deepEqual(res.groups.map((g) => g.currency), ['EUR', 'USD'],
    'with equal numbers of quotes the order is alphabetical');
  // The cheaper-looking EUR row must not be presented as beating the USD row.
  assert.equal(res.groups.find((g) => g.currency === 'EUR').bestKey, eur.productId);
});

test('the currency with the most quotes is ranked first', () => {
  // The panel reads left to right, so the common currency must lead.
  const list = [
    supplier({ id: 'a', company: 'US1', currency: 'USD', moq: 1,
      tiers: [{ minQty: 1, maxQty: null, unitPrice: 100 }] }),
    supplier({ id: 'b', company: 'US2', currency: 'USD', moq: 1,
      tiers: [{ minQty: 1, maxQty: null, unitPrice: 110 }] }),
    supplier({ id: 'c', company: 'EU', currency: 'EUR', moq: 1,
      tiers: [{ minQty: 1, maxQty: null, unitPrice: 90 }] }),
  ];
  const res = rank(list, 1);
  assert.deepEqual(res.groups.map((g) => g.currency), ['USD', 'EUR']);
  assert.equal(res.groups[0].rows.length, 2);
});

test('filters remove rows and are reported as removals, not as failures', () => {
  const list = [
    supplier({ id: 'a', company: 'Verified', verified: true, moq: 1 }),
    supplier({ id: 'b', company: 'Unverified', verified: false, moq: 1 }),
    supplier({ id: 'c', company: 'HighMOQ', moq: 50 }),
  ];
  assert.equal(rank(list, 1, { verifiedOnly: true }).totalShown, 1);
  assert.equal(rank(list, 1, { hideBelowMoq: true }).totalShown, 2);
  assert.equal(rank(list, 1, { verifiedOnly: true, hideBelowMoq: true }).totalShown, 1);
  assert.equal(rank(list, 1, {}).totalConsidered, 3);
});

test('manufacturersOnly keeps factories and drops trading companies', () => {
  assert.equal(isManufacturer('Manufacturer'), true);
  assert.equal(isManufacturer('Factory'), true);
  assert.equal(isManufacturer('Trading Co., Ltd.'), false);
  assert.equal(isManufacturer('Manufacturer'), true);
  assert.equal(isManufacturer('Hangzhou Trading Company'), false);
  assert.equal(isManufacturer('Factory & Trading Company'), true,
    'a hybrid is still a factory');
  assert.equal(isManufacturer(''), false);

  const list = [
    supplier({ id: 'a', company: 'Factory', businessType: 'Manufacturer', moq: 1 }),
    supplier({ id: 'b', company: 'Trader', businessType: 'Trading Co., Ltd.', moq: 1 }),
  ];
  const res = rank(list, 1, { manufacturersOnly: true });
  assert.equal(res.totalShown, 1);
  assert.equal(res.groups[0].rows[0].record.companyName, 'Factory');
});

test('hideLowConfidence drops records with a missing core field', () => {
  const good = supplier({ id: 'a', company: 'Good', moq: 1 });
  const bad = makeRecord({
    productId: 'b', companyName: 'Bad', currency: 'USD',
    priceTiers: [], moqQty: 1,
  });
  assert.equal(bad.confidence, 'low');
  const res = rank([good, bad], 1, { hideLowConfidence: true });
  assert.equal(res.totalShown, 1);
  assert.equal(res.groups[0].rows[0].record.companyName, 'Good');
});

// -------------------------------------------------------------- price shape

test('a supplier with no price is shown, not treated as filtered out', () => {
  // Regression: an unpriced supplier was lumped in with rows removed by user
  // filters, so the panel said "1 supplier is hidden by the current filters"
  // when no filter was on. On a supplier search an absent price is normal.
  const priced = supplier({ id: 'a', company: 'Priced', moq: 1 });
  const unpriced = makeRecord({
    productId: 'b', companyName: 'Unpriced', currency: 'USD',
    moqQty: 100, priceTiers: [],
  });

  const res = rank([priced, unpriced], 2);
  assert.equal(res.totalShown, 1, 'only the priced one is ranked');
  assert.equal(res.unpriced.length, 1, 'the unpriced one is reported separately');
  assert.equal(res.unpriced[0].record.companyName, 'Unpriced');
  assert.equal(res.filtered.length, 0, 'no filter was active, so nothing is "filtered"');
  assert.equal(res.unpriced[0].record.moqQty, 100, 'its MOQ is still available to show');
});

test('genuinely filtered rows are reported as filtered', () => {
  const list = [
    supplier({ id: 'a', company: 'Factory', businessType: 'Manufacturer', moq: 1 }),
    supplier({ id: 'b', company: 'Trader', businessType: 'Trading Co., Ltd.', moq: 1 }),
  ];
  const res = rank(list, 1, { manufacturersOnly: true });
  assert.equal(res.filtered.length, 1);
  assert.equal(res.filtered[0].record.companyName, 'Trader');
  assert.equal(res.unpriced.length, 0);
});

test('the exporter still lists unpriced suppliers', () => {
  // They must reach a spreadsheet: MOQ, years and credentials are the point of
  // a supplier comparison even when the page shows no price.
  const list = [supplier({ id: 'a', company: 'Priced', moq: 1 }),
    makeRecord({ productId: 'b', companyName: 'Unpriced', currency: 'USD', moqQty: 100, priceTiers: [] })];
  const out = getExporter('tsv').build(list, { targetQty: 2 });
  assert.ok(out.includes('Unpriced'));
  assert.equal(out.split('\n').length, 3);
});

test('tierShape normalises a ladder for plotting', () => {
  const shape = tierShape(
    [{ minQty: 1, maxQty: 9, unitPrice: 100 }, { minQty: 10, maxQty: null, unitPrice: 60 }],
    10,
  );
  assert.equal(shape.length, 2);
  assert.equal(shape[0].norm, 0, 'the 100 tier is the most expensive, so maps to 0');
  assert.equal(shape[1].norm, 1, 'the 60 tier is the cheapest, so maps to 1');
  assert.equal(shape[0].isTarget, false);
  assert.equal(shape[1].isTarget, true);
  assert.equal(shape[0].price, 100);
});

test('tierShape copes with a single tier and with an empty ladder', () => {
  const one = tierShape([{ minQty: 1, maxQty: null, unitPrice: 42 }], 1);
  assert.equal(one.length, 1);
  assert.equal(one[0].norm, 1, 'a single price is both cheapest and dearest');
  assert.deepEqual(tierShape([], 1), []);
  assert.deepEqual(tierShape(null, 1), []);
});

test('formatPrice keeps full precision for unit costs under one', () => {
  assert.equal(formatPrice(0.45, 'USD'), '0.4500 USD');
  assert.equal(formatPrice(12.5, 'USD'), '12.50 USD');
  assert.equal(formatPrice(4800, 'USD'), '4,800 USD');
  assert.equal(formatPrice(null, 'USD'), '—');
  assert.equal(formatPrice(Infinity, 'USD'), '—');
});

test('round2 removes float dust', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(4800.005), 4800.01);
  assert.equal(round2(NaN), null);
});
