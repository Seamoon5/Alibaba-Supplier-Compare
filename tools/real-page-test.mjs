/**
 * tools/real-page-test.mjs — run the shipped extractor against REAL saved
 * Alibaba HTML, in a real browser, and print what it actually found.
 *
 * This is the test that matters. Unit tests run against hand-built fixtures,
 * which can only prove the code does what it was written to do. Alibaba
 * changes its markup constantly, hashed class names included, and guessing at it
 * is what produced three broken versions of this extension. A saved page
 * ("Ctrl+S" on the results page) is the ground truth: same DOM, same selectors,
 * same code path as the live page.
 *
 * Usage:
 *   node tools/real-page-test.mjs                     # newest saved page in Downloads
 *   node tools/real-page-test.mjs <file.html>         # a specific saved page
 *   node tools/real-page-test.mjs <file.html> --json  # machine-readable dump
 */

import { chromium } from '/home/salman/.local/mcp/playwright/node_modules/playwright/index.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DOWNLOADS = '/mnt/c/Users/Alauddin/Downloads';

const args = process.argv.slice(2).filter((a) => a !== '--json');
const asJson = process.argv.includes('--json');

function newestSavedPage() {
  const candidates = readdirSync(DOWNLOADS)
    .filter((f) => /^Alibaba\.com.*\.html$/i.test(f))
    .map((f) => join(DOWNLOADS, f))
    .map((p) => ({ p, m: statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (candidates.length === 0) {
    console.error('No saved Alibaba page found in ' + DOWNLOADS);
    console.error('Open a suppliers search in Chrome, press Ctrl+S, press Enter, then re-run.');
    process.exit(2);
  }
  return candidates[0].p;
}

const file = args[0] ? args[0] : newestSavedPage();
const html = readFileSync(file, 'utf8');
console.log('page   :', basename(file));
console.log('size   :', Math.round(html.length / 1024), 'KB');
console.log('cards  :', (html.match(/data-supplier-card="true"/g) || []).length, 'supplier cards in the file\n');

// The extractor is a single self-contained function because Chrome serialises
// it into the page. To run it here we evaluate the real source in the real DOM.
const mod = await import('../src/extract/search.js');
const src = mod.harvestSearchPage.toString();

const profile = mkdtempSync(join(tmpdir(), 'asc-real-'));
const browser = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: 'chromium',
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});

let result;
let failures = 0;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Serve the saved page over http, not file://, so relative behaviour and
  // location.href match what the extension sees in the wild.
  // Scripts are stripped: the saved page's own bundles throw on re-execution
  // (their JSON blobs are already stale), and those failures would drown the
  // one signal that matters — whether the extractor itself throws.
  const served = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  await page.route('**/*', (route) => {
    if (route.request().url().startsWith('data:')) return route.continue();
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: served });
  });
  await page.goto('https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=caps', {
    waitUntil: 'domcontentloaded',
  });
  // A saved page keeps Alibaba's hashed CSS but the card text is already in the
  // DOM; the only thing that needs to settle is layout, which gives every card a
  // real height so the visibility check behaves as it does live.
  await page.waitForTimeout(800);

  result = await page.evaluate(new Function(`return (${src})();`));
  if (errors.length) {
    console.log('page errors:', errors.slice(0, 3));
    failures += errors.length;
  }
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const rows = result.candidates || [];
  const money = (v) => (v === null || v === undefined ? '—' : String(v));
  console.log('scene  :', result.scene, '| found:', result.count, '| priced:', result.pricedCount);
  console.log('');
  console.log(
    ['#', 'supplier', 'country', 'yrs', 'type', 'rating', 'from', 'to', 'moq', 'products']
      .map((h, i) => h.padEnd([3, 38, 7, 4, 13, 7, 9, 8, 9, 6][i]))
      .join('')
  );
  console.log('-'.repeat(112));
  rows.forEach((r, i) => {
    const name = (r.companyName || '(none)').slice(0, 38);
    const loc = r.province ? `${r.province}, ${r.country}` : money(r.country);
    const from = r.priceTiers[0] ? r.priceTiers[0].unitPrice : null;
    console.log(
      [
        String(i + 1), name, loc.slice(0, 7), money(r.yearsOnPlatform),
        (r.businessType || '—').slice(0, 13),
        r.rating ? `${r.rating}/5` : '—',
        money(from), money(r.priceTo), money(r.moqQty), String((r.products || []).length),
      ]
        .map((v, j) => String(v).padEnd([3, 38, 7, 4, 13, 7, 9, 8, 9, 6][j]))
        .join('')
    );
  });
  console.log('');
  const noName = rows.filter((r) => !r.companyName).length;
  const noPrice = rows.filter((r) => !r.priceTiers.length).length;
  const noCountry = rows.filter((r) => !r.country).length;
  console.log(`missing name    : ${noName}`);
  console.log(`missing price   : ${noPrice}`);
  console.log(`missing country : ${noCountry}`);
  if (rows[0]) {
    console.log('\nfirst row in full:');
    console.log(JSON.stringify({ ...rows[0], raw: undefined, products: rows[0].products }, null, 2).slice(0, 1400));
  }
}

// Assertions, so a silent regression cannot pass unnoticed.
const problems = [];
(result.candidates || []).forEach((r, i) => {
  if (!r.companyName) problems.push(`row ${i + 1}: no company name`);
  if (!r.country) problems.push(`row ${i + 1}: no country`);
});
if (result.count > 0 && problems.length) {
  console.log('\nFAIL:');
  problems.slice(0, 8).forEach((p) => console.log(' -', p));
  failures += problems.length;
} else if (result.count > 0) {
  console.log('\nOK: every row has a supplier name and a country.');
}

// Two copies, deliberately. The fixture is committed so `npm run preview`
// always renders REAL extracted data in CI and on a fresh clone; the working
// dump is ignored so a capture never leaves the machine in a commit by accident.
for (const out of [
  join(root, 'docs', 'fixtures', 'real-capture-sample.json'),
  join(root, 'docs', 'last-real-capture.json'),
]) {
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ source: file, capturedAt: new Date().toISOString(), ...result }, null, 2));
    console.log('capture written to', out);
  } catch {
    /* non-fatal */
  }
}

process.exit(failures ? 1 : 0);
