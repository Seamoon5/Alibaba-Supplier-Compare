/**
 * harvest.test.js — the MAIN-world function, exercised for real.
 *
 * harvestPage is a single self-contained function because Chrome serialises it
 * before evaluating it in the page. Rather than duplicate its logic for
 * testing, we give it a minimal DOM and run the shipped code.
 *
 * The brace balancer is the part worth testing hardest: a greedy /\{.*\}/
 * grabs the wrong span when a product description contains literal braces,
 * which is common enough to corrupt a record silently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { harvestPage } from '../src/extract/harvest.js';
import { installDom } from './helpers/fakeDom.js';
import { classifyPage, PAGE_MESSAGES } from '../src/lib/probe.js';

function withDom(config, fn) {
  const restore = installDom(config);
  try {
    return fn();
  } finally {
    restore();
  }
}

const script = (body) =>
  `<html><head><script>${body}</script></head><body></body></html>`;

// ------------------------------------------------------- brace balanced slice

test('extracts an object that contains braces inside its strings', () => {
  const payload = {
    componentsVO: { tradeModule: { moqNumber: '3' } },
    description: 'Handle with care: {braces} and "quotes" and a backslash \\ inside',
    nested: { deep: { deeper: { value: 1 } } },
  };
  const html = script(`window.detailData = ${JSON.stringify(payload)};</script>`);

  const out = withDom({ html }, () => harvestPage());

  assert.equal(out.blobVia, 'source', 'no live global, so it must come from the source');
  const blob = out.blob;
  assert.ok(blob, 'a blob should have been parsed out of the source');
  assert.equal(blob.componentsVO.tradeModule.moqNumber, '3');
  assert.ok(blob.description.includes('{braces}'), 'the string survived intact');
  assert.equal(blob.nested.deep.deeper.value, 1);
});

test('stops at the end of its own object even when a later object is larger', () => {
  const payload = { a: { small: 1 } };
  const html = script(
    `window.detailData = ${JSON.stringify(payload)};` +
    `window.__page__data = ${JSON.stringify({ b: { huge: 'x'.repeat(5000) } })};`,
  );
  const out = withDom({ html }, () => harvestPage());
  assert.deepEqual(Object.keys(out.blob), ['a']);
});

test('skips a malformed candidate and tries the next one', () => {
  const good = { globalData: { product: { subject: 'Real Product' } } };
  const html = script(
    `window.__page__data_broken = { not json at all ;;; };\n` +
    `window.detailData = ${JSON.stringify(good)};`,
  );
  const out = withDom({ html }, () => harvestPage());
  assert.equal(out.blob.globalData.product.subject, 'Real Product');
});

test('survives a single quoted assignment and an escaped quote', () => {
  const html = script(`window.detailData = {"name":"it's a \\"quoted\\" name","n":2};`);
  const out = withDom({ html }, () => harvestPage());
  assert.equal(out.blob.n, 2);
  assert.ok(out.blob.name.includes('quoted'));
});

test('reports no blob when there is no blob, rather than throwing', () => {
  const out = withDom({ html: '<html><body>nothing here</body></html>' }, () => harvestPage());
  assert.equal(out.blob, null);
  assert.equal(out.blobName, null);
  assert.deepEqual(out.keyPaths, []);
});

// ---------------------------------------------------------- punish detection

test('detects the BaXIA punish interstitial by its markers', () => {
  const html = `<html><head>
    <script src="//g.alicdn.com/sd/punish/0.0.1/qrcode.min.js"></script>
    <script src="//g.alicdn.com/AWSC/CAPTCHA/0.0.1/awsc.js"></script>
    </head><body><punish-component />
    <script>window._config_={"NCTOKENSTR":"abc","PATH":"/_____tmd_____/verify/"};</script>
    </body></html>`;

  const out = withDom({
    html, url: 'https://www.alibaba.com/product-detail/_1601918386232.html',
    title: 'Alibaba',
  }, () => harvestPage());

  assert.ok(out.punishMarker, 'a punish marker must be reported');
  assert.equal(out.blob, null, 'the blob must not be harvested from a punish page');
});

test('every known punish marker is recognised by the classifier', () => {
  for (const marker of ['punish-component', 'awsc.js', 'baxiaCommon.js', 'NCTOKENSTR', '_____tmd_____', 'x5secdata']) {
    const verdict = classifyPage({
      html: `<html><head><script src="//g.alicdn.com/${marker}"></script></head></html>`,
      title: 'Alibaba',
      url: 'https://www.alibaba.com/product-detail/_1.html',
    });
    assert.equal(verdict, 'punish', `marker ${marker} should classify as punish`);
  }
});

test('a genuine product page is not mistaken for a block', () => {
  const verdict = classifyPage({
    html: '<html><body><h1>3 Head Chenille Machine</h1></body></html>',
    title: '3 Head Chenille Machine - Alibaba',
    url: 'https://www.alibaba.com/product-detail/_1601918386232.html',
  });
  assert.equal(verdict, 'ok');
});

test('a search page is rejected with an explanation', () => {
  const verdict = classifyPage({
    html: '<html><body>search results</body></html>',
    title: 'Alibaba',
    url: 'https://www.alibaba.com/trade/search?SearchText=chenille',
  });
  assert.equal(verdict, 'not-product');
  assert.ok(PAGE_MESSAGES['not-product'].body.length > 20);
});

// ------------------------------------------------------------------ pruning

test('prunes long strings but keeps every key name', () => {
  const payload = {
    keepMe: 'short',
    description: 'x'.repeat(5000),
    deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: { m: 'too deep' } } } } } } } } } } } } },
  };
  const html = script(`window.detailData = ${JSON.stringify(payload)};`);
  const out = withDom({ html }, () => harvestPage());

  assert.equal(out.blob.keepMe, 'short');
  assert.ok(out.blob.description.length < 500, 'the long string is truncated');
  // prune() recurses with depth+1 per level and stops above 12.
  assert.deepEqual(out.blob.deep.a.b.c.d.e.f.g.h.i.j.k, {},
    'the level at the limit is kept but its children are dropped');
  assert.equal(out.blob.deep.a.b.c.d.e.f.g.h.i.j.k.l, undefined, 'past the limit');
});

test('keyPaths lists the paths the diagnostic snapshot needs', () => {
  const payload = { globalData: { product: { productId: '1', subject: 'x' } } };
  const html = script(`window.detailData = ${JSON.stringify(payload)};`);
  const out = withDom({ html }, () => harvestPage());

  assert.ok(out.keyPaths.includes('globalData'));
  assert.ok(out.keyPaths.includes('globalData.product'));
  assert.ok(out.keyPaths.includes('globalData.product.productId'));
});

test('returns a live global when one is already assigned', () => {
  const restore = installDom({ html: '<html><body></body></html>' });
  try {
    // Simulate the page having already assigned the global.
    globalThis.window.detailData = { componentsVO: { companyModule: { companyName: 'Live Co.' } } };
    const out = harvestPage();
    assert.equal(out.blobVia, 'global');
    assert.equal(out.blob.componentsVO.companyModule.companyName, 'Live Co.');
  } finally {
    restore();
  }
});

// ----------------------------------------------------------------- DOM tier

test('reads the title, image and supplier link from the page', () => {
  const out = withDom({
    html: '<html><head></head></html>',
    metas: { 'og:image': 'https://cdn.example/p.jpg' },
    title: 'Page Title',
    headings: ['3 Head Chenille Embroidery Machine'],
    links: ['https://richpeace.en.alibaba.com/company_profile.html'],
    url: 'https://www.alibaba.com/product-detail/_1601918386232.html',
  }, () => harvestPage());

  assert.equal(out.dom.title, '3 Head Chenille Embroidery Machine');
  assert.equal(out.dom.image, 'https://cdn.example/p.jpg');
  assert.equal(out.dom.companyUrl, 'https://richpeace.en.alibaba.com/company_profile.html');
  assert.equal(out.dom.url, 'https://www.alibaba.com/product-detail/_1601918386232.html');
});

test('collects and parses JSON-LD, skipping malformed blocks', () => {
  const out = withDom({
    html: '<html><body></body></html>',
    ldJson: [
      '{ this is not json',
      JSON.stringify({ '@type': 'Product', name: 'LD Product', sku: 'ABC-1',
        image: ['https://cdn.example/ld.jpg'] }),
    ],
  }, () => harvestPage());

  assert.equal(out.ld.length, 1, 'the broken block is dropped, the good one kept');
  assert.equal(out.ld[0].name, 'LD Product');
});

test('the harvest payload stays small enough to cross the message boundary', () => {
  const payload = { blobs: Array.from({ length: 200 }, (_, i) => ({
    productId: `p${i}`,
    description: 'x'.repeat(2000),
    image: `https://cdn.example/${i}.jpg`,
  })) };
  const html = script(`window.detailData = ${JSON.stringify(payload)};`);
  const out = withDom({ html }, () => harvestPage());

  const serialised = JSON.stringify(out);
  assert.ok(serialised.length < 900000,
    `harvest payload was ${serialised.length} bytes, which risks the extension message limit`);
  assert.equal(out.blob.blobs.length, 200, 'array entries are still all present');
  assert.ok(out.blob.blobs[0].description.length < 500, 'long strings truncated');
});
