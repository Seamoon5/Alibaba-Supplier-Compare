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

const SETTINGS = { targetQty: 2 };

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
const SCENARIOS = [
  { name: '01-matrix-2qty', width: 420, height: 900, records: RECORDS, settings: SETTINGS, expectVisible: 3 },
  { name: '02-matrix-narrow', width: 320, height: 900, records: RECORDS, settings: SETTINGS, expectVisible: 2 },
  { name: '03-matrix-wide', width: 900, height: 700, records: RECORDS, settings: { targetQty: 5 }, expectVisible: 3 },
  { name: '04-empty', width: 420, height: 900, records: [], settings: SETTINGS },
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

  await page.addInitScript(chromeMock(s.records, s.settings));
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
  } else {
    if (!facts.matrixVisible) problems.push(`${s.name}: matrix not shown`);
    if (!facts.footerVisible) problems.push(`${s.name}: footer not shown`);
    if (facts.supplierColumns !== s.records.length) {
      problems.push(`${s.name}: expected ${s.records.length} supplier columns, got ${facts.supplierColumns}`);
    }
    if (!facts.bestTagged) problems.push(`${s.name}: no best-price marker`);
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
