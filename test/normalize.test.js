/**
 * normalize.test.js — field mapping across the four tiers.
 *
 * The tier 2 cases are the important ones: they simulate Alibaba renaming a
 * field, which is the failure mode that would otherwise silently produce an
 * empty supplier row.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize } from '../src/extract/normalize.js';
import { PROVENANCE } from '../src/lib/schema.js';

/** A blob in the shape the third-party sources document for 2026. */
const KNOWN_BLOB = {
  globalData: {
    product: { productId: '1601918386232', subject: '3 Head Chenille Embroidery Machine' },
  },
  componentsVO: {
    priceModule: {
      currencyCode: 'USD',
      formatPrice: 'US $4,500-5,200',
      productLadderPrices: [
        { min: 1, max: 1, price: '5200.00' },
        { min: 2, max: 4, price: '4850.00' },
        { min: 5, max: null, price: '4500.00' },
      ],
    },
    tradeModule: { moqNumber: '1', moqUnit: 'set', tradeAssurance: true },
    companyModule: {
      companyName: 'Hangzhou Richpeace Machinery Co., Ltd.',
      companyId: 'c-9912',
      companyUrl: 'richpeace.en.alibaba.com/company_profile.html',
      countryName: 'China',
      businessType: 'Manufacturer',
      year: 12,
      verifiedSupplier: true,
      responseRate: '95%',
    },
    shippingModule: { leadTime: [{ min: 1, max: null, days: 30 }] },
    imageModule: { images: ['https://sc04.alicdn.com/example.jpg'] },
  },
};

const harvestOf = (over = {}) => ({
  ok: true,
  url: 'https://www.alibaba.com/product-detail/_1601918386232.html',
  title: '3 Head Chenille Embroidery Machine',
  ld: [],
  dom: {
    title: '3 Head Chenille Embroidery Machine',
    image: 'https://sc04.alicdn.com/example.jpg',
    url: 'https://www.alibaba.com/product-detail/_1601918386232.html',
    companyName: '', companyUrl: '', text: '',
  },
  blob: null,
  keyPaths: [],
  ...over,
});

// ------------------------------------------------------------------- tier 1

test('tier 1 reads the documented componentsVO paths', () => {
  const { record } = normalize(harvestOf({ blob: KNOWN_BLOB }));

  assert.equal(record.productId, '1601918386232');
  assert.equal(record.title, '3 Head Chenille Embroidery Machine');
  assert.equal(record.companyName, 'Hangzhou Richpeace Machinery Co., Ltd.');
  assert.equal(record.country, 'China');
  assert.equal(record.businessType, 'Manufacturer');
  assert.equal(record.moqQty, 1);
  assert.equal(record.moqUnit, 'set');
  assert.equal(record.yearsOnPlatform, 12);
  assert.equal(record.verifiedSupplier, true);
  assert.equal(record.tradeAssurance, true);
  assert.equal(record.currency, 'USD');
  assert.equal(record.responseRate, '95%');
  assert.equal(record.confidence, 'high');
  assert.equal(record.missing.length, 0);

  assert.equal(record.provenance.title, PROVENANCE.TIER1);
  assert.equal(record.provenance.companyName, PROVENANCE.TIER1);
  assert.equal(record.provenance.priceTiers, PROVENANCE.TIER1);
});

test('tier 1 parses the full price ladder including the open ended top tier', () => {
  const { record } = normalize(harvestOf({ blob: KNOWN_BLOB }));
  assert.equal(record.priceTiers.length, 3);
  assert.deepEqual(record.priceTiers[0], { minQty: 1, maxQty: 1, unitPrice: 5200 });
  assert.deepEqual(record.priceTiers[2], { minQty: 5, maxQty: null, unitPrice: 4500 });
});

// ------------------------------------------------------------------- tier 2

test('tier 2 still finds every field after Alibaba renames the module', () => {
  // Same information, completely different structure and some renamed keys.
  const RENAMED = {
    data: {
      offer: {
        id: '1601918386232',
        name: '3 Head Chenille Embroidery Machine',
        pricing: {
          currencyCode: 'USD',
          priceTiers: [
            { minQuantity: 1, maxQuantity: 1, amount: 5200 },
            { minQuantity: 2, maxQuantity: 4, amount: 4850 },
            { minQuantity: 5, amount: 4500 },
          ],
        },
        minimumOrderQuantity: 1,
        quantityUnit: 'set',
        supplierName: 'Hangzhou Richpeace Machinery Co., Ltd.',
        supplierCountry: 'China',
        supplierType: 'Manufacturer',
        yearsOnAlibaba: 12,
        isVerified: true,
        hasTradeAssurance: true,
      },
    },
  };

  const { record, diagnostics } = normalize(harvestOf({ blob: RENAMED }));

  assert.equal(record.title, '3 Head Chenille Embroidery Machine');
  assert.equal(record.companyName, 'Hangzhou Richpeace Machinery Co., Ltd.');
  assert.equal(record.moqQty, 1);
  assert.equal(record.moqUnit, 'set');
  assert.equal(record.verifiedSupplier, true);
  assert.equal(record.tradeAssurance, true);
  assert.equal(record.yearsOnPlatform, 12);
  assert.equal(record.priceTiers.length, 3);
  assert.equal(record.priceTiers[0].unitPrice, 5200);
  assert.equal(record.confidence, 'high');

  assert.equal(record.provenance.title, PROVENANCE.TIER2, 'came from the fuzzy walk, not the known path');
  assert.equal(record.provenance.priceTiers, PROVENANCE.TIER2);
  assert.equal(diagnostics.tierCounts[PROVENANCE.TIER2] > 0, true);
});

test('tier 2 converts a join year into years on the platform', () => {
  const { record } = normalize(harvestOf({
    blob: { c: { companyName: 'X Ltd', joinYear: 2014 } },
  }));
  const expected = new Date().getFullYear() - 2014;
  assert.equal(record.yearsOnPlatform, expected);
  assert.equal(record.provenance.yearsOnPlatform, PROVENANCE.TIER2);
});

test('tier 2 refuses a garbage year rather than storing it', () => {
  const { record } = normalize(harvestOf({
    blob: { c: { companyName: 'X Ltd', year: 99999 } },
  }));
  assert.ok(!Number.isFinite(record.yearsOnPlatform) || record.yearsOnPlatform < 100);
});

test('a suggestion module full of other products does not hijack the price ladder', () => {
  // pc_less_recommend style sibling: a bigger array of unrelated offers.
  const POLLUTED = {
    componentsVO: { priceModule: KNOWN_BLOB.componentsVO.priceModule },
    pc_less_recommend: {
      items: Array.from({ length: 40 }, (_, i) => ({
        productId: `other-${i}`,
        min: 1, max: 5, price: String(100 + i),
      })),
    },
  };
  const { record } = normalize(harvestOf({ blob: POLLUTED }));
  assert.equal(record.priceTiers[0].unitPrice, 5200, 'known path wins over the bigger array');
});

// ------------------------------------------------------------------- tier 4

test('tier 4 recovers a product from page text when the blob is missing', () => {
  const { record } = normalize(harvestOf({
    blob: null,
    dom: {
      title: 'Chenille Embroidery Machine 3 Head',
      image: 'https://sc04.alicdn.com/x.jpg',
      url: 'https://www.alibaba.com/product-detail/_1601918386232.html',
      companyName: 'Ningbo Sunwing Co.',
      companyUrl: 'sunwing.en.alibaba.com/company_profile.html',
      text:
        'Min. Order: 2 Sets   |   12 yrs   |   Verified Supplier   |   Trade Assurance\n' +
        'US $4,500-5,200   Price',
    },
  }));

  assert.equal(record.moqQty, 2);
  assert.equal(record.moqUnit, 'sets');
  assert.equal(record.yearsOnPlatform, 12);
  assert.equal(record.verifiedSupplier, true);
  assert.equal(record.tradeAssurance, true);
  assert.equal(record.currency, 'USD');
  assert.equal(record.provenance.moqQty, PROVENANCE.TIER4);
  assert.equal(record.provenance.moqUnit, PROVENANCE.TIER4);
});

test('tier 4 derives years from a "since" line', () => {
  const { record } = normalize(harvestOf({
    blob: null,
    dom: { title: 'X', url: 'https://www.alibaba.com/product-detail/_1.html',
           companyName: '', companyUrl: '', image: '', text: 'Established 2009' },
  }));
  assert.equal(record.yearsOnPlatform, new Date().getFullYear() - 2009);
});

test('a price range with no ladder is stored as one flat tier, not a fake curve', () => {
  const { record } = normalize(harvestOf({
    blob: null,
    dom: { title: 'X', url: 'https://www.alibaba.com/product-detail/_1.html',
           companyName: 'Y', companyUrl: '', image: '', text: 'US $4,500-5,200' },
  }));
  assert.equal(record.priceTiers.length, 1);
  assert.equal(record.priceTiers[0].unitPrice, 4500, 'the floor, which is the real entry price');
  assert.equal(record.priceTiers[0].maxQty, null);
  assert.equal(record.provenance.priceTiers, PROVENANCE.TIER4);
});

// -------------------------------------------------------------- confidence

test('a record missing core fields is marked low confidence and lists them', () => {
  const { record } = normalize({});
  assert.equal(record.confidence, 'low');
  assert.ok(record.missing.includes('priceTiers'));
  assert.ok(record.missing.includes('moqQty'));
  assert.ok(record.missing.includes('companyName'));
  assert.ok(record.missing.includes('title'));
});

test('a boolean field missing at its known path falls through instead of becoming No', () => {
  // Regression: toBool() used to answer false for an absent value, so a
  // supplier with no componentsVO block at all was reported as "Verified: No"
  // and "Trade Assurance: No" on the strength of a field that was never read.
  const { record, diagnostics } = normalize(harvestOf({
    blob: { componentsVO: { companyModule: { companyName: 'Only The Name' } } },
  }));
  const prov = diagnostics.layers.filter((l) => l.field === 'verifiedSupplier');
  assert.equal(prov.length, 1, 'verifiedSupplier should still be an attempted field');
  assert.equal(prov[0].ok, false, 'and should be reported as not found');
  assert.equal(record.provenance.verifiedSupplier, PROVENANCE.MISSING);
});

test('a genuine boolean at a known path is read, and a "false" string stays false', () => {
  const on = normalize(harvestOf({
    blob: { componentsVO: { tradeModule: { moqNumber: '2', tradeAssurance: true } } },
  })).record;
  assert.equal(on.tradeAssurance, true);

  const off = normalize(harvestOf({
    blob: { componentsVO: { tradeModule: { moqNumber: '2', tradeAssurance: false } } },
  })).record;
  assert.equal(off.tradeAssurance, false);
  assert.equal(off.provenance.tradeAssurance, PROVENANCE.TIER1);
});

test('an empty harvest does not throw and does not invent a supplier', () => {
  const { record, diagnostics } = normalize({});
  assert.equal(record.companyName, '');
  assert.equal(record.priceTiers.length, 0);
  assert.equal(record.confidence, 'low');
  assert.equal(diagnostics.foundAnyBlob, false);
});

test('diagnostics list which layer answered every attempted field', () => {
  const { diagnostics } = normalize(harvestOf({ blob: KNOWN_BLOB }));
  assert.ok(diagnostics.layers.length > 0);
  for (const layer of diagnostics.layers) {
    assert.ok(Object.values(PROVENANCE).includes(layer.via), `unexpected provenance ${layer.via}`);
  }
  assert.equal(diagnostics.foundAnyBlob, true);
});
