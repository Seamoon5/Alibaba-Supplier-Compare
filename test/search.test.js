/**
 * search.test.js — the results-page capture, and the URL classification that
 * decides which extractor runs.
 *
 * The DOM here is a hand-built stand-in shaped like the cards Alibaba renders on
 * a suppliers search: a company name, a years badge, credential chips, response
 * time, and a strip of product links each with its own minimum order.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { harvestSearchPage } from '../src/extract/search.js';
import { classifyUrl, messageForUrl, URL_HINTS } from '../src/lib/probe.js';

// ------------------------------------------------------- a minimal fake DOM

class Node {
  constructor(tag, { text = '', attrs = {}, children = [] } = {}) {
    this.tagName = tag.toUpperCase();
    this.innerText = text;
    this.textContent = text;
    this.attrs = attrs;
    this.children = children;
    this.parentElement = null;
    for (const c of children) c.parentElement = this;
  }
  get href() { return this.attrs.href || ''; }
  getAttribute(name) { return this.attrs[name] !== undefined ? this.attrs[name] : null; }
  getBoundingClientRect() { return { height: 100, width: 200, top: 0, left: 0 }; }
  querySelector(sel) { return this.querySelectorOne(sel); }
  /** Single-selector descendant search. */
  _findAll(sel) {
    const out = [];
    const visit = (n) => {
      for (const c of n.children) {
        if (c.matches(sel)) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }
  querySelectorAll(sel) {
    // Real selectors are frequently comma-separated; support that. Split here
    // and delegate to the single-selector search, never to this method.
    const out = [];
    for (const one of String(sel).split(',').map((s) => s.trim()).filter(Boolean)) {
      for (const n of this._findAll(one)) if (!out.includes(n)) out.push(n);
    }
    return out;
  }
  querySelectorOne(sel) { return this.querySelectorAll(sel)[0] || null; }
  matches(sel) {
    const attr = sel.match(/^(\w+)\[(\w+)\*="([^"]*)"\]$/);
    if (attr) {
      const [, tag, name, needle] = attr;
      if (this.tagName !== tag.toUpperCase()) return false;
      return String(this.attrs[name] || '').includes(needle);
    }
    if (/^\w+$/.test(sel)) return this.tagName === sel.toUpperCase();
    return false;
  }
}

/** Build a card element from a spec: {name, meta, productLinks}. */
function card({ name, meta = '', links = [] }) {
  const productNodes = links.map((l, i) => new Node('a', {
    text: l.title,
    attrs: { href: `https://www.alibaba.com/product-detail/_${1600000000000 + i}.html` },
  }));
  const heading = new Node('h3', { text: name });
  const body = new Node('div', { text: `${name}\n${meta}`, children: [heading, ...productNodes] });
  return new Node('div', { text: `${name}\n${meta}`, children: [body] });
}

// ------------------------------------------------- the real supplier card
//
// Built from a screenshot of a live Alibaba suppliers search. This is the shape
// that broke v1.0: a COMPANY card holding a credential strip, a price-tier box
// ("US$5,000 Min. order: 1 set") and a strip of product tiles with their own
// price ranges. Reading it with the per-offer strategy put "US$5,000" in the
// supplier column, "US" in the country column, and no price at all in the rest.

/**
 * @param {object} spec
 * @param {string} spec.company  company name as rendered in the header
 * @param {string} [spec.companyHref] present on the real page; omit to test fallback
 * @param {string[]} spec.header extra header lines (flag code, badges)
 * @param {[string,string][]} spec.tiles [title, priceText] pairs
 * @param {string} [spec.metrics] the On-time / Reorder / Response / Revenue block
 * @param {string} [spec.tierBox] the "Min. order" price-tier box
 */
function supplierCard({
  company,
  companyHref,
  header = [],
  tiles = [],
  metrics = '',
  tierBox = '',
}) {
  const children = [];
  if (companyHref) {
    children.push(new Node('a', { text: company, attrs: { href: companyHref } }));
  }
  const headerText = [company, ...header].join('\n');
  children.push(new Node('div', { text: headerText }));
  if (metrics) children.push(new Node('div', { text: metrics }));
  if (tierBox) children.push(new Node('div', { text: tierBox }));

  tiles.forEach(([title, price], i) => {
    children.push(new Node('div', {
      text: `${title}\n${price}`,
      children: [new Node('a', {
        text: title,
        attrs: { title, href: `https://www.alibaba.com/product-detail/_17000${i}0000.html` },
      })],
    }));
  });

  const all = [headerText, metrics, tierBox, ...tiles.map(([t, p]) => `${t}\n${p}`)]
    .filter(Boolean).join('\n');
  return new Node('div', { text: all, children });
}

const METRICS = [
  'Matches 2/2 requirements',
  'On-time delivery 100%',
  'Reorder rate -',
  'Response time <1h',
  'Online revenue $2M-$5M',
].join('\n');

const LIVE_CARD = {
  company: 'Zhuji Yuanheng Sewing Equipment Co., Ltd.',
  companyHref: 'https://www.alibaba.com/company-detail/zhujiyuanheng.html',
  header: ['Zhejiang. CN', '1yr'],
  metrics: METRICS,
  tierBox: 'US$5,000\nMin. order: 1 set',
  tiles: [
    ['DISEN Large Format Single Head Computer', 'US$1,250-4,500'],
    ['High Quality Commercial logo Hat', 'US$6,900-7,200'],
    ['Shenzhen Hoos NZ Automatic', 'US$12,500-13,500'],
  ],
};

test('the live supplier card yields the company, not its price box', () => {
  const url = 'https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=embroidery+chenille+machine';
  const out = withDom([supplierCard(LIVE_CARD)], url, () => harvestSearchPage());
  assert.equal(out.scene, 'suppliers');
  assert.equal(out.count, 1);

  const r = out.candidates[0];
  assert.equal(r.companyName, 'Zhuji Yuanheng Sewing Equipment Co., Ltd.');
  assert.equal(r.country, 'CN');
  assert.equal(r.yearsOnPlatform, 1);
  assert.equal(r.onTimeDelivery, 100);
  assert.equal(r.responseRate, '<1h');
  assert.equal(r.onlineRevenue, '$2M-$5M');
});

test('the price comes from the product tile, not from "US$5,000 Min. order: 1 set"', () => {
  const url = 'https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=embroidery+chenille+machine';
  const out = withDom([supplierCard(LIVE_CARD)], url, () => harvestSearchPage());
  const r = out.candidates[0];

  assert.equal(r.currency, 'USD');
  assert.equal(r.priceTiers.length, 1);
  assert.equal(r.priceTiers[0].unitPrice, 1250, 'rank on the cheapest published offer');
  assert.equal(r.priceTo, 4500, 'the high end of the published range is kept, not discarded');
  assert.equal(out.pricedCount, 1, 'a supplier with a published price is not counted as unpriced');
});

test('the product strip is kept so you can see what else the factory makes', () => {
  const url = 'https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=embroidery+chenille+machine';
  const out = withDom([supplierCard(LIVE_CARD)], url, () => harvestSearchPage());
  const r = out.candidates[0];

  assert.equal(r.products.length, 3);
  assert.deepEqual(r.products.map((p) => p.from), [1250, 6900, 12500], 'cheapest first');
  assert.equal(r.products[0].title, 'DISEN Large Format Single Head Computer');
  assert.equal(r.products[0].to, 4500);
  assert.match(r.sourceUrl, /product-detail/);
  assert.equal(r.title, 'DISEN Large Format Single Head Computer');
});

test('"US$" is never mistaken for the country "US"', () => {
  const url = 'https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=shirt';
  const cases = [
    [supplierCard({ ...LIVE_CARD, header: ['CN'] }), 'CN'],
    // Only a price to go on: the honest answer is "unknown", not "United States".
    [
      supplierCard({
        company: 'Nameless Trading Co',
        header: ['3 yrs'],
        tierBox: 'Min. order: 1 set',
        tiles: [['Widget', 'US$900-1,200']],
      }),
      '',
    ],
  ];
  for (const [node, expected] of cases) {
    const out = withDom([node], url, () => harvestSearchPage());
    assert.equal(out.candidates[0].country, expected, `country for ${out.candidates[0].companyName}`);
  }
});

test('a company name ending in a two-letter code keeps every letter', () => {
  // Regression guard for an alternation that was not grouped: "SOURCING" was
  // being truncated to "SOURCG" because "IN" matched as its own alternative.
  const url = 'https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=shirt';
  const out = withDom([supplierCard({ ...LIVE_CARD, company: 'AARYAN SOURCING', companyHref: 'https://www.alibaba.com/company-detail/aaryan.html' })], url, () => harvestSearchPage());
  assert.equal(out.candidates[0].companyName, 'AARYAN SOURCING');
});

test('several company cards, with credentials of their own, become one row each', () => {
  const url = 'https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=machine';
  const a = supplierCard(LIVE_CARD);
  const b = supplierCard({
    company: 'Guangzhou Disen Electronic Technology Co., Ltd',
    companyHref: 'https://www.alibaba.com/company-detail/disen.html',
    header: ['CN', '6 yrs', 'Verified'],
    tiles: [['DISEN Single Head Computer', 'US$6,900-7,200']],
  });
  const out = withDom([a, b], url, () => harvestSearchPage());
  assert.equal(out.count, 2);

  const dis = out.candidates.find((c) => /Disen/.test(c.companyName));
  assert.equal(dis.verifiedSupplier, true, 'the Verified badge in the header is read');
  assert.equal(dis.yearsOnPlatform, 6);
  assert.equal(dis.priceTiers[0].unitPrice, 6900);
});

test('the same card still works when the company name is not a link', () => {
  const url = 'https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=machine';
  const out = withDom([supplierCard({ ...LIVE_CARD, companyHref: undefined })], url, () => harvestSearchPage());
  assert.equal(out.count, 1);
  assert.equal(out.candidates[0].companyName, 'Zhuji Yuanheng Sewing Equipment Co., Ltd.');
  assert.equal(out.candidates[0].priceTiers[0].unitPrice, 1250);
});

function install(nodes, url) {
  const saved = { document: globalThis.document, location: globalThis.location };
  const body = new Node('body', { text: nodes.map((n) => n.innerText).join('\n'), children: nodes });
  globalThis.document = {
    title: 'Search results',
    body,
    querySelectorAll: (sel) => body.querySelectorAll(sel),
  };
  globalThis.location = { href: url, pathname: new URL(url).pathname };
  return () => {
    globalThis.document = saved.document;
    globalThis.location = saved.location;
  };
}

const withDom = (nodes, url, fn) => {
  const restore = install(nodes, url);
  try { return fn(); } finally { restore(); }
};

// ------------------------------------------------------------ URL routing

test('the real supplier search URL from a live page is routed to the search extractor', () => {
  // Regression: a one-shot activeTab grant from the toolbar click does not
  // survive a navigation, so Re-scan could not read this URL, fell through to
  // "unknown", and reported "Not a product page" on a search results page.
  const LIVE = 'https://www.alibaba.com/search/page?spm=a2700.prosearch.taTop.2.1e1467afC310FV' +
    '&SearchScene=suppliers&pro=true&SearchText=man+shirt&from=pcDetailHeader';
  assert.equal(classifyUrl(LIVE), 'search');

  const HOME = 'https://offer.alibaba.com/cps/dngh1l8c7bm-cps';
  assert.equal(classifyUrl(HOME), 'home');
});

test('classifyUrl separates the pages that need different handling', () => {
  assert.equal(classifyUrl('https://www.alibaba.com/product-detail/_1601918386232.html'), 'product');
  assert.equal(classifyUrl('https://www.alibaba.com/product-detail/_123.html?spm=a'), 'product');
  assert.equal(classifyUrl('https://m.alibaba.com/product-detail/_123.html'), 'product');
  assert.equal(classifyUrl('https://www.alibaba.com/'), 'home');
  assert.equal(classifyUrl('https://offer.alibaba.com/cps/dngh1l8c7bm-cps'), 'home');
  assert.equal(
    classifyUrl('https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=man+shirt'),
    'search',
  );
  assert.equal(classifyUrl('https://www.alibaba.com/trade/search?SearchText=shirt'), 'search');
  assert.equal(classifyUrl('https://www.google.com/search?q=x'), 'offsite');
  assert.equal(classifyUrl('not a url'), 'unknown');
  assert.equal(classifyUrl(''), 'unknown');
});

test('every non-product page gets an explanation, never silence', () => {
  for (const url of [
    'https://www.alibaba.com/',
    'https://www.alibaba.com/search/page?SearchText=x',
    'https://www.google.com/',
    'https://www.alibaba.com/member/company_profile.html',
  ]) {
    const msg = messageForUrl(url);
    assert.ok(msg, `no message for ${url}`);
    assert.ok(msg.title.length > 5, `weak title for ${url}`);
    assert.ok(msg.body.length > 30, `weak body for ${url}`);
  }
  assert.equal(messageForUrl('https://www.alibaba.com/product-detail/_1.html'), null,
    'a product page needs no refusal message');
});

test('the search hint tells the user what will actually happen', () => {
  assert.match(URL_HINTS.search.body, /add every supplier shown on this results page at once/i);
  assert.match(URL_HINTS.home.body, /search/i);
});

// ------------------------------------------------------- supplier results

test('captures a supplier card with its metrics', () => {
  const url = 'https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=man+shirt';
  const node = card({
    name: 'AARYAN SOURCING',
    meta: 'Dhaka BD · 9 yrs · Verified Multispecialty Supplier\n' +
      'On-time delivery 95%\nReorder rate 42%\nResponse time ≤1h\nOnline revenue $50K - $100K\n' +
      'Min. order: 1000 pieces',
    links: [{ title: 'Plus Size Mens Shirts' }],
  });

  const out = withDom([node], url, () => harvestSearchPage());
  assert.equal(out.page, 'search');
  assert.equal(out.scene, 'suppliers');
  assert.equal(out.count, 1);

  const r = out.candidates[0];
  assert.equal(r.companyName, 'AARYAN SOURCING');
  assert.equal(r.yearsOnPlatform, 9);
  assert.equal(r.verifiedSupplier, true);
  assert.equal(r.onTimeDelivery, 95);
  assert.equal(r.reorderRate, 42);
  assert.equal(r.responseRate, '≤1h');
  assert.equal(r.onlineRevenue, '$50K - $100K');
  assert.equal(r.country, 'BD');
  assert.equal(r.moqQty, 1000);
  assert.equal(r.moqUnit, 'pieces');
  assert.match(r.sourceUrl, /\/product-detail\/_1600000000000\.html$/);
});

test('a supplier card with several product links counts as one supplier', () => {
  const url = 'https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=shirt';
  const node = card({
    name: 'Guangzhou Smart Drinkware Mfg',
    meta: 'Guangdong CN · 14 yrs\nOn-time delivery 92%\nMin. order: 500 pieces',
    links: [{ title: 'Flask A' }, { title: 'Flask B' }, { title: 'Flask C' }],
  });

  const out = withDom([node], url, () => harvestSearchPage());
  assert.equal(out.count, 1, 'three products from one company is one supplier');
  assert.equal(out.candidates[0].companyName, 'Guangzhou Smart Drinkware Mfg');
});

test('two supplier cards become two records', () => {
  const url = 'https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=shirt';
  const a = card({ name: 'Alpha Trading', meta: 'China · 5 yrs\nMin. order: 10 pieces', links: [{ title: 'P1' }] });
  const b = card({ name: 'Beta Garments', meta: 'India · 11 yrs\nMin. order: 50 pieces', links: [{ title: 'P2' }] });

  const out = withDom([a, b], url, () => harvestSearchPage());
  assert.equal(out.count, 2);
  const names = out.candidates.map((c) => c.companyName).sort();
  assert.deepEqual(names, ['Alpha Trading', 'Beta Garments']);
});

test('a price on a product card becomes one flat tier so ranking still works', () => {
  const url = 'https://www.alibaba.com/search/page?SearchScene=products&SearchText=shirt';
  const node = card({
    name: 'Guangzhou Garment Factory',
    meta: 'Guangdong CN · 6 yrs\nUSD 12.50 - 14.00\nMin. order: 200 pieces',
    links: [{ title: 'Cotton T-Shirt' }],
  });

  const out = withDom([node], url, () => harvestSearchPage());
  assert.equal(out.scene, 'products');
  const r = out.candidates[0];
  assert.equal(r.currency, 'USD');
  assert.equal(r.priceTiers.length, 1);
  assert.equal(r.priceTiers[0].unitPrice, 12.5);
});

test('a currency-less card gets no price rather than a wrong one', () => {
  const url = 'https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=shirt';
  const node = card({ name: 'No Price Co', meta: 'China · 3 yrs\nMin. order: 5 pieces', links: [{ title: 'X' }] });
  const out = withDom([node], url, () => harvestSearchPage());
  assert.deepEqual(out.candidates[0].priceTiers, []);
  assert.equal(out.candidates[0].currency, '');
});

test('an empty results page reports zero rather than inventing a supplier', () => {
  const url = 'https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=zzz';
  const out = withDom([], url, () => harvestSearchPage());
  assert.equal(out.ok, false);
  assert.equal(out.count, 0);
  assert.deepEqual(out.candidates, []);
});

test('page text unrelated to a card is ignored', () => {
  const url = 'https://www.alibaba.com/search/page?SearchText=shirt';
  const node = new Node('div', {
    text: 'Filters\nAI Mode\nSuppliers\nWorldwide\nNo results found',
    children: [],
  });
  const out = withDom([node], url, () => harvestSearchPage());
  assert.equal(out.count, 0);
});

test('records from a search page are trusted without demanding a price ladder', async () => {
  const { makeRecord } = await import('../src/lib/schema.js');
  const supplier = makeRecord({
    productId: 'x1', companyName: 'Alpha', origin: 'search',
    moqQty: 100, priceTiers: [],
  });
  assert.equal(supplier.confidence, 'high', 'a supplier card with no price is not partial data');
  assert.deepEqual(supplier.missing, []);

  const product = makeRecord({
    productId: 'x2', companyName: 'Beta', origin: 'product', moqQty: 1, priceTiers: [],
  });
  assert.equal(product.confidence, 'low', 'a product page with no price ladder is incomplete');
  assert.ok(product.missing.includes('priceTiers'));
});
