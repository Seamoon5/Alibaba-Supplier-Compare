/**
 * tools/contract-check.mjs — check the CAPTURE CONTRACT against a real page and
 * a real capture.
 *
 * The contract (docs/capture-contract.json) is the written answer to "what does
 * working look like on this page". This tool proves it, in two directions:
 *
 *   1. Does the live page still contain the anchors the extractor depends on?
 *      (Load the saved HTML in Chromium and count them.)
 *   2. Does a real capture actually fill the fields the contract requires?
 *      (Run the shipped extractor, then measure coverage per field.)
 *
 * Either one failing means the extractor is out of date — and it fails here,
 * loudly, before a user ever sees a wrong price. This is the check that was
 * missing when three releases shipped broken.
 *
 * Usage:
 *   node tools/contract-check.mjs                 # newest saved page in Downloads
 *   node tools/contract-check.mjs <file.html>
 */

import { chromium } from '/home/salman/.local/mcp/playwright/node_modules/playwright/index.mjs';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import { makeRecord } from '../src/lib/schema.js';
import { assessCapture, summarise } from '../src/lib/health.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DOWNLOADS = '/mnt/c/Users/Alauddin/Downloads';

const contract = JSON.parse(readFileSync(join(root, 'docs', 'capture-contract.json'), 'utf8'));
const page = contract.pages.suppliers;

function newestSavedPage() {
  const files = readdirSync(DOWNLOADS)
    .filter((f) => /^Alibaba\.com.*\.html$/i.test(f))
    .map((f) => join(DOWNLOADS, f))
    .map((p) => ({ p, m: statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (files.length === 0) {
    console.log('SKIP: no saved Alibaba page in ' + DOWNLOADS + ' (press Ctrl+S on a results page to create one)');
    process.exit(0);
  }
  return files[0].p;
}

const file = process.argv[2] || newestSavedPage();
const html = readFileSync(file, 'utf8');
const { harvestSearchPage } = await import('../src/extract/search.js');
const src = harvestSearchPage.toString();

const failures = [];
const notes = [];

// ------------------------------------------------------------------ 1. anchors
const profile = mkdtempSync(join(tmpdir(), 'asc-contract-'));
const browser = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: 'chromium',
  args: ['--no-sandbox'],
});

/**
 * Load a page and report what the extractor found on it.
 * Shared by the real check and by the self-test below, so both go through the
 * identical code path.
 */
async function inspect(page2, pageHtml) {
  const p = await browser.newPage();
  try {
    const served = pageHtml.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    await p.route('**/*', (r) =>
      r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: served }));
    await p.goto('https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=caps',
      { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(500);
    const anchors = await p.evaluate((sel) => {
      const out = {};
      for (const s of sel) out[s] = document.querySelectorAll(s).length;
      return out;
    }, page.anchors.map((a) => a.selector));
    const capture = await p.evaluate(new Function(`return (${src})();`));
    return { anchors, capture };
  } finally {
    await p.close();
  }
}

let anchors = {};
let capture = null;
try {
  ({ anchors, capture } = await inspect(null, html));

  // ------------------------------------------------------------- self-test
  // A checker that cannot fail is worse than no checker: it turns a broken
  // page into a green build. So the same page is re-checked with the one
  // attribute the extractor relies on removed, and this run MUST fail.
  const doctored = html
    .replace(/data-supplier-card="true"/g, 'data-supplier-card="false"')
    .replace(/alt="countryFlag"/g, 'alt="flag"')
    .replace(/data-supplier-card-product="true"/g, 'data-supplier-card-product="false"');
  const d = await inspect(null, doctored);
  const dAnchors = page.anchors.filter((a) => (d.anchors[a.selector] ?? 0) < a.minCount);
  const dRecords = (d.capture?.candidates || []).map((c) => makeRecord({ ...c, origin: 'search' }));
  const dHealth = assessCapture(dRecords, { strategy: d.capture?.strategy, anchors: d.capture?.anchors });
  const detected = dAnchors.length > 0 || !dHealth.ok || dRecords.length < page.minRows;
  console.log('');
  console.log('0. self-test: the same page with its data attributes removed');
  console.log(`   doctored anchors missing : ${dAnchors.map((a) => a.selector).join(', ') || 'none'}`);
  console.log(`   doctored capture         : ${dRecords.length} rows — ${summarise(dHealth)}`);
  if (!detected) {
    failures.push('SELF-TEST FAILED: the contract accepted a page with the supplier-card attributes removed, '
      + 'so the check cannot detect a redesigned page');
  } else {
    console.log('   ok — the checker rejects a redesigned page, so a green build means something');
  }
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}

console.log('page      :', basename(file));
console.log('contract  : v' + contract.version + ', verified ' + contract.verifiedOn);
console.log('');
console.log('1. anchors the extractor needs, on the page as it is now');
for (const a of page.anchors) {
  const n = anchors[a.selector] ?? 0;
  const ok = n >= a.minCount;
  if (!ok) failures.push(`anchor ${a.selector} found ${n}, contract needs ${a.minCount} (${a.means})`);
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${String(n).padStart(4)}x  ${a.selector}  — ${a.means}`);
}

// ------------------------------------------------------- 2. field coverage
const records = (capture?.candidates || []).map((c) => makeRecord({ ...c, origin: 'search' }));
console.log('');
console.log(`2. field coverage over ${records.length} captured rows`);

if (records.length < page.minRows) {
  failures.push(`only ${records.length} rows captured, contract needs ${page.minRows} (scroll and re-scan)`);
}

for (const f of contract.fields) {
  const found = records.filter((r) => {
    const v = r[f.field];
    if (v === null || v === undefined || v === '') return false;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  }).length;
  const ratio = records.length ? found / records.length : 0;
  const ok = ratio >= f.minRatio;
  if (f.required && !ok) {
    failures.push(`required field ${f.field} filled on ${(ratio * 100).toFixed(0)}% of rows, contract needs ${(f.minRatio * 100).toFixed(0)}% (${f.from})`);
  } else if (!ok) {
    notes.push(`${f.field} filled on ${(ratio * 100).toFixed(0)}% of rows, contract expects ${(f.minRatio * 100).toFixed(0)}%`);
  }
  const mark = ok ? 'ok  ' : (f.required ? 'FAIL' : 'warn');
  console.log(`   ${mark}  ${String(found).padStart(4)}/${String(records.length).padEnd(4)} ${f.field.padEnd(18)} from ${f.from}`);
}

// --------------------------------------------- 3. the runtime's own verdict
const health = assessCapture(records, { strategy: capture?.strategy, anchors: capture?.anchors });
console.log('');
console.log('3. runtime health verdict:', summarise(health));
if (!health.ok) failures.push(`runtime health says ${health.verdict}: ${health.reason}`);

// ------------------------------------------------- 4. no class-name matching
const source = readFileSync(join(root, 'src', 'extract', 'search.js'), 'utf8');
const classSelectors = [...source.matchAll(/querySelectorAll\(\s*['"`]([^'"`]*class\*?=[^'"`]*)['"`]/g)]
  .map((m) => m[1]);
if (classSelectors.length) {
  failures.push(`extractor matches on class names (${classSelectors.join(', ')}) — they are hashed per deploy`);
}
console.log('');
console.log('4. class-name selectors in the extractor:', classSelectors.length === 0 ? 'none (correct)' : classSelectors.join(', '));

console.log('');
if (notes.length) {
  console.log('notes:');
  notes.forEach((n) => console.log('  ·', n));
}
if (failures.length) {
  console.log('');
  console.log('CONTRACT FAILED — Alibaba has changed this page, or the extractor has drifted:');
  failures.forEach((f) => console.log('  ✗', f));
  console.log('');
  console.log('Repair it from the page, not from memory: the panel\'s "Copy page structure"');
  console.log('button contains the two result cards as they are actually rendered.');
  process.exit(1);
}
console.log('CONTRACT OK — the page, the capture and the contract all agree.');
