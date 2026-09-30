/**
 * capture.test.js — the path the toolbar button actually runs, end to end.
 *
 * This file exists because of a specific bug: the search capture path called a
 * function it had never imported. Every other test passed, the gate was green,
 * the extension loaded cleanly — and pressing the button threw
 * "assessCapture is not defined".
 *
 * The gap was not a bad test. It was a missing test: the extractor, the store,
 * the health module and the exporters were each covered, and the code that
 * connected them was not covered by anything. So it is covered now, in one
 * place, with the real committed capture.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSearchCapture, healthMessage } from '../src/lib/capture.js';
import { resolveSupplier, rank } from '../src/lib/compare.js';
import { getExporter } from '../src/lib/exporters/index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const capture = JSON.parse(readFileSync(join(root, 'docs', 'fixtures', 'real-capture-sample.json'), 'utf8'));

test('every function the capture path uses is actually imported, not assumed', async () => {
  // The cheapest possible guard against the bug that started this file: a
  // capture that must produce records and a verdict cannot run at all if a
  // symbol is missing, so calling it is the test.
  const result = buildSearchCapture(capture);
  assert.ok(result.records.length > 0, 'no records — the pipeline cannot work');
  assert.ok(result.health, 'no verdict — a capture would ship without being judged');
  assert.equal(typeof result.health.verdict, 'string');
});

test('a real harvest becomes saved records with provenance and a verdict', () => {
  const { ok, records, health, summary, evidence } = buildSearchCapture(capture);
  assert.equal(ok, true);
  assert.equal(health.verdict, 'ok');
  assert.equal(health.ok, true);
  assert.match(summary, /^OK /);
  assert.equal(evidence.strategy, 'data-supplier-card');
  assert.ok(evidence.cardSamples.length > 0, 'evidence must carry the markup a repair needs');

  for (const r of records) {
    assert.equal(r.origin, 'search');
    assert.equal(r.provenance.__source, 'search-cards');
    assert.ok(r.companyName);
    assert.ok(Array.isArray(r.priceTiers));
  }
});

test('an empty harvest is reported, not saved as success', () => {
  const { ok, records, health } = buildSearchCapture({ candidates: [] });
  assert.equal(ok, false);
  assert.equal(records.length, 0);
  assert.equal(health.verdict, 'empty');
  assert.ok(healthMessage(health), 'an empty capture must say something to the user');
});

test('a harvest with nothing usable in it does not reach the store', () => {
  // Cards were found but every one is unusable: this used to save rows that
  // then rendered as a full table of nonsense.
  const { records, health } = buildSearchCapture({
    candidates: [{ companyName: '', title: '' }, { companyName: 'US$5,000', title: 'US$1.70-2.20' }],
    strategy: 'price-tier-box',
  });
  assert.equal(records.length, 1, 'a row with only a price-shaped title is dropped');
  assert.equal(health.verdict, 'broken');
  const msg = healthMessage(health);
  assert.equal(msg.tone, 'error');
  assert.match(msg.body, /Copy page structure/);
});

test('the garbage capture from v1.0 is refused with a reason', () => {
  const junk = JSON.parse(readFileSync(join(root, 'docs', 'fixtures', 'broken-capture-v1.json'), 'utf8'));
  const { health } = buildSearchCapture(junk);
  assert.equal(health.ok, false);
  assert.match(health.reason, /supplier name/);
  assert.ok(healthMessage(health), 'and the user is told how to report it');
});

test('a missing or malformed harvest does not throw', () => {
  for (const bad of [undefined, null, {}, { candidates: null }, { candidates: [null, 3] }]) {
    const { ok, records } = buildSearchCapture(bad);
    assert.equal(ok, false, JSON.stringify(bad));
    assert.equal(records.length, 0);
  }
});

test('a good capture produces a message-free response', () => {
  const { health } = buildSearchCapture(capture);
  assert.equal(healthMessage(health), null, 'a clean capture needs no explanation');
});

test('the full chain runs: capture to ranked comparison to exported sheet', () => {
  // Everything the button triggers, in order, with no chrome.* anywhere.
  const { records } = buildSearchCapture(capture);
  const result = rank(records, 100, {});
  assert.ok(result.groups.length > 0, 'nothing ranked');
  assert.equal(result.unpriced.length, 0, 'the real capture has a price on every row');
  assert.ok(result.groups[0].rows.length > 1);

  const cheapest = result.groups[0].rows[0];
  assert.ok(resolveSupplier(cheapest.record, 100).total > 0, 'no order total at the target quantity');

  const tsv = getExporter('tsv').build(records, { targetQty: 100 });
  const rows = tsv.split('\n');
  const header = rows[0].split('\t');
  const supplierCol = header.indexOf('Supplier');
  const locationCol = header.indexOf('Location');
  assert.ok(supplierCol > -1 && locationCol > -1);
  for (const row of rows.slice(1)) {
    const cells = row.split('\t');
    assert.ok(cells[supplierCol], 'every exported row has a supplier name');
    assert.equal(cells.length, header.length, 'the sheet stays rectangular');
  }
});
