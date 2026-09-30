/**
 * tools/panel-preview.mjs — render the side panel outside Chrome and check it.
 *
 * The panel is a plain extension page, so it can be loaded in a normal browser
 * tab with a stubbed `chrome` object. That gives us three things a unit test
 * cannot: real CSS layout, real console errors, and screenshots to look at.
 *
 * Usage:  node tools/panel-preview.mjs [outDir]
 * Needs:  playwright (already installed for the browser MCP on this machine)
 */

import { chromium } from '/home/salman/.local/mcp/playwright/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const outDir = process.argv[2] || join(root, 'docs/screenshots');
mkdirSync(outDir, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * ES modules cannot be loaded over file:// (CORS rejects them with a null
 * origin), so the panel is served over loopback HTTP instead.
 */
function serve() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      const file = join(root, rel);
      try {
        if (!statSync(file).isFile()) throw new Error('not a file');
        res.writeHead(200, { 'Content-Type': TYPES[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' });
        res.end(readFileSync(file));
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** A realistic comparison: three suppliers, two currencies, one sparse row. */
const RECORDS = [
  {
    productId: '1601918386232',
    title: '3 Head Pure Chenille Embroidery Machine 6 Needles 220V',
    sourceUrl: 'https://www.alibaba.com/product-detail/_1601918386232.html',
    companyName: 'Hangzhou Richpeace Machinery Co., Ltd.',
    companyUrl: 'https://richpeace.en.alibaba.com/company_profile.html',
    country: 'China', businessType: 'Manufacturer', currency: 'USD',
    moqQty: 1, moqUnit: 'set', yearsOnPlatform: 12,
    verifiedSupplier: true, tradeAssurance: true, responseRate: '95%',
    leadTime: '30 days', confidence: 'high', missing: [],
    capturedAt: new Date().toISOString(),
    provenance: { priceTiers: 'blob:path', moqQty: 'blob:path' },
    image: '', priceTiers: [
      { minQty: 1, maxQty: 1, unitPrice: 5200 },
      { minQty: 2, maxQty: 4, unitPrice: 4850 },
      { minQty: 5, maxQty: null, unitPrice: 4500 },
    ],
  },
  {
    productId: '1601920000001',
    title: 'Chenille Embroidery Machine 3 Head',
    sourceUrl: 'https://www.alibaba.com/product-detail/_1601920000001.html',
    companyName: 'Ningbo Sunwing Industrial Co.',
    companyUrl: 'https://sunwing.en.alibaba.com/company_profile.html',
    country: 'China', businessType: 'Manufacturer', currency: 'USD',
    moqQty: 2, moqUnit: 'set', yearsOnPlatform: 7,
    verifiedSupplier: false, tradeAssurance: true, responseRate: '88%',
    confidence: 'high', missing: [], capturedAt: new Date().toISOString(),
    provenance: { priceTiers: 'blob:path' }, image: '',
    priceTiers: [
      { minQty: 2, maxQty: 4, unitPrice: 4750 },
      { minQty: 5, maxQty: null, unitPrice: 4400 },
    ],
  },
  {
    productId: '1601930000002',
    title: 'Chenille Stitching Machine 500x400mm',
    sourceUrl: 'https://www.alibaba.com/product-detail/_1601930000002.html',
    companyName: 'Shaoxing Huimei Machine',
    companyUrl: '', country: 'China', businessType: 'Trading Co., Ltd.',
    currency: 'EUR', moqQty: 5, moqUnit: 'set', yearsOnPlatform: 4,
    verifiedSupplier: false, tradeAssurance: false, responseRate: '91%',
    confidence: 'low', missing: ['leadTime'],
    capturedAt: new Date().toISOString(),
    provenance: { priceTiers: 'blob:path', leadTime: 'missing' }, image: '',
    priceTiers: [{ minQty: 5, maxQty: null, unitPrice: 4650 }],
  },
];

/** Rows as a live Suppliers results page produces them: a company card whose
 *  prices come from its product tiles, published as ranges. */
const SUPPLIER_RECORDS = [
  {
    productId: 'zhuji', title: 'DISEN Large Format Single Head Computer',
    sourceUrl: 'https://www.alibaba.com/product-detail/_1700000000000.html',
    companyName: 'Zhuji Yuanheng Sewing Equipment Co., Ltd.', country: 'CN',
    yearsOnPlatform: 1, verifiedSupplier: false, tradeAssurance: false, businessType: 'Manufacturer',
    currency: 'USD', moqQty: 1, moqUnit: 'set', onTimeDelivery: 100, reorderRate: null,
    responseRate: '<1h', onlineRevenue: '$2M-$5M', confidence: 'high', missing: [], origin: 'search',
    capturedAt: new Date().toISOString(), provenance: {},
    priceTiers: [{ minQty: 1, maxQty: null, unitPrice: 1250 }],
    priceTo: 4500,
    products: [
      { title: 'DISEN Large Format Single Head Computer', from: 1250, to: 4500, currency: 'USD' },
      { title: 'High Quality Commercial logo Hat', from: 6900, to: 7200, currency: 'USD' },
      { title: 'Shenzhen Hoos NZ Automatic', from: 12500, to: 13500, currency: 'USD' },
    ],
  },
  {
    productId: 'disen', title: 'DISEN Single Head Computer',
    sourceUrl: 'https://www.alibaba.com/product-detail/_1700000000001.html',
    companyName: 'Guangzhou Disen Electronic Technology', country: 'CN',
    yearsOnPlatform: 6, verifiedSupplier: true, tradeAssurance: true, businessType: 'Manufacturer',
    currency: 'USD', moqQty: 1, moqUnit: 'set', onTimeDelivery: 98, reorderRate: 40,
    responseRate: '<2h', onlineRevenue: '$5M-$10M', confidence: 'high', missing: [], origin: 'search',
    capturedAt: new Date().toISOString(), provenance: {},
    priceTiers: [{ minQty: 1, maxQty: null, unitPrice: 6900 }],
    priceTo: 7200,
    products: [{ title: 'DISEN Single Head Computer', from: 6900, to: 7200, currency: 'USD' }],
  },
  {
    productId: 'nameless', title: 'Commercial logo Hat',
    sourceUrl: 'https://www.alibaba.com/product-detail/_1700000000002.html',
    companyName: 'Nameless Trading Co', country: '', yearsOnPlatform: 3,
    verifiedSupplier: false, tradeAssurance: false, businessType: '', currency: 'USD',
    moqQty: 1, moqUnit: 'set', onTimeDelivery: null, reorderRate: null, responseRate: '',
    onlineRevenue: '', confidence: 'high', missing: [], origin: 'search',
    capturedAt: new Date().toISOString(), provenance: {},
    priceTiers: [{ minQty: 1, maxQty: null, unitPrice: 12500 }],
    priceTo: 13500,
    products: [{ title: 'Commercial logo Hat', from: 12500, to: 13500, currency: 'USD' }],
  },
];

/** The real thing: whatever tools/real-page-test.mjs last extracted from a
 *  saved Alibaba page, put through the same record pipeline the extension uses.
 *  No invented fixture — if the extractor breaks, this panel breaks visibly. */
const REAL_CAPTURE = (() => {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'docs', 'fixtures', 'real-capture-sample.json'), 'utf8'));
    return raw.candidates.slice(0, 6).map((c) => ({
      ...c, origin: 'search', capturedAt: new Date().toISOString(),
    }));
  } catch {
    return [];
  }
})();

const SETTINGS = { targetQty: 2 };

/** Rows as a Suppliers results page produces them: no price ladder. */
const SEARCH_RECORDS = [
  {
    productId: 'aaryan', title: 'Plus Size Mens T-Shirts', sourceUrl: 'https://www.alibaba.com/product-detail/_1600000000000.html',
    companyName: 'AARYAN SOURCING', country: 'BD', yearsOnPlatform: 9, verifiedSupplier: true,
    tradeAssurance: false, businessType: '', currency: '', moqQty: 1000, moqUnit: 'pieces',
    onTimeDelivery: 95, reorderRate: 42, responseRate: '1h', onlineRevenue: '$50K - $100K',
    confidence: 'high', missing: [], origin: 'search', capturedAt: new Date().toISOString(),
    provenance: {}, priceTiers: [],
  },
  {
    productId: 'guangzhou', title: 'School Uniform Shirts', sourceUrl: 'https://www.alibaba.com/product-detail/_1600000000001.html',
    companyName: 'Guangzhou Smart Mfg', country: 'CN', yearsOnPlatform: 7, verifiedSupplier: true,
    tradeAssurance: true, businessType: 'Manufacturer', currency: 'USD', moqQty: 200, moqUnit: 'pieces',
    onTimeDelivery: 92, reorderRate: 55, responseRate: '2h', onlineRevenue: '',
    confidence: 'high', missing: [], origin: 'search', capturedAt: new Date().toISOString(),
    provenance: {}, priceTiers: [{ minQty: 1, maxQty: null, unitPrice: 12.5 }],
  },
  {
    productId: 'ningbo', title: 'Oxford Dress Shirt', sourceUrl: 'https://www.alibaba.com/product-detail/_1600000000002.html',
    companyName: 'Ningbo Textile Group', country: 'CN', yearsOnPlatform: 15, verifiedSupplier: false,
    tradeAssurance: false, businessType: 'Manufacturer', currency: 'USD', moqQty: 500, moqUnit: 'pieces',
    onTimeDelivery: 88, reorderRate: 31, responseRate: '4h', onlineRevenue: '$100K - $500K',
    confidence: 'high', missing: [], origin: 'search', capturedAt: new Date().toISOString(),
    provenance: {}, priceTiers: [{ minQty: 1, maxQty: null, unitPrice: 9.8 }],
  },
];

/** Minimal chrome.* stub: enough storage and messaging for the panel. */
const chromeMock = (records, settings) => `
  const RECORDS = ${JSON.stringify(records)};
  const SETTINGS = ${JSON.stringify(settings)};
  const store = { 'asc:records': RECORDS, 'asc:settings': SETTINGS };
  const listeners = [];
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        const reply = (m) => setTimeout(() => cb && cb(m), 0);
        if (msg.type === 'GET_TAB_CONTEXT') {
          // Same rules as src/lib/probe.js classifyUrl, kept inline so the
          // harness can run outside the extension.
          const u = String(globalThis.__tabUrl || '');
          let kind = 'unknown';
          try {
            const parsed = new URL(u);
            const path = parsed.pathname;
            const landing = /^\\/cps\\//i.test(path);
            if (!/(^|\\.)alibaba\\.com$/i.test(parsed.hostname)) kind = 'offsite';
            else if (/\\/product-detail\\//i.test(path) || /showproduct\\.html/i.test(path)) kind = 'product';
            else if (!landing && (/^\\/(trade\\/)?search\\b/i.test(path) || /[?&](SearchText|SearchScene)=/i.test(u) || /^\\/(companies?|suppliers?)\\//i.test(path))) kind = 'search';
            else if (path === '/' || path === '' || landing) kind = 'home';
          } catch {}
          return reply({ ok: true, url: u, kind, live: true, seenAt: Date.now(), pendingResult: globalThis.__pending || null });
        }
        if (msg.type === 'GET_STATE') return reply({ ok: true, records: RECORDS, settings: SETTINGS });
        if (msg.type === 'SET_SETTINGS') { Object.assign(SETTINGS, msg.patch); return reply({ ok: true, settings: SETTINGS }); }
        if (msg.type === 'GET_DIAGNOSTICS') {
          return reply({ ok: true, diagnostics: { savedAt: '2026-01-01T00:00:00.000Z', blobName: 'detailData', blobVia: 'source', foundAnyBlob: true, sawLd: true, blobTruncated: false, tierCounts: { 'blob:path': 11, 'blob:fuzzy': 2 }, keyPaths: ['globalData.product.subject', 'componentsVO.priceModule.productLadderPrices'], layers: [] } });
        }
        if (msg.type === 'EXPORT') { globalThis.__lastExport = msg; return reply({ ok: true, chars: 100 }); }
        return reply({ ok: true });
      },
      onMessage: { addListener(fn) { listeners.push(fn); } },
    },
    storage: {
      local: {
        get(k, cb) { const o = {}; (Array.isArray(k) ? k : [k]).forEach((key) => { if (key in store) o[key] = store[key]; }); cb && cb(o); },
        set(o, cb) { Object.assign(store, o); cb && cb(); },
        remove(k, cb) { delete store[k]; cb && cb(); },
      },
    },
  };
  globalThis.__notify = (m) => listeners.forEach((fn) => fn(m));
`;

/** Scenarios rendered as separate screenshots. */
const PRODUCT_URL = 'https://www.alibaba.com/product-detail/_1601918386232.html';
const SEARCH_URL = 'https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=man+shirt';
const HOME_URL = 'https://offer.alibaba.com/cps/dngh1l8c7bm-cps';
const OFFSITE_URL = 'https://www.google.com/search?q=supplier';

const SCENARIOS = [
  { name: '01-matrix-2qty', width: 420, height: 900, records: RECORDS, settings: SETTINGS, expectVisible: 3 },
  { name: '02-matrix-narrow', width: 320, height: 900, records: RECORDS, settings: SETTINGS, expectVisible: 2 },
  { name: '03-matrix-wide', width: 900, height: 700, records: RECORDS, settings: { targetQty: 5 }, expectVisible: 3 },
  { name: '03b-matrix-search-origin', width: 420, height: 900, records: SEARCH_RECORDS, settings: SETTINGS, expectVisible: 3 },
  { name: '03c-matrix-supplier-card', width: 460, height: 1100, records: SUPPLIER_RECORDS, settings: { targetQty: 1 }, expectVisible: 3 },
  {
    name: '03d-matrix-real-capture', width: 900, height: 1250,
    records: REAL_CAPTURE, settings: { targetQty: 100 },
    expectVisible: REAL_CAPTURE.length,
  },
  {
    // One saved filter is on: the panel must SAY which, not just hide rows.
    name: '03e-real-capture-filter-on', width: 540, height: 760,
    records: REAL_CAPTURE, settings: { targetQty: 100, manufacturersOnly: true },
    expectVisible: 1, expectColumns: REAL_CAPTURE.filter((r) => r.businessType === 'Manufacturer').length,
  },
  { name: '04-empty-unknown', width: 420, height: 900, records: [], settings: SETTINGS, tabUrl: OFFSITE_URL },
  { name: '04b-empty-search', width: 420, height: 900, records: [], settings: SETTINGS, tabUrl: SEARCH_URL },
  { name: '04c-empty-home', width: 420, height: 900, records: [], settings: SETTINGS, tabUrl: HOME_URL },
  {
    name: '05-punish-banner', width: 420, height: 520, records: RECORDS, settings: SETTINGS, expectVisible: 3,
    banner: { tone: 'danger', icon: '×', title: 'Alibaba is showing a verification screen',
      text: 'Alibaba asked for a CAPTCHA before showing the page, so there is no product data to read. Nothing was saved. Solve the check in the tab, then press Re-scan.', action: 'Re-scan' },
  },
  {
    name: '06-filters-open', width: 420, height: 900, records: RECORDS, settings: SETTINGS,
    openFilters: true, expectVisible: 3,
  },
];

const problems = [];

const { server, origin } = await serve();
const panelUrl = `${origin}/src/panel/sidepanel.html`;

const browser = await chromium.launch();
for (const s of SCENARIOS) {
  const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  // Passed as source text: addInitScript serialises functions, and the mock
  // closes over Node-side values that do not exist in the page.
  await page.addInitScript({
    content: `globalThis.__tabUrl = ${JSON.stringify(s.tabUrl || PRODUCT_URL)};\n${chromeMock(s.records, s.settings)}`,
  });
  await page.goto(panelUrl, { waitUntil: 'load' });
  await page.waitForTimeout(250);

  if (s.openFilters) {
    await page.click('#btnSettings');
    await page.waitForTimeout(120);
  }
  if (s.banner) {
    await page.evaluate((b) => {
      document.getElementById('banner').className = `banner tone-${b.tone}`;
      document.getElementById('bannerIcon').textContent = b.icon;
      document.getElementById('bannerTitle').textContent = b.title;
      document.getElementById('bannerText').textContent = b.text;
      const act = document.getElementById('bannerAction');
      act.textContent = b.action;
      act.hidden = false;
      document.getElementById('banner').hidden = false;
    }, s.banner);
    await page.waitForTimeout(120);
  }

  // Layout facts worth asserting rather than eyeballing.
  const facts = await page.evaluate(() => {
    const doc = document.documentElement;
    const cells = [...document.querySelectorAll('.matrix thead th:not(.col-label)')];
    // A column only counts as "visible" if the whole of it is on screen: a
    // comparison you have to scroll sideways to read is not a comparison.
    const visible = cells.filter((c) => {
      const r = c.getBoundingClientRect();
      return r.left >= 0 && r.right <= window.innerWidth + 1;
    }).length;
    const priceCell = document.querySelector('.row-key td');
    const links = document.querySelectorAll('.prod-link');
    return {
      horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
      pageScrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      supplierColumns: cells.length,
      fullyVisibleColumns: visible,
      emptyVisible: !document.getElementById('empty').hidden,
      matrixVisible: !document.getElementById('wrap').hidden,
      footerVisible: !document.getElementById('ftr').hidden,
      bestTagged: !!document.querySelector('.best-tag'),
      bestCells: document.querySelectorAll('.cell-best').length,
      lowConfidenceBadges: document.querySelectorAll('.flag-warn').length,
      sparklines: document.querySelectorAll('svg.spark').length,
      workingLinks: links.length,
      escapedHtmlLeak: document.body.textContent.includes('<a class='),
      firstPrice: priceCell ? priceCell.textContent.trim() : null,
      emptyTitle: document.getElementById('emptyTitle').textContent.trim(),
      emptyText: document.getElementById('emptyText').textContent.trim(),
      ctxAction: document.getElementById('ctxAction').hidden ? null
        : document.getElementById('ctxAction').textContent.trim(),
      ctxNote: document.getElementById('ctxNote').hidden ? null
        : document.getElementById('ctxNote').textContent.trim(),
      note: document.getElementById('fxNote').hidden
        ? null : document.getElementById('fxNote').textContent.trim(),
      rowLabels: [...document.querySelectorAll('.matrix tbody th')].map((t) => t.textContent.trim()),
    };
  });

  await page.screenshot({ path: join(outDir, `${s.name}.png`) });
  await ctx.close();

  const line = `${s.name.padEnd(20)} cols=${facts.supplierColumns} visible=${facts.fullyVisibleColumns}` +
    ` overflow=${facts.horizontalOverflow} best=${facts.bestTagged} warn=${facts.lowConfidenceBadges}` +
    ` spark=${facts.sparklines} links=${facts.workingLinks} errors=${errors.length}`;
  console.log(line);

  if (errors.length) {
    problems.push(`${s.name}: console errors -> ${errors.join(' | ')}`);
  }
  if (facts.escapedHtmlLeak) problems.push(`${s.name}: escaped HTML leaked into the page as text`);
  if (s.records.length === 0) {
    if (!facts.emptyVisible) problems.push(`${s.name}: empty state not shown`);
    if (facts.ctxAction === null && s.tabUrl !== OFFSITE_URL) {
      problems.push(`${s.name}: no action offered on ${s.tabUrl}`);
    }
    console.log('   empty      :', JSON.stringify(facts.emptyTitle), '|', facts.ctxAction, '|', facts.ctxNote);
  } else {
    if (!facts.matrixVisible) problems.push(`${s.name}: matrix not shown`);
    if (!facts.footerVisible) problems.push(`${s.name}: footer not shown`);
    const expectedCols = s.expectColumns ?? s.records.length;
    if (facts.supplierColumns !== expectedCols) {
      problems.push(`${s.name}: expected ${expectedCols} supplier columns, got ${facts.supplierColumns}`);
    }
    // A scenario may legitimately show no best marker when a filter removes the
    // cheapest row, so only assert it where the cheapest row is still visible.
    if (facts.supplierColumns > 1 && !facts.bestTagged) {
      problems.push(`${s.name}: no best-price marker`);
    }
    if (facts.horizontalOverflow) problems.push(`${s.name}: panel scrolls horizontally (${facts.pageScrollWidth} > ${facts.clientWidth})`);
    if (s.expectVisible && facts.fullyVisibleColumns < s.expectVisible) {
      problems.push(`${s.name}: only ${facts.fullyVisibleColumns} of ${facts.supplierColumns} supplier columns fit on screen, expected at least ${s.expectVisible}`);
    }
  }
  if (s.name === '01-matrix-2qty') {
    console.log('   price row :', facts.firstPrice);
    console.log('   note      :', facts.note);
    console.log('   row labels:', facts.rowLabels.join(' | '));
    console.log('   prices    :', await page.evaluate(() =>
      [...document.querySelectorAll('.row-key td')].map((td) => td.textContent.trim())).catch(() => []));
  }
}

await browser.close();
server.close();

console.log('');
if (problems.length) {
  console.log('PROBLEMS');
  for (const p of problems) console.log(' -', p);
  process.exit(1);
}
console.log(`all ${SCENARIOS.length} scenarios rendered with no console errors, no page-level horizontal overflow, and every state visible`);
console.log(`screenshots in ${outDir}`);
