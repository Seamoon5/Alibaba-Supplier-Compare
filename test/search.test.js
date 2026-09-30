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
  getAttribute(name) {
    return name && name in this.attrs && this.attrs[name] !== undefined ? this.attrs[name] : null;
  }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const i = this.parentElement.children.indexOf(this);
    return this.parentElement.children[i + 1] || null;
  }
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const i = this.parentElement.children.indexOf(this);
    return i > 0 ? this.parentElement.children[i - 1] : null;
  }
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
  /**
   * Supports what the extractor actually uses against Alibaba's real markup:
   * `tag`, `tag[attr]`, `[attr]`, `tag[attr*="x"]` and `tag[attr="v"]`.
   * Class names are hashed per deploy, so nothing here matches on class.
   */
  matches(sel) {
    const attr = sel.match(/^(\w+)?(?:\[([\w-]+)(?:([*^$])?=?"?([^"\]]*)"?|)\])?$/);
    if (!attr) return false;
    const [, tag, name, op, value] = attr;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (!name) return Boolean(tag);
    if (!(name in this.attrs) || this.attrs[name] === null) return false;
    // op is undefined for `[title]` (presence), "" for `[title="v"]` (equality).
    if (op === undefined) return true;
    const actual = String(this.attrs[name]);
    if (op === '*') return actual.includes(value);
    if (op === '^') return actual.startsWith(value);
    if (op === '$') return actual.endsWith(value);
    return actual === value;
  }
}

// ------------------------------------------------------- the real card shape
//
// Built from a page saved with Ctrl+S from a live Alibaba suppliers search
// (https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=caps).
// The structure below is Alibaba's, not ours — including the fact that the
// company name is a <span title="...">, that the country is a flag <img
// alt="countryFlag"> with the code in the next sibling, and that every product
// tile prints its price and its minimum on the same block:
//
//   US$4.20-5.10
//   Min. order: 10 pieces
//
// tools/real-page-test.mjs runs the shipped extractor against that whole saved
// page in a real browser. These fixtures are the fast version of the same
// assertions, so a regression is caught by `npm test` without a browser.

const node = (tag, o) => new Node(tag, o);

function productTile(title, price, moq, id) {
  const href = `https://www.alibaba.com/product-detail/${id}.html`;
  return node('div', {
    text: `${price}\n${moq}`,
    children: [
      node('a', {
        text: `${price}\n${moq}`,
        attrs: { 'data-supplier-card-product': 'true', href },
      }),
    ],
  });
}

/**
 * @param {object} spec
 * @param {string} spec.name          company name as a span title
 * @param {string} [spec.companyId]   goes into data-dot-params
 * @param {boolean} [spec.isFactory]  Alibaba's own factory flag
 * @param {string} [spec.province]    text before the flag, e.g. "Sindh,"
 * @param {string} [spec.country]     code after the flag, e.g. "PK"
 * @param {string} [spec.years]       "2 yrs"
 * @param {string} [spec.rating]      "5.0"
 * @param {string} [spec.reviews]     "(1 review)"
 * @param {string[]} [spec.mainProducts]
 * @param {[string,string,string][]} [spec.tiles] [price, moq, productId]
 * @param {string} [spec.metrics]     the On-time / Reorder / Response / Revenue block
 * @param {string} [spec.chips]       e.g. "Custom Manufacturer"
 */
function supplierCard({
  name,
  companyId,
  isFactory = false,
  province = 'Guangdong,',
  country = 'CN',
  years = '7 yrs',
  rating = '4.8',
  reviews = '(52 reviews)',
  mainProducts = [],
  tiles = [],
  metrics = '',
  chips = '',
}) {
  const dot = {
    companyId: companyId || '123456789',
    isFactory,
    productListCount: tiles.length,
    scene: 'supplier',
  };

  const header = node('div', {
    text: [name, province, country, `${rating}/5`, reviews, years, chips].filter(Boolean).join('\n'),
    children: [
      node('span', { text: name, attrs: { title: name } }),
      node('div', {
        text: `${province}\n${country}`,
        children: [
          node('span', { text: province }),
          node('img', { text: '', attrs: { alt: 'countryFlag', src: 'pk.png' } }),
          node('span', { text: country }),
        ],
      }),
      node('div', {
        text: `${rating}/5`,
        children: [node('span', { text: rating }), node('a', { text: reviews, attrs: { 'data-supplier-card-reviews': 'true' } })],
      }),
      node('div', { text: years, attrs: { 'data-supplier-card-gold-years': 'true' } }),
      node('div', { text: chips }),
    ],
  });

  const children = [
    header,
    node('div', { text: metrics }),
    node('div', {
      text: ['Main products', ...mainProducts].join('\n'),
      children: [
        node('div', { text: 'Main products' }),
        node('div', {
          text: mainProducts.join('\n'),
          children: mainProducts.map((m) => node('div', { text: m, attrs: { title: m } })),
        }),
      ],
    }),
    ...tiles.map(([price, moq, id]) => productTile(id, price, moq, id)),
  ];

  const text = children.map((c) => c.innerText).filter(Boolean).join('\n');
  return node('div', {
    text,
    attrs: {
      'data-supplier-card': 'true',
      'data-dot-params': JSON.stringify(dot),
    },
    children,
  });
}

const METRICS = [
  'On-time delivery',
  '100%',
  'Reorder rate',
  '-',
  'Response time',
  '≤9h',
  'Online revenue',
  '<1k',
].join('\n');

/** The first card of the saved page, as it actually rendered. */
const LIVE_CARD = {
  name: 'al jannat caps',
  companyId: '14066874395',
  isFactory: false,
  province: 'Sindh,',
  country: 'PK',
  years: '2 yrs',
  rating: '5.0',
  reviews: '(1 review)',
  chips: '',
  mainProducts: [
    'Ethnic Hats & Caps',
    'Other Hats & Caps',
    'Traditional Muslim Clothing&Accessories',
    'Prayer Mat',
  ],
  metrics: METRICS,
  tiles: [
    ['US$4.20-5.10', 'Min. order: 10 pieces', 'Premium-Quality-Factory-Made_10000037271758'],
    ['US$4.20-5.10', 'Min. order: 10 pieces', 'Another-Cap-10000036899228'],
    ['US$2.85', 'Min. order: 10 pieces', 'Plain-Kufi_10000036661231'],
    ['US$1.70-2.20', 'Min. order: 10 pieces', 'New-2025-Stylish-Islamic_11000025722248'],
    ['US$1.70-2.20', 'Min. order: 10 pieces', 'Prayer-Cap-10000031226776'],
  ],
};

const SUPPLIERS_URL =
  'https://www.alibaba.com/search/page?SearchScene=suppliers&SearchText=caps';

const capture = (cards, url = SUPPLIERS_URL) => withDom(cards, url, () => harvestSearchPage());

test('one saved supplier card yields the company, the country and the credentials', () => {
  const out = capture([supplierCard(LIVE_CARD)]);
  assert.equal(out.scene, 'suppliers');
  assert.equal(out.count, 1);

  const r = out.candidates[0];
  assert.equal(r.companyName, 'al jannat caps');
  assert.equal(r.country, 'PK');
  assert.equal(r.province, 'Sindh');
  assert.equal(r.yearsOnPlatform, 2);
  assert.equal(r.rating, 5);
  assert.equal(r.reviewCount, 1);
  assert.equal(r.onTimeDelivery, 100);
  assert.equal(r.responseRate, '≤9h');
  assert.equal(r.onlineRevenue, '<1k');
  assert.equal(r.productId, 'co14066874395', 'the company id is a stable identity across re-scans');
  assert.deepEqual(r.mainProducts.slice(0, 2), ['Ethnic Hats & Caps', 'Other Hats & Caps']);
});

test('the price comes from the product tile, never from "Min. order"', () => {
  const r = capture([supplierCard(LIVE_CARD)]).candidates[0];

  assert.equal(r.currency, 'USD');
  assert.equal(r.priceTiers.length, 1);
  assert.equal(r.priceTiers[0].unitPrice, 1.7, 'ranked on the cheapest product the supplier lists');
  assert.equal(r.priceTo, 2.2, 'the high end of that range is kept');
  assert.equal(r.moqQty, 10);
  assert.equal(r.moqUnit, 'pieces');
  assert.equal(r.products.length, 3, 'the two tiles at each identical price collapse into one offer');
  assert.equal(r.title, 'New 2025 Stylish Islamic', 'product title recovered from the URL slug');
  assert.match(r.sourceUrl, /product-detail\/New-2025-Stylish-Islamic_11000025722248/);
});

test('Alibaba\'s own isFactory flag is read, not guessed from keywords', () => {
  const maker = supplierCard({
    ...LIVE_CARD,
    name: 'Dongguan Kaihong Caps And Bags Co., Ltd.',
    companyId: '200932400',
    isFactory: true,
    province: 'Guangdong,',
    chips: 'Custom Manufacturer',
    tiles: [['US$1.89-4', 'Min. order: 50 pieces', 'Kaihong-Cap_10000037271758']],
  });
  const trader = supplierCard({
    ...LIVE_CARD,
    name: 'Guangzhou Better Cap Manufactory (General Partnership)',
    companyId: '200895401',
    isFactory: false,
    chips: '',
    tiles: [['US$0.50-0.54', 'Min. order: 400 pieces', 'Snapback_10000037271758']],
  });

  const out = capture([maker, trader]);
  assert.equal(out.count, 2);
  assert.equal(out.candidates[0].businessType, 'Manufacturer');
  assert.equal(out.candidates[1].businessType, 'Trading Company');
});

test('"US$" is never mistaken for the country "US"', () => {
  // Regression: the country reader used to match the "US" inside "US$5,000",
  // so every supplier on the page came back as being in the United States.
  const priced = supplierCard({ ...LIVE_CARD, tiles: [['US$900-1,200', 'Min. order: 1 piece', 'Widget_1']] });
  assert.equal(capture([priced]).candidates[0].country, 'PK');

  // A card whose only place a code could come from is the price must say
  // "unknown", not invent a country.
  const noFlag = supplierCard({ ...LIVE_CARD, province: '', country: '' });
  delete noFlag.children[0].children[1].children[1].attrs.alt;
  assert.equal(capture([noFlag]).candidates[0].country, '');
});

test('a supplier card without any price is kept, not dropped', () => {
  const r = capture([supplierCard({ ...LIVE_CARD, tiles: [] })]).candidates[0];
  assert.equal(r.companyName, 'al jannat caps');
  assert.deepEqual(r.priceTiers, []);
});

test('a card that renders no data attributes still falls back to its labels', () => {
  // Older layouts have no data-supplier-card marker, so the label path has to
  // keep working or a page change empties the comparison.
  const legacy = node('div', {
    text: 'Legacy Caps Co\nCN\n6 yrs\nOn-time delivery 95%\nReorder rate 42%\nResponse time ≤1h\nUS$12.50-14.00',
    children: [
      node('h3', { text: 'Legacy Caps Co' }),
      node('a', {
        text: 'US$12.50-14.00',
        attrs: { href: 'https://www.alibaba.com/product-detail/_1600000000000.html' },
      }),
    ],
  });

  const out = withDom([legacy], SUPPLIERS_URL, () => harvestSearchPage());
  assert.equal(out.count, 1);
  assert.equal(out.candidates[0].companyName, 'Legacy Caps Co');
  assert.equal(out.candidates[0].priceTiers[0].unitPrice, 12.5);
});

test('an empty results page reports zero rather than inventing a supplier', () => {
  const out = capture([]);
  assert.equal(out.ok, false);
  assert.equal(out.count, 0);
  assert.deepEqual(out.candidates, []);
});

test('page text unrelated to a card is ignored', () => {
  const node2 = node('div', {
    text: 'Filters\nAI Mode\nSuppliers\nWorldwide\nNo results found',
    children: [],
  });
  assert.equal(capture([node2]).count, 0);
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

// ------------------------------------------------------- the products tab
//
// A different page shape: one card per OFFER. Here the price-tier box IS a
// legitimate price source, which is exactly why it must not be treated as a
// company name on the Suppliers tab.

/** An offer card: title link plus a price-tier box and a minimum order. */
function offerCard({ supplier, meta, title = 'Cotton T-Shirt', price = 'USD 12.50 - 14.00' }) {
  const link = node('a', {
    text: title,
    attrs: { href: 'https://www.alibaba.com/product-detail/_1600000000000.html' },
  });
  const inner = node('div', {
    text: `${supplier}\n${meta}\n${price}`,
    children: [
      node('h3', { text: supplier }),
      node('div', { text: price }),
      link,
    ],
  });
  return node('div', { text: inner.innerText, children: [inner] });
}

test('a price on a product card becomes one flat tier so ranking still works', () => {
  const out = withDom(
    [offerCard({ supplier: 'Guangzhou Garment Factory', meta: 'Guangdong CN · 6 yrs\nMin. order: 200 pieces' })],
    'https://www.alibaba.com/search/page?SearchScene=products&SearchText=shirt',
    () => harvestSearchPage(),
  );
  assert.equal(out.scene, 'products');
  assert.equal(out.count, 1);
  const r = out.candidates[0];
  assert.equal(r.companyName, 'Guangzhou Garment Factory');
  assert.equal(r.currency, 'USD');
  assert.equal(r.priceTiers.length, 1);
  assert.equal(r.priceTiers[0].unitPrice, 12.5);
  assert.equal(r.priceTo, 14);
  assert.equal(r.moqQty, 200);
  assert.equal(r.country, 'CN');
});

test('several offer cards become several records', () => {
  const url = 'https://www.alibaba.com/search/page?SearchText=shirt';
  const out = withDom(
    [
      offerCard({ supplier: 'Alpha Trading', meta: 'China · 5 yrs\nMin. order: 10 pieces', price: 'US$3.00-4.00' }),
      offerCard({ supplier: 'Beta Garments', meta: 'India · 11 yrs\nMin. order: 50 pieces', price: 'US$6.00-7.50' }),
    ],
    url,
    () => harvestSearchPage(),
  );
  assert.equal(out.count, 2);
  assert.deepEqual(out.candidates.map((c) => c.companyName).sort(), ['Alpha Trading', 'Beta Garments']);
});

test('a currency-less offer card gets no price rather than a wrong one', () => {
  const out = withDom(
    [offerCard({ supplier: 'No Price Co', meta: 'China · 3 yrs\nMin. order: 5 pieces', price: 'Price on request' })],
    'https://www.alibaba.com/search/page?SearchText=shirt',
    () => harvestSearchPage(),
  );
  assert.deepEqual(out.candidates[0].priceTiers, []);
  assert.equal(out.candidates[0].currency, '');
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
