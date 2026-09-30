/**
 * contract.test.js — the fast half of the capture contract.
 *
 * tools/contract-check.mjs proves the contract against a real saved page in a
 * real browser. This file proves the same contract in a second, so a mistake is
 * caught by `npm test` alone, without a browser and without the user having
 * saved a page:
 *
 *   - every required field has an export column, and that column exists
 *   - the committed real capture still satisfies the contract's coverage
 *   - the extractor contains no class-name selector, because Alibaba hashes
 *     class names per deploy and they are worthless as a contract
 *   - the contract's honesty rules are the ones the panel preview enforces
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRecord, FIELD_LABELS } from '../src/lib/schema.js';
import { getExporter } from '../src/lib/exporters/index.js';
import { assessCapture } from '../src/lib/health.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const contract = JSON.parse(readFileSync(join(root, 'docs', 'capture-contract.json'), 'utf8'));
const fixturePath = join(root, 'docs', 'fixtures', 'real-capture-sample.json');
const hasFixture = existsSync(fixturePath);
const capture = hasFixture ? JSON.parse(readFileSync(fixturePath, 'utf8')) : null;
const records = hasFixture ? capture.candidates.map((c) => makeRecord({ ...c, origin: 'search' })) : [];

test('the contract says where each field comes from, and how much of it is required', () => {
  assert.ok(contract.pages.suppliers, 'a suppliers page is defined');
  assert.ok(contract.pages.suppliers.anchors.length >= 5);
  for (const a of contract.pages.suppliers.anchors) {
    assert.ok(a.selector, 'every anchor has a selector');
    assert.ok(a.means, `anchor ${a.selector} says what it means`);
    // The whole reason three releases broke: class names are hashed per deploy.
    assert.equal(/class\s*[~^$*|]?=/.test(a.selector), false,
      `contract anchor must not depend on a class name: ${a.selector}`);
  }
  for (const f of contract.fields) {
    assert.ok(f.from, `field ${f.field} says where it comes from`);
    assert.ok(typeof f.minRatio === 'number');
    if (f.required) assert.ok(f.exportLabel, `required field ${f.field} reaches the sheet as a column`);
  }
});

test('every required field has a real column in the Sheets export', () => {
  const header = getExporter('tsv').build(records.length ? records : [makeRecord({ productId: 'x' })], {})
    .split('\n')[0].split('\t');
  for (const f of contract.fields) {
    if (!f.required || !f.exportLabel) continue;
    assert.ok(header.includes(f.exportLabel),
      `the sheet has no "${f.exportLabel}" column for required field ${f.field}. `
      + `Add it, or the buyer cannot see the field.`);
  }
});

test('the extractor contains no class-name selector', () => {
  const src = readFileSync(join(root, 'src', 'extract', 'search.js'), 'utf8');
  const found = [...src.matchAll(/querySelectorAll\(\s*['"`]([^'"`]*)['"`]/g)].map((m) => m[1]);
  for (const sel of found) {
    assert.equal(/\bclass\b\s*[~^$*|]?=/.test(sel), false,
      `selector "${sel}" matches a class name; Alibaba hashes those per deploy`);
  }
});

test('a field the contract marks required has a label the UI can show', () => {
  for (const f of contract.fields) {
    if (f.required) assert.ok(FIELD_LABELS[f.field], `no display label for ${f.field}`);
  }
});

test('the committed real capture satisfies the contract', { skip: !hasFixture && 'no committed capture' }, () => {
  assert.ok(records.length >= contract.pages.suppliers.minRows,
    `the fixture has ${records.length} rows, the contract needs ${contract.pages.suppliers.minRows}`);

  for (const f of contract.fields) {
    const found = records.filter((r) => {
      const v = r[f.field];
      if (v === null || v === undefined || v === '') return false;
      if (Array.isArray(v)) return v.length > 0;
      return true;
    }).length;
    const ratio = found / records.length;
    assert.ok(ratio >= f.minRatio,
      `${f.field} is filled on only ${(ratio * 100).toFixed(0)}% of the real capture, `
      + `contract needs ${(f.minRatio * 100).toFixed(0)}% (from ${f.from})`);
  }
});

test('the real capture passes the same health check the extension runs', { skip: !hasFixture && 'no committed capture' }, () => {
  const h = assessCapture(records, { strategy: capture.strategy, anchors: capture.anchors });
  assert.equal(h.ok, true, `the committed capture is ${h.verdict}: ${h.reason}`);
});

test('the honesty rules are written down where the panel check can enforce them', () => {
  for (const key of ['noSilentHiding', 'noInventedValues', 'rangeIsHonest', 'degradedIsLoud']) {
    assert.ok(contract.honesty[key], `honesty rule ${key} is missing`);
  }
});
