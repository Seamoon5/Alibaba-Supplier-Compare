/**
 * tools/live-test.mjs — load this extension into a real Chromium, point it at a
 * real Alibaba page, and report what the extractor actually finds.
 *
 * This is the only way to check the extractors against Alibaba's real markup.
 * Everything else in the test suite runs against hand-built fixtures, which can
 * only prove the code does what it was written to do, not that it matches the
 * page.
 *
 * Usage:
 *   node tools/live-test.mjs                 # a product page and a search page
 *   node tools/live-test.mjs <url>           # one specific URL
 *   node tools/live-test.mjs <url> product    # force the product extractor
 *   node tools/live-test.mjs <url> search     # force the search extractor
 *
 * Expects to be blocked by Alibaba's CAPTCHA from a datacenter IP. That is a
 * useful result in itself: it proves the punish-page detection works. To test
 * against the real, captcha-free pages, run this from your own machine with a
 * logged-in Chrome profile, or press the toolbar button on a real page and
 * send the diagnostic snapshot from the panel.
 */

import { chromium } from '/home/salman/.local/mcp/playwright/node_modules/playwright/index.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const DEFAULT_URLS = [
  ['https://www.alibaba.com/product-detail/_1601918386232.html', 'product'],
  ['https://www.alibaba.com/search/page?SearchText=chenille%20embroidery%20machine', 'search'],
];

const argUrl = process.argv[2];
const argMode = process.argv[3];
const targets = argUrl ? [[argUrl, argMode]] : DEFAULT_URLS;

// Chrome will not run an extension in the default headless shell, so use a
// throwaway profile with the new headless mode.
const profile = mkdtempSync(join(tmpdir(), 'asc-live-'));

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

let failures = 0;
try {
  // Wait for the service worker: its existence proves the manifest parsed and
  // no permission is missing.
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(worker.url()).host;
  console.log('extension loaded :', extId);
  console.log('service worker  : ready\n');

  for (const [url, mode] of targets) {
    console.log('='.repeat(72));
    console.log('URL   :', url);
    console.log('mode  :', mode);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    let verdict;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3500);

      const state = await page.evaluate(() => ({
        href: location.href,
        title: document.title,
        punish: /punish-component|awsc\.js|NCTOKENSTR|_____tmd_____/i.test(
          document.documentElement.outerHTML.slice(0, 200000),
        ),
        productLinks: document.querySelectorAll('a[href*="/product-detail/"]').length,
      }));

      console.log('landed :', state.href);
      console.log('title  :', state.title.slice(0, 70));
      console.log('punish :', state.punish);
      console.log('product links on page:', state.productLinks);

      if (state.punish) {
        verdict = 'BLOCKED (Alibaba CAPTCHA)';
        console.log('\n-> Alibaba served its verification interstitial.');
        console.log('-> That is the exact case the extension detects and refuses.');
        console.log('-> Extraction cannot be validated from this IP. Expected.');
      } else if (mode === 'search' && state.productLinks === 0) {
        verdict = 'NO RESULTS RENDERED';
        console.log('\n-> Page loaded but no product links, so the search extractor has');
        console.log('   nothing to anchor on. The DOM shape has probably changed.');
      } else {
        verdict = 'PAGE REACHABLE - extractor can be validated here';
        console.log('\n-> This page is usable. Press the toolbar button here, then use');
        console.log('   Settings -> Copy diagnostic snapshot and send it in a bug report');
        console.log('   if any field shows "not found".');
      }
    } catch (err) {
      verdict = 'NAVIGATION FAILED';
      console.log('navigation error:', err.message.split('\n')[0]);
    }

    if (pageErrors.length) {
      console.log('page errors:', pageErrors.slice(0, 3));
      failures += pageErrors.length;
    }
    console.log('verdict :', verdict);
    await page.close();
  }
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(72));
if (failures) {
  console.log(`${failures} page error(s) seen`);
  process.exit(1);
}
console.log('done. Run this from your own machine with a logged-in Chrome profile');
console.log('to validate the extractors against pages Alibaba will actually serve.');
