/**
 * harvest.js — runs INSIDE the page's own JavaScript world.
 *
 * Why MAIN world: Alibaba's product data lives in `window.detailData`. Chrome
 * gives extension content scripts an isolated world with no access to page
 * globals, so a normal content script physically cannot read it. We inject
 * this with `chrome.scripting.executeScript({ world: 'MAIN' })`, which hands
 * the return value back to the service worker.
 *
 * HARD CONSTRAINT: Chrome serialises the function and evaluates it in the
 * page, so this function must be entirely self-contained. No imports, no
 * closure references, no helper functions defined outside it.
 *
 * It does no interpretation of the data. It finds the raw blob, prunes the
 * bloat out of it, and hands over raw material. All field mapping happens in
 * the service worker (normalize.js) so it stays testable.
 */

export function harvestPage() {
  // ---------------------------------------------------------------- helpers
  var PUNISH = [
    'punish-component',
    'awsc.js',
    'baxia',
    'NCTOKENSTR',
    '_____tmd_____',
    'x5secdata',
  ];

  /**
   * Extract a JSON object from `src` starting at the `{` that follows
   * `markerRe`, using string-aware brace matching.
   *
   * A greedy /\{.*\}/ regex is not usable here: product descriptions contain
   * literal braces, so it grabs the wrong span roughly as often as the right
   * one. This walks the text tracking string state and escapes.
   */
  function sliceObject(src, startIdx) {
    var depth = 0,
      inStr = false,
      quote = '',
      esc = false;
    for (var i = startIdx; i < src.length; i++) {
      var ch = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === quote) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = true;
        quote = ch;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return src.slice(startIdx, i + 1);
      }
    }
    return null;
  }

  /** Find and parse the product blob, preferring a live global over the raw HTML. */
  function findBlob() {
    // 1. Live globals. Read the property directly: stringifying the window
    //    object can never contain a property name, so regexing it finds
    //    nothing. Alibaba has renamed this variable before, so the plain
    //    candidate names are tried and __page__data* is matched as a family.
    var win = window.document && window.document.defaultView ? window.document.defaultView : window;
    var names = ['detailData', '__INITIAL_STATE__', '_PAGE_DATA_'];
    for (var key in win) {
      if (/^__page__data/.test(key)) names.push(key);
    }
    for (var i = 0; i < names.length; i++) {
      var candidate = win[names[i]];
      if (candidate && typeof candidate === 'object' && Object.keys(candidate).length > 0) {
        return { data: candidate, name: names[i], via: 'global' };
      }
    }

    // 2. Fall back to the serialised source. The global may not be assigned
    //    yet if the user clicks very early after navigation.
    var html = document.documentElement ? document.documentElement.outerHTML : '';
    var textRe = /(detailData|__page__data[\w$]*|__INITIAL_STATE__|_PAGE_DATA_)\s*=\s*(\{)/g;
    var t;
    while ((t = textRe.exec(html))) {
      var json = sliceObject(html, t.index + t[0].length - 1);
      if (!json) continue;
      var parsed;
      try {
        parsed = JSON.parse(json);
      } catch (e) {
        continue; // malformed candidate, try the next one
      }
      // A size floor is not a good test; "is this a real object" is.
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
        return { data: parsed, name: t[1], via: 'source' };
      }
    }
    return null;
  }

  /**
   * Prune the blob to something transferable.
   *
   * detailData routinely runs to megabytes of image URLs and description HTML.
   * We keep every key name and every short primitive, and drop the bloat, so
   * the fuzzy matcher upstream still sees the full key space.
   */
  function prune(node, depth, budget) {
    if (budget.n <= 0 || depth > 12) return undefined;
    budget.n--;
    if (node === null || node === undefined) return null;

    var t = typeof node;
    if (t === 'number' || t === 'boolean') return node;
    if (t === 'string') {
      if (node.length > 400) return node.slice(0, 400) + '…';
      return node;
    }
    if (Array.isArray(node)) {
      var arr = [];
      var lim = Math.min(node.length, 300);
      for (var i = 0; i < lim; i++) {
        var av = prune(node[i], depth + 1, budget);
        arr.push(av === undefined ? null : av);
      }
      return arr;
    }
    if (t === 'object') {
      var out = {};
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var v = prune(node[key], depth + 1, budget);
        if (v !== undefined) out[key] = v;
      }
      return out;
    }
    return undefined;
  }

  /** Every distinct top-level-ish key path, for the diagnostics snapshot. */
  function keyPaths(node, prefix, depth, acc, budget) {
    if (!node || typeof node !== 'object' || depth > 6 || budget.n <= 0) return;
    if (Array.isArray(node)) {
      if (node.length) keyPaths(node[0], prefix + '[]', depth, acc, budget);
      return;
    }
    for (var k of Object.keys(node)) {
      if (budget.n-- <= 0) return;
      var path = prefix ? prefix + '.' + k : k;
      if (acc.indexOf(path) === -1) acc.push(path);
      var v = node[k];
      if (v && typeof v === 'object') keyPaths(v, path, depth + 1, acc, budget);
    }
  }

  // ------------------------------------------------------------- page state
  var htmlHead = (document.documentElement ? document.documentElement.outerHTML : '').slice(0, 200000);
  var lowerHead = (document.title + '\n' + htmlHead).toLowerCase();
  var punishHit = '';
  for (var pm of PUNISH) {
    if (lowerHead.indexOf(pm.toLowerCase()) !== -1) {
      punishHit = pm;
      break;
    }
  }

  // --------------------------------------------------------------- JSON-LD
  var ld = [];
  var ldNodes = document.querySelectorAll('script[type="application/ld+json"]');
  for (var i = 0; i < ldNodes.length && i < 10; i++) {
    try {
      ld.push(JSON.parse(ldNodes[i].textContent || 'null'));
    } catch (e) {
      /* malformed ld+json is common; skip */
    }
  }

  // ------------------------------------------------------------------- DOM
  function meta(name) {
    var el = document.querySelector('meta[property="' + name + '"]') ||
             document.querySelector('meta[name="' + name + '"]');
    return el ? (el.getAttribute('content') || '') : '';
  }

  var h1 = document.querySelector('h1');
  var companyLink = document.querySelector('a[href*="company_profile.html"]');

  var dom = {
    title: (h1 ? h1.textContent : '') || meta('og:title') || document.title || '',
    image: meta('og:image'),
    url: location.href,
    companyName: companyLink ? (companyLink.textContent || '').trim() : '',
    companyUrl: companyLink ? companyLink.href : '',
  };

  // Label scan over the visible text. Last resort, but it saves a row when
  // Alibaba serves a re-rendered shell with no usable blob.
  var bodyText = (document.body ? document.body.innerText || '' : '').slice(0, 20000);
  dom.text = bodyText;

  // ------------------------------------------------------------------ blob
  var found = punishHit ? null : findBlob();
  var result = {
    ok: false,
    punishMarker: punishHit,
    url: location.href,
    title: document.title || '',
    ld: ld,
    dom: dom,
    blob: null,
    blobName: null,
    blobVia: null,
    keyPaths: [],
  };

  if (found) {
    var budget = { n: 30000 };
    keyPaths(found.data, '', 0, result.keyPaths, { n: 4000 });
    result.blob = prune(found.data, 0, budget);
    result.blobName = found.name;
    result.blobVia = found.via;
    result.blobTruncated = budget.n <= 0;
  }

  result.ok = Boolean(result.blob) || ld.length > 0 || Boolean(dom.image || dom.title);
  return result;
}
