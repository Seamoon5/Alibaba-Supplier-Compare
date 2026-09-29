/**
 * probe.js — decide what kind of page we are actually looking at.
 *
 * The failure this exists to prevent: Alibaba serves a BaXIA/CAPTCHA
 * "punish" interstitial as a normal HTTP 200. A naive extractor reads it as a
 * product page with no data and stores an empty supplier row. We detect it by
 * positive markers and fail loudly instead.
 */

/** Markers that never appear on a genuine product page. */
const PUNISH_MARKERS = [
  'punish-component',
  'awsc.js',
  'baxia',
  'NCTOKENSTR',
  '_____tmd_____',
  'x5secdata',
];

/** Marker for a Chrome Web Store or generic CDN error page. */
const BLOCK_MARKERS = ['ERR_BLOCKED_BY_CLIENT', 'ERR_CONNECTION_RESET', 'ERR_NAME_NOT_RESOLVED'];

/**
 * @param {object} page - { html?: string, title?: string, url?: string,
 *                           hasDetailBlob?: boolean, hasProductHeading?: boolean }
 * @returns {'ok'|'punish'|'block'|'not-product'}
 */
export function classifyPage(page = {}) {
  const hay = `${page.title || ''}\n${(page.html || '').slice(0, 200000)}`.toLowerCase();

  if (BLOCK_MARKERS.some((m) => hay.includes(m.toLowerCase()))) return 'block';
  if (PUNISH_MARKERS.some((m) => hay.includes(m.toLowerCase()))) return 'punish';

  const url = page.url || '';
  if (/\/product-detail\//.test(url) || /\/showproduct\.html/.test(url)) {
    // Right shape of URL. Trust it unless the other signals say otherwise.
    return 'ok';
  }
  if (page.hasDetailBlob) return 'ok';
  if (page.hasProductHeading) return 'ok';
  return 'not-product';
}

/** Human-readable message for each non-ok classification. */
export const PAGE_MESSAGES = {
  punish: {
    tone: 'danger',
    title: 'Alibaba is showing a verification screen',
    body:
      'Alibaba asked for a CAPTCHA before showing the page, so there is no product data to read. ' +
      'Nothing was saved. Solve the check in the tab, then press Re-scan.',
  },
  block: {
    tone: 'danger',
    title: 'The page did not load',
    body: 'Chrome could not reach Alibaba. Check your connection, then press Re-scan.',
  },
  'not-product': {
    tone: 'warn',
    title: 'Not a product page',
    body:
      'Open an Alibaba product page (a URL containing /product-detail/) and try again. ' +
      'Supplier showroom and search pages are not supported in this version.',
  },
};

// ------------------------------------------------------------------ URL shape

/**
 * Work out what kind of Alibaba page the user is on, from the URL alone.
 *
 * This exists because the most common way for the extension to appear to do
 * "nothing" is being used on the homepage or a search results page, where there
 * is legitimately nothing to capture. Saying so plainly beats silence.
 *
 * @returns {'product'|'search'|'home'|'offsite'|'unknown'}
 */
export function classifyUrl(url = '') {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'unknown';
  }
  if (!/(^|\.)alibaba\.com$/i.test(parsed.hostname)) return 'offsite';

  const path = parsed.pathname;
  if (/\/product-detail\//i.test(path)) return 'product';
  if (/\/showproduct\.html/i.test(path)) return 'product';

  // /cps/... is Alibaba's landing-page campaign route, not a results list, so
  // it must be excluded before the search checks or the home page looks like
  // a page of results that does not exist.
  const isLanding = /^\/cps\//i.test(path);

  if (!isLanding) {
    if (/^\/(trade\/)?search\b/i.test(path)) return 'search';
    if (/[?&](SearchText|SearchScene)=/i.test(url)) return 'search';
    if (/^\/(companies?|suppliers?)\//i.test(path)) return 'search';
  }

  if (path === '/' || path === '' || isLanding) return 'home';
  return 'unknown';
}

/**
 * A short, concrete next step for each page kind.
 *
 * These must agree with the panel's own empty-state copy (CONTEXT_COPY in
 * panel.js). When the two disagreed, the banner told the user search results
 * were unsupported while the button underneath was about to add them.
 */
export const URL_HINTS = {
  home: {
    tone: 'warn',
    title: 'This is the Alibaba home page',
    body:
      'There is nothing to add from the home page itself. Search for what you need, then ' +
      'press this button again — it will add every result on the results page at once.',
  },
  search: {
    tone: 'warn',
    title: 'Ready to add everyone on this page',
    body:
      'Press Re-scan to add every supplier shown on this results page at once. For tiered ' +
      'prices and a price ladder, open an individual product page and press it again there.',
  },
  offsite: {
    tone: 'warn',
    title: 'Not an Alibaba page',
    body: 'Open a product or search page on alibaba.com, then press this button again.',
  },
  unknown: {
    tone: 'warn',
    title: 'Not a product page',
    body:
      'Open an Alibaba product page (a URL containing /product-detail/) or a results page, ' +
      'then try again.',
  },
};

/** The message to show for a URL that cannot be captured. */
export function messageForUrl(url = '') {
  const kind = classifyUrl(url);
  if (kind === 'product') return null;
  return { ...URL_HINTS[kind], kind };
}
