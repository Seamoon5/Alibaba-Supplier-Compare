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
