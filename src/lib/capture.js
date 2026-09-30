/**
 * lib/capture.js — the whole results-page pipeline in one pure function.
 *
 * It exists because of a bug this file prevents. The search capture path called
 * `assessCapture()` without importing it: every test passed, every gate stage
 * passed, the extension loaded, and pressing the button threw
 * "assessCapture is not defined". Nothing was wrong with any test — the tests
 * exercised the extractor, the store, the health module and the exporters, but
 * never the code path the button actually runs.
 *
 * So the path is now a module of its own, free of chrome.* and of storage, and
 * it is covered end to end in test/capture.test.js: harvest → records → health.
 * The service worker is left with nothing to wire.
 */

import { makeRecord } from './schema.js';
import { assessCapture, summarise } from './health.js';

/**
 * Turn a harvest from harvestSearchPage() into saved records plus a verdict on
 * them.
 *
 * @param {object} harvest  the object the injected reader returned
 * @returns {{ok:boolean, records:object[], health:object, summary:string}}
 */
export function buildSearchCapture(harvest) {
  const candidates = Array.isArray(harvest?.candidates) ? harvest.candidates : [];
  const records = candidates
    .map((c) => makeRecord({
      ...c,
      origin: 'search',
      provenance: { __source: 'search-cards' },
      capturedAt: new Date().toISOString(),
    }))
    .filter((r) => r.companyName || r.title);

  const health = assessCapture(records, {
    strategy: harvest?.strategy,
    anchors: harvest?.anchors,
  });

  return {
    ok: records.length > 0 && health.verdict !== 'empty',
    records,
    health,
    summary: summarise(health),
    // Enough to repair a broken extractor from one paste: which anchors matched,
    // how many of each the page had, and two cards as they are actually rendered.
    evidence: {
      strategy: harvest?.strategy || 'unknown',
      anchors: harvest?.anchors || {},
      health: { verdict: health.verdict, coverage: health.coverage, summary: summarise(health) },
      cardSamples: Array.isArray(harvest?.cardSamples) ? harvest.cardSamples.slice(0, 2) : [],
    },
  };
}

/**
 * The banner the panel shows for a capture that is not clean.
 *
 * @returns {{tone:'warn'|'error', title:string, body:string}|null} null when the
 *          capture is fine, because a good capture needs no explanation.
 */
export function healthMessage(health) {
  if (!health || health.verdict === 'ok') return null;
  return {
    tone: health.verdict === 'broken' || health.verdict === 'empty' ? 'error' : 'warn',
    title: health.verdict === 'empty'
      ? 'Nothing to add on this page'
      : health.verdict === 'broken' ? 'Capture looks broken' : 'Partial data',
    body: `${health.reason || ''}${health.advice ? ` ${health.advice}` : ''}`.trim(),
  };
}
