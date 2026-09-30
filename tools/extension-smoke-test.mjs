/**
 * tools/extension-smoke-test.mjs — press the button for real.
 *
 * The bug that motivated this: the search capture path in background.js called
 * `assessCapture()` without importing it. Every unit test passed, the gate was
 * green, the extension loaded, and pressing the button threw
 * "assessCapture is not defined". Every check we had tested the modules; none
 * of them ran the code that wires them together, in a browser, with the real
 * chrome APIs.
 *
 * So this does the whole thing:
 *   1. launches Chromium with the unpacked extension loaded
 *   2. opens a real alibaba.com results URL, serving the page you saved
 *   3. sends the panel's actual CAPTURE message, so background.js runs its own
 *      handler with real chrome.scripting, chrome.storage and chrome.tabs
 *   4. asserts records were stored and the response carries no error
 *
 * Usage: node tools/extension-smoke-test.mjs [saved-page.html]
 */

import { chromium } from '/home/salman/.local/mcp/playwright/node_modules/playwright/index.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DOWNLOADS = '/mnt/c/Users/Alauddin/Downloads';
const ALIBABA_URL = 'https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=caps';

function newestSavedPage() {
  const files = readdirSync(DOWNLOADS)
    .filter((f) => /^Alibaba\.com.*\.html$/i.test(f))
    .map((f) => join(DOWNLOADS, f))
    .map((p) => ({ p, m: statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (files.length === 0) {
    console.error('No saved Alibaba page found in ' + DOWNLOADS);
    console.error('Open a suppliers search, press Ctrl+S, press Enter, then re-run.');
    process.exit(2);
  }
  return files[0].p;
}

const file = process.argv[2] || newestSavedPage();
const saved = readFileSync(file, 'utf8');

const profile = mkdtempSync(join(tmpdir(), 'asc-smoke-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: 'chromium',
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
  ],
});

const problems = [];
let summary = '';
try {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(worker.url()).host;
  console.log('extension  :', extId);

  // The results page, served at a real alibaba.com URL so the host permission
  // applies exactly as it does in the wild.
  const page = await context.newPage();
  await page.route('**/*', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: saved }));
  await page.goto(ALIBABA_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  // The panel, opened as a tab. It stays in the background; the Alibaba tab is
  // the active one, which is what the capture handler looks for.
  const panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', (e) => errors.push(e.message));
  await panel.goto(`chrome-extension://${extId}/src/panel/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await panel.waitForTimeout(400);
  await page.bringToFront();

  // This is the message the toolbar button sends. background.js's own handler
  // runs it: probe the page, inject the extractor, build records, judge them,
  // write storage, answer with a message.
  const result = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'CAPTURE' }));
  console.log('response   :', JSON.stringify({
    ok: result?.ok,
    action: result?.action,
    total: result?.total,
    verdict: result?.health?.verdict,
    tone: result?.message?.tone,
  }));

  if (!result) problems.push('the CAPTURE message returned nothing — the service worker threw');
  if (result?.ok !== true) {
    problems.push(`capture did not succeed: ${result?.message?.body || 'no message'}`);
  }
  if (result?.message?.tone === 'error') {
    problems.push(`the extension reported an error to the user: ${result.message.body}`);
  }
  if (!result?.total) problems.push('no records were produced');

  const stored = await panel.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const rows = all['asc:records'] || [];
    return {
      records: rows.length,
      named: rows.filter((r) => r.companyName && !/^(US\$|\$|€|£|¥)/.test(r.companyName)).length,
      priced: rows.filter((r) => Array.isArray(r.priceTiers) && r.priceTiers.length > 0).length,
      first: rows[0] ? { company: rows[0].companyName, country: rows[0].country, price: rows[0].priceTiers?.[0]?.unitPrice } : null,
      diagnostics: all['asc:diagnostics'] ? Object.keys(all['asc:diagnostics']) : [],
    };
  });
  console.log('stored     :', JSON.stringify(stored));
  if (stored.records === 0) problems.push('nothing reached chrome.storage — the capture path never completed');
  if (stored.named !== stored.records) problems.push('a stored record has no usable supplier name');
  if (stored.priced !== stored.records) problems.push('a stored record has no price');
  if (!stored.diagnostics.includes('cardSamples')) {
    problems.push('the diagnostics kept no page evidence — "Copy page structure" would have nothing');
  }

  // The evidence button is the repair route, so it must contain real markup.
  const evidence = await worker.evaluate(async () => {
    const d = (await chrome.storage.local.get('asc:diagnostics'))['asc:diagnostics'] || {};
    const samples = d.cardSamples || [];
    return { count: samples.length, chars: samples.reduce((n, s) => n + String(s).length, 0), hasCard: /data-supplier-card/.test(String(samples[0] || '')) };
  });
  console.log('evidence   :', JSON.stringify(evidence));
  if (evidence.count === 0) problems.push('no card samples were captured — a bug report could not be repaired');
  if (!evidence.hasCard) problems.push('the captured card sample does not contain supplier-card markup');

  if (errors.length) {
    problems.push(`panel page errors: ${errors.slice(0, 2).join(' | ')}`);
  }

  await panel.close();
  await page.close();
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}

if (problems.length) {
  console.log('');
  console.log('SMOKE TEST FAILED — the real button does not work:');
  for (const p of problems) console.log('  ✗', p);
  console.log('');
  console.log('This stage exists because a missing import shipped once already: every other');
  console.log('check was green and pressing the button threw. Do not report this as fixed.');
  process.exit(1);
}
console.log('');
console.log(`SMOKE TEST PASSED — the real button works end to end.${summary}`);
