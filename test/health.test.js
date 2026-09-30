/**
 * health.test.js — the rules that stop a broken capture from looking like a good
 * one.
 *
 * The failure this module exists for: an extractor that reads the wrong element
 * returns rows, fills the table, and looks like a result. Three releases shipped
 * that way. These tests pin the behaviour that makes it impossible to ship
 * quietly again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { assessCapture, summarise, FIELD_HEALTH } from '../src/lib/health.js';

/** A healthy supplier row, as a real capture produces one. */
const healthy = (over = {}) => ({
  companyName: 'Dongguan Kaihong Caps And Bags Co., Ltd.',
  country: 'CN',
  priceTiers: [{ minQty: 1, maxQty: null, unitPrice: 1.68 }],
  currency: 'USD',
  moqQty: 3,
  yearsOnPlatform: 16,
  rating: 4.8,
  onTimeDelivery: 94,
  reviewCount: 52,
  ...over,
});

const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));

test('a complete capture is ok and says so', () => {
  const h = assessCapture(many(20, () => healthy()), { strategy: 'data-supplier-card' });
  assert.equal(h.ok, true);
  assert.equal(h.verdict, 'ok');
  assert.equal(h.rows, 20);
  assert.equal(h.reason, null, 'a good capture explains nothing because there is nothing to explain');
  assert.equal(h.coverage, 100);
  assert.equal(h.borrowed, false);
});

test('supplier names that are actually prices are caught, not celebrated', () => {
  // The exact failure that shipped twice: "US$5,000" read as a company name.
  const h = assessCapture(many(20, () => healthy({ companyName: 'US$5,000 Min. order: 1 set' })), {});
  assert.equal(h.ok, false);
  assert.equal(h.verdict, 'broken');
  assert.match(h.reason, /supplier name/);
});

test('a missing country is broken, a missing reorder rate is only thinner', () => {
  const noCountry = assessCapture(many(20, () => healthy({ country: '' })), {});
  assert.equal(noCountry.verdict, 'broken');
  assert.ok(noCountry.problems.some((p) => p.field === 'country' && p.required));

  const noRating = assessCapture(many(20, () => healthy({ rating: null, reviewCount: null })), {});
  assert.equal(noRating.verdict, 'ok', 'a page that publishes no rating is not a broken capture');
  assert.ok(noRating.problems.every((p) => !p.required));
});

test('a capture missing one field on one row in five is not yet a problem', () => {
  const rows = many(20, (i) => healthy(i < 4 ? { moqQty: null } : {}));
  const h = assessCapture(rows, {});
  assert.equal(h.verdict, 'ok');
  assert.equal(h.problems.length, 0, 'exactly 80% coverage is the threshold, not below it');
});

test('a capture missing one field on more than one row in five is a note, not an alarm', () => {
  const rows = many(20, (i) => healthy(i < 5 ? { moqQty: null } : {}));
  const h = assessCapture(rows, {});
  assert.equal(h.verdict, 'ok', 'a missing minimum order does not stop you buying');
  assert.equal(h.reason, null, 'nothing is wrong enough to raise a banner');
  assert.ok(h.problems.some((p) => p.field === 'moqQty'));
  assert.match(h.notes.join(' '), /minimum order/);
});

test('nothing found is its own verdict, with something to do about it', () => {
  const h = assessCapture([], {});
  assert.equal(h.verdict, 'empty');
  assert.equal(h.ok, false);
  assert.match(h.advice, /scroll/i, 'the fix for an empty page is a scroll, not a reinstall');
});

test('a broken capture always ships a repair route, never just a complaint', () => {
  const h = assessCapture(many(20, () => healthy({ companyName: '' })), {});
  assert.match(h.reason, /\d+ of 20 rows/);
  assert.match(h.advice, /Copy page structure/i);
});

test('a capture that fell back to label scanning is marked as living on borrowed time', () => {
  const rows = many(20, () => healthy());
  assert.equal(assessCapture(rows, { strategy: 'data-supplier-card' }).borrowed, false);
  const fallback = assessCapture(rows, { strategy: 'label-fallback' });
  assert.equal(fallback.ok, true, 'it still works');
  assert.equal(fallback.borrowed, true, 'but the stable anchors are gone and it should be replaced');
});

test('every health field declares a weight, so the score can never be NaN', () => {
  for (const f of FIELD_HEALTH) {
    assert.equal(typeof f.weight, 'number', `${f.field} has no weight`);
    assert.ok(f.weight > 0);
    assert.equal(typeof f.label, 'string');
  }
  const bad = assessCapture(many(20, () => healthy({ country: '' })), {});
  assert.equal(Number.isNaN(bad.coverage), false);
  assert.ok(bad.coverage >= 0 && bad.coverage <= 100);
});

test('a null record does not throw the assessment', () => {
  const h = assessCapture([null, undefined, healthy()], {});
  assert.equal(h.rows, 3);
  assert.equal(h.ok, false, 'two of three rows are unusable');
});

test('summarise is a single line a bug report can quote', () => {
  const line = summarise(assessCapture(many(20, () => healthy()), { strategy: 'data-supplier-card' }));
  assert.ok(!line.includes('\n'));
  assert.match(line, /OK 100%/);
});
