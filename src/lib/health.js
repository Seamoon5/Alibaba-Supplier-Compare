/**
 * lib/health.js — decide whether a capture is trustworthy, and say why.
 *
 * This module exists because of a specific, repeated failure: an extractor that
 * quietly returns the wrong element looks exactly like one that works. The user
 * sees a full comparison table of garbage and has no way to tell. For three
 * releases the extension did precisely that — supplier names reading "US$5,000",
 * every country reading "US" — and nothing in the UI admitted a problem.
 *
 * So a capture is never judged by "it produced rows". It is judged by whether the
 * fields a buyer would act on are actually present, and when they are not, the
 * reason travels with the data all the way to the panel.
 *
 * Pure functions, no chrome.* — unit testable and runnable in Node.
 */

/**
 * Fields a sourcing decision cannot be made without, and how bad it is when a
 * field is missing. `weight` is used to rank problems: a capture missing the
 * supplier name is worthless, one missing the reorder rate is merely thinner.
 */
export const FIELD_HEALTH = [
  { field: 'companyName', label: 'supplier name', required: true, weight: 100 },
  { field: 'country', label: 'country', required: true, weight: 80 },
  { field: 'priceTiers', label: 'price', required: true, weight: 90 },
  { field: 'moqQty', label: 'minimum order', required: false, weight: 40 },
  { field: 'yearsOnPlatform', label: 'years on Alibaba', required: false, weight: 30 },
  { field: 'rating', label: 'rating', required: false, weight: 20 },
  { field: 'onTimeDelivery', label: 'on-time delivery', required: false, weight: 20 },
  { field: 'reviewCount', label: 'review count', required: false, weight: 15 },
];

/**
 * Values that are present but obviously not what the field is for.
 *
 * This is the failure that shipped twice: a price-tier box read as the supplier
 * name, so the field was never empty, it was full of "US$5,000 Min. order: 1
 * set". Counting that as found is exactly how a full table of nonsense passed
 * for a result. A field counts as filled only if it holds something plausible.
 */
const SUSPICIOUS = {
  companyName: /^(?:US\$|CN¥|€|£|₹|¥|\$)\s*[\d.,]|min\.?\s*order\b|\breviews?\b|\byrs?\b/i,
  title: /^(?:US\$|CN¥|€|£|₹|¥|\$)\s*[\d.]|^min\.?\s*order\b/i,
  country: /^(?:US\$|\$|€|£|¥)[\d.,]/,
  currency: /\d/,
};

function filled(record, field) {
  const v = record?.[field];
  if (v === null || v === undefined || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  const bad = SUSPICIOUS[field];
  if (bad && typeof v === 'string' && bad.test(v.trim())) return false;
  return true;
}

/**
 * Score a capture.
 *
 * @param {object[]} records  what the extractor produced
 * @param {object} [context]  { strategy, anchors } straight from the harvest
 * @returns {{
 *   ok: boolean, rows: number, coverage: number, verdict: string,
 *   problems: {field:string, label:string, found:number, missing:number, ratio:number,
 *              required:boolean, weight:number}[],
 *   strategy: string, anchors: object, notes: string[],
 *   reason: string|null, advice: string|null
 * }}
 */
export function assessCapture(records, context = {}) {
  const rows = Array.isArray(records) ? records.length : 0;
  const strategy = context.strategy || 'unknown';
  const anchors = context.anchors || {};

  if (rows === 0) {
    return {
      ok: false,
      rows: 0,
      coverage: 0,
      verdict: 'empty',
      problems: [],
      strategy,
      anchors,
      reason: 'Nothing was found on this page.',
      advice:
        'Alibaba builds its results list as you scroll. Scroll until supplier cards are on screen, then press Re-scan.',
    };
  }

  const problems = [];
  for (const spec of FIELD_HEALTH) {
    const found = records.filter((r) => filled(r, spec.field)).length;
    const missing = rows - found;
    const ratio = found / rows;
    if (ratio >= 0.8) continue;
    problems.push({
      field: spec.field,
      label: spec.label,
      found,
      missing,
      ratio: Math.round(ratio * 100) / 100,
      required: spec.required,
      weight: spec.weight,
    });
  }
  problems.sort((a, b) => (a.required === b.required ? a.ratio - b.ratio : a.required ? -1 : 1));

  const required = problems.filter((p) => p.required);
  const weighted = problems.reduce((acc, p) => acc + (1 - p.ratio) * p.weight, 0);
  const coverage = Math.max(0, Math.round(100 - weighted / 10));

  // A capture is only "ok" when nothing a buyer needs is missing from more than
  // a fifth of the rows. Below that, the table is a lie.
  const ok = required.length === 0;

  let verdict = 'ok';
  if (!ok) verdict = required.some((p) => p.ratio === 0) ? 'broken' : 'degraded';

  let reason = null;
  let advice = null;
  if (verdict !== 'ok') {
    const list = problems.map((p) => `${p.missing} of ${rows} rows missing ${p.label}`).join(', ');
    reason = `This capture looks ${verdict}: ${list}.`;
    advice =
      'Alibaba has probably changed this page. Press "Copy page structure" in Settings and paste it '
      + 'in a bug report — it contains the exact markup, so the fix does not need a screenshot.';
  }

  // A field nobody needs in order to decide on a supplier is a thinning, not a
  // fault. The panel already shows "—" for it; this says how far, for a log or a
  // bug report. Alarms only go off for a field a buying decision rests on.
  const notes = problems
    .filter((p) => !p.required)
    .map((p) => `${p.missing} of ${rows} rows missing ${p.label}`);

  // A capture that fell back to label scanning is working, but on borrowed time:
  // the stable data attributes are gone and the next redesign will break it.
  const borrowed = verdict === 'ok' && strategy === 'label-fallback';

  return {
    ok: verdict === 'ok',
    borrowed,
    rows,
    coverage,
    verdict,
    problems,
    notes,
    strategy,
    anchors,
    reason,
    advice,
  };
}

/** One line for a log or a bug report. */
export function summarise(h) {
  if (!h) return 'no assessment';
  if (h.verdict === 'empty') return 'EMPTY: nothing found';
  return `${h.verdict.toUpperCase()} ${h.coverage}% — ${h.rows} rows, ${h.strategy}` +
    (h.problems.length ? `, ${h.problems.map((p) => `${p.label} ${p.found}/${h.rows}`).join(' ')}` : '') +
    (h.notes && h.notes.length ? ` [thinner: ${h.notes.length}]` : '');
}
