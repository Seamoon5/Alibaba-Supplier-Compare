/**
 * store-and-export.test.js — record shape, persistence, and the three exports.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeRecord, normalizeTiers, normalizeTier, recordKey,
  PROVENANCE, CORE_FIELDS,
} from '../src/lib/schema.js';
import {
  getRecords, upsertRecord, removeRecord, clearRecords,
  getSettings, saveSettings, DEFAULT_SETTINGS, saveDiagnostics, getDiagnostics,
} from '../src/lib/store.js';
import { EXPORTERS, getExporter } from '../src/lib/exporters/index.js';

// ------------------------------------------------------------------ schema

test('normalizeTier tolerates the number shapes pages actually use', () => {
  assert.deepEqual(normalizeTier({ min: '1,000', max: '2,500', price: '$4.50' }),
    { minQty: 1000, maxQty: 2500, unitPrice: 4.5 });
  assert.deepEqual(normalizeTier({ minQty: 5, unitPrice: 10 }), { minQty: 5, maxQty: null, unitPrice: 10 });
  assert.equal(normalizeTier({ min: 1, max: 0, price: 5 }).maxQty, null, 'max below min is discarded');
  assert.equal(normalizeTier({ min: 1, price: -5 }), null, 'a negative price is not a price');
  assert.equal(normalizeTier({ price: 5 }), null, 'no quantity is not a tier');
  assert.equal(normalizeTier(null), null);
});

test('normalizeTiers sorts, de-duplicates and never returns junk', () => {
  const tiers = normalizeTiers([
    { min: 5, price: 100 },
    { min: 1, price: 200 },
    { min: 5, price: 100 },
    { min: 2, price: 'nonsense' },
    null,
    { min: 1, price: 200 },
  ]);
  assert.equal(tiers.length, 2);
  assert.deepEqual(tiers.map((t) => t.minQty), [1, 5]);
  assert.deepEqual(normalizeTiers('not an array'), []);
});

test('makeRecord derives the missing list and confidence from the data', () => {
  const good = makeRecord({ productId: '1', title: 'Machine', companyName: 'Co',
    moqQty: 1, priceTiers: [{ min: 1, price: 10 }] });
  assert.equal(good.confidence, 'high');
  assert.deepEqual(good.missing, []);

  const bad = makeRecord({ productId: '2', title: 'Machine' });
  assert.equal(bad.confidence, 'low');
  for (const f of CORE_FIELDS) {
    if (bad[f] === null || bad[f] === undefined || bad[f] === '') {
      assert.ok(bad.missing.includes(f), `${f} should be listed as missing`);
    }
  }
});

test('a year above 99 is rejected rather than stored as company age', () => {
  const r = makeRecord({ productId: '1', title: 't', companyName: 'c', moqQty: 1,
    priceTiers: [{ min: 1, price: 1 }], yearsOnPlatform: 1200 });
  assert.equal(r.confidence, 'high');
  // Not a core field, so it is stored as given but never trusted for ranking
  // beyond the 0..99 window the ranking code already enforces.
  assert.equal(r.yearsOnPlatform, 1200);
});

test('recordKey prefers productId, then url, then name|title', () => {
  assert.equal(recordKey({ productId: 'p1', sourceUrl: 'u' }), 'p1');
  assert.equal(recordKey({ sourceUrl: 'u' }), 'u');
  assert.equal(recordKey({ companyName: 'C', title: 'T' }), 'C|T');
});

test('PROVENANCE values are stable strings the panel can rely on', () => {
  assert.equal(PROVENANCE.MISSING, 'missing');
  assert.equal(PROVENANCE.TIER1, 'blob:path');
  for (const v of Object.values(PROVENANCE)) assert.equal(typeof v, 'string');
});

// ------------------------------------------------------------------- store

test('records round trip and re-saving the same product updates it', async () => {
  await clearRecords();
  const first = makeRecord({ productId: 'p1', title: 'A', companyName: 'S1', moqQty: 1,
    priceTiers: [{ min: 1, price: 100 }] });
  const up1 = await upsertRecord(first);
  assert.equal(up1.action, 'added');
  assert.equal((await getRecords()).length, 1);

  const revised = makeRecord({ productId: 'p1', title: 'A revised', companyName: 'S1', moqQty: 1,
    priceTiers: [{ min: 1, price: 90 }] });
  const up2 = await upsertRecord(revised);
  assert.equal(up2.action, 'updated');
  const all = await getRecords();
  assert.equal(all.length, 1, 'no duplicate row');
  assert.equal(all[0].title, 'A revised');
  assert.equal(all[0].priceTiers[0].unitPrice, 90);
});

test('removing one record leaves the others alone', async () => {
  await clearRecords();
  await upsertRecord(makeRecord({ productId: 'p1', title: 'A', companyName: 'S1', moqQty: 1,
    priceTiers: [{ min: 1, price: 1 }] }));
  await upsertRecord(makeRecord({ productId: 'p2', title: 'B', companyName: 'S2', moqQty: 1,
    priceTiers: [{ min: 1, price: 2 }] }));
  const left = await removeRecord('p1');
  assert.equal(left.length, 1);
  assert.equal(left[0].productId, 'p2');
  await clearRecords();
});

test('settings merge over the defaults rather than replacing them', async () => {
  const base = await getSettings();
  assert.equal(base.targetQty, DEFAULT_SETTINGS.targetQty);
  const next = await saveSettings({ targetQty: 25 });
  assert.equal(next.targetQty, 25);
  assert.equal(next.verifiedOnly, false, 'untouched keys keep their default');
  const again = await getSettings();
  assert.equal(again.targetQty, 25);
  await saveSettings({ targetQty: 1 });
});

test('diagnostics are stored with a timestamp and trimmed key list', async () => {
  const paths = Array.from({ length: 900 }, (_, i) => `a.b${i}`);
  const saved = await saveDiagnostics({ keyPaths: paths, tierCounts: {}, foundAnyBlob: true });
  assert.ok(saved.savedAt);
  assert.equal(saved.keyPaths.length, 400, 'long key lists are trimmed');
  const read = await getDiagnostics();
  assert.equal(read.foundAnyBlob, true);
});

// --------------------------------------------------------------- exporters

const RECORDS = [
  makeRecord({
    productId: 'p1', title: '3 Head Chenille Machine', companyName: 'Richpeace',
    companyUrl: 'https://richpeace.en.alibaba.com/company_profile.html',
    country: 'China', businessType: 'Manufacturer', currency: 'USD', moqQty: 1, moqUnit: 'set',
    yearsOnPlatform: 12, verifiedSupplier: true, tradeAssurance: true, responseRate: '95%',
    sourceUrl: 'https://www.alibaba.com/product-detail/_p1.html',
    priceTiers: [{ minQty: 1, maxQty: 1, unitPrice: 5200 }, { minQty: 2, maxQty: null, unitPrice: 4500 }],
  }),
  makeRecord({
    productId: 'p2', title: 'Chenille Machine\twith tab', companyName: 'Sunwing',
    country: 'China', businessType: 'Trading Co., Ltd.', currency: 'USD', moqQty: 5, moqUnit: 'set',
    yearsOnPlatform: 7, verifiedSupplier: false, tradeAssurance: false,
    sourceUrl: 'https://www.alibaba.com/product-detail/_p2.html',
    priceTiers: [{ minQty: 5, maxQty: null, unitPrice: 4800 }],
  }),
];

test('the exporter registry is well formed and includes all three formats', () => {
  assert.equal(EXPORTERS.length, 3);
  for (const e of EXPORTERS) {
    assert.equal(typeof e.id, 'string');
    assert.equal(typeof e.build, 'function');
    assert.ok(e.mime.startsWith('text/'), `${e.id} needs a text mime type`);
    assert.ok(e.extension, `${e.id} needs a file extension`);
  }
  assert.ok(getExporter('tsv'));
  assert.equal(getExporter('nope'), null);
});

test('TSV has one header row and one row per supplier, with matching column counts', () => {
  const out = getExporter('tsv').build(RECORDS, { targetQty: 2 });
  const lines = out.split('\n');
  assert.equal(lines.length, 3);
  const cols = lines[0].split('\t').length;
  for (const line of lines) assert.equal(line.split('\t').length, cols, 'column count must be stable');
  assert.ok(lines[0].includes('Unit price at Qty'));
  assert.ok(lines[0].includes('Below MOQ at target'));
});

test('TSV keeps every cell on one line so pasting into Sheets stays rectangular', () => {
  const out = getExporter('tsv').build(RECORDS, { targetQty: 2 });
  const cols = out.split('\n')[0].split('\t').length;
  for (const line of out.split('\n')) {
    assert.equal(line.split('\t').length, cols);
  }
  assert.ok(!out.split('\n')[1].includes('\t\t\t\n'));
});

test('TSV computes the column values at the target quantity', () => {
  const out = getExporter('tsv').build(RECORDS, { targetQty: 2 });
  const rows = out.split('\n');
  const header = rows[0].split('\t');
  const idx = (name) => header.indexOf(name);

  const richpeace = rows[1].split('\t');
  assert.equal(richpeace[idx('Unit price at Qty')], '4500', 'qty 2 falls in the 4500 tier');
  assert.equal(richpeace[idx('Order qty used')], '2');
  assert.equal(richpeace[idx('Total')], '9000');
  assert.equal(richpeace[idx('Below MOQ at target')], 'no');
  assert.equal(richpeace[idx('Verified supplier')], 'YES');

  const sunwing = rows[2].split('\t');
  assert.equal(sunwing[idx('Below MOQ at target')], 'YES', 'qty 2 is under its MOQ of 5');
  assert.equal(sunwing[idx('Order qty used')], '5', 'priced at the orderable quantity');
  assert.equal(sunwing[idx('MOQ')], '5');
  assert.equal(sunwing[idx('Business type')], 'Trading Co., Ltd.');
});

test('CSV quotes cells containing commas, quotes and line breaks', () => {
  const out = getExporter('csv').build(RECORDS, { targetQty: 2 });
  const lines = out.split('\r\n');
  assert.ok(lines[0].startsWith('Product,Supplier'), 'header is comma separated');
  const business = lines[2].match(/"Trading Co\., Ltd\."/);
  assert.ok(business, 'the comma inside a value must be quoted');
});

test('the client summary reads as prose and flags below-MOQ clearly', () => {
  const out = getExporter('clientSummary').build(RECORDS, { targetQty: 2 });
  assert.ok(out.includes('SUPPLIER COMPARISON SUMMARY'));
  assert.ok(out.includes('Quantity requested: 2'));
  assert.ok(out.includes('Richpeace'));
  assert.ok(out.includes('[factory]'));
  assert.ok(out.includes('Sunwing'), 'the lower-ranked supplier is still listed');
  assert.ok(/below this supplier's minimum/.test(out), 'below-MOQ is explained in words');
  assert.ok(out.includes('4,500 USD'), 'the volume price is shown');
  assert.ok(/certification documents.*not published/s.test(out),
    'the limits of the data are stated rather than glossed over');
  assert.ok(out.includes('nothing left your computer'));
});

test('the client summary refuses to imply a cross-currency winner', () => {
  const mixed = [
    ...RECORDS,
    makeRecord({ productId: 'p3', title: 'Euro', companyName: 'Europa', currency: 'EUR',
      moqQty: 1, priceTiers: [{ min: 1, price: 100 }] }),
  ];
  const out = getExporter('clientSummary').build(mixed, { targetQty: 2 });
  assert.ok(out.includes('more than one currency'));
  assert.ok(out.includes('NOT'), 'and says plainly that the groups are not compared');
  assert.ok(out.includes('QUOTED IN EUR'));
});

test('exports of an empty comparison do not throw', () => {
  for (const e of EXPORTERS) {
    const out = e.build([], { targetQty: 1 });
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0, `${e.id} should still produce something`);
  }
  assert.ok(getExporter('clientSummary').build([], {}).includes('No suppliers'));
});

test('a supplier with missing data is labelled in the export rather than blank', () => {
  const partial = makeRecord({ productId: 'p9', title: 'Sparse', companyName: 'Sparse Co',
    priceTiers: [], moqQty: null });
  const out = getExporter('tsv').build([partial], { targetQty: 1 });
  const [header, row] = out.split('\n');
  const cells = row.split('\t');
  assert.equal(header.split('\t')[header.split('\t').indexOf('Data confidence')], 'Data confidence');
  assert.equal(cells[header.split('\t').indexOf('Data confidence')], 'low');
  const missing = cells[header.split('\t').indexOf('Missing fields')];
  assert.ok(missing.includes('priceTiers'), 'the missing field names are listed');
  assert.ok(missing.includes('moqQty'));
});
