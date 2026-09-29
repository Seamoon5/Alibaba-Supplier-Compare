/**
 * test/helpers/fakeDom.js — a DOM small enough to run harvestPage() in Node.
 *
 * harvestPage has to be a single self-contained function because Chrome
 * serialises it before evaluating it in the page. That normally makes it
 * untestable, so instead of extracting the logic into helpers (which would
 * reintroduce the closure dependency) we give it a real environment to run in.
 * This is the actual shipped code being exercised, not a copy of it.
 */

class El {
  constructor(tag, attrs = {}, text = '') {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.textContent = text;
    this.href = attrs.href || '';
  }
  getAttribute(name) {
    return this.attrs[name] !== undefined ? this.attrs[name] : null;
  }
}

/** Build a document from a description object. */
export function makeDom({
  html = '',
  title = 'Test page',
  url = 'https://www.alibaba.com/product-detail/_1234567890.html',
  bodyText = '',
  metas = {},
  links = [],
  headings = [],
  ldJson = [],
} = {}) {
  const nodes = [];
  for (const [key, content] of Object.entries(metas)) {
    // Real pages write <meta property="og:image"> and sometimes
    // <meta name="og:image">, so expose both forms.
    nodes.push(new El('meta', { property: key, name: key, content }));
  }
  for (const href of links) nodes.push(new El('a', { href }, ''));
  for (const h of headings) nodes.push(new El('h1', {}, h));
  for (const raw of ldJson) nodes.push(new El('script', { type: 'application/ld+json' }, raw));

  const documentElement = { outerHTML: html };

  const matches = (el, sel) => {
    const attrMatch = sel.match(/^(\w+)\[(\w+)([*^$]?=)"([^"]*)"\]$/);
    if (attrMatch) {
      const [, tag, attr, op, value] = attrMatch;
      if (el.tagName !== tag.toUpperCase()) return false;
      const actual = el.attrs[attr];
      if (actual === undefined) return false;
      if (op === '=') return actual === value;
      if (op === '*=') return String(actual).includes(value);
      if (op === '^=') return String(actual).startsWith(value);
      if (op === '$=') return String(actual).endsWith(value);
      return false;
    }
    return el.tagName === sel.toUpperCase();
  };

  const document = {
    title,
    documentElement,
    body: { innerText: bodyText },
    querySelector(sel) {
      return nodes.find((el) => matches(el, sel)) || null;
    },
    querySelectorAll(sel) {
      return nodes.filter((el) => matches(el, sel));
    },
  };

  const location = { href: url };

  return { document, location, nodes };
}

/** Install the fake DOM onto globalThis and return a restore function. */
export function installDom(config) {
  const { document, location } = makeDom(config);
  const saved = {
    document: globalThis.document,
    location: globalThis.location,
    window: globalThis.window,
  };
  const win = { document, location, document_: null };
  win.document = document;
  win.document.defaultView = win;
  win.location = location;

  globalThis.document = document;
  globalThis.location = location;
  globalThis.window = win;

  return () => {
    globalThis.document = saved.document;
    globalThis.location = saved.location;
    globalThis.window = saved.window;
  };
}
