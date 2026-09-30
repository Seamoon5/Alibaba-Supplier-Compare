/**
 * background.js — service worker.
 *
 * Responsibilities:
 *   1. Make the toolbar button open the side panel.
 *   2. On that click, read the current tab's product data.
 *   3. Own all storage writes so the panel stays a pure view.
 *
 * Permission model: this extension requests `activeTab`, not
 * `https://*.alibaba.com/*`. That means we get access to a page only at the
 * moment the user clicks our button, and only for the tab they are looking at.
 * Nothing runs on pages the user did not ask about, which is both better
 * privacy and what keeps the extension acceptable to the Chrome Web Store.
 */

import { harvestPage } from './extract/harvest.js';
import { harvestSearchPage } from './extract/search.js';
import { normalize } from './extract/normalize.js';
import { classifyPage, PAGE_MESSAGES, classifyUrl, messageForUrl } from './lib/probe.js';
import { makeRecord } from './lib/schema.js';
import {
  getRecords, upsertRecord, upsertRecords, removeRecord, clearRecords,
  getSettings, saveSettings, saveDiagnostics, getDiagnostics,
  saveLastCapture, getLastCapture, clearLastCapture,
} from './lib/store.js';
import { recordKey } from './lib/schema.js';
import { getExporter } from './lib/exporters/index.js';

const PRODUCT_URL_RE = /^https?:\/\/([\w-]+\.)?alibaba\.com\/.*(product-detail|showproduct)/i;

/** How long a stored capture result stays relevant to a freshly opened panel. */
const CAPTURE_TTL_MS = 90_000;

function setBadge(count) {
  try {
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#3A5BC7' });
  } catch { /* badge is cosmetic */ }
}

async function refreshBadge() {
  const records = await getRecords();
  setBadge(records.length);
}

async function broadcast(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // No panel open. It will read fresh state when it opens.
  }
}

// ------------------------------------------------------------------ capture

/**
 * Read the product data out of a tab.
 * @returns {Promise<{ok:boolean, state?:string, message?:object, record?:object}>}
 */
async function captureTab(tabId, tabUrl) {
  const url = tabUrl || '';

  // A non-product page gets a specific explanation. This is the single most
  // common reason the extension appears to do nothing, so it is never silent.
  const urlMessage = messageForUrl(url);
  if (urlMessage) {
    return {
      ok: false,
      state: urlMessage.kind === 'offsite' ? 'not-product' : 'not-product',
      kind: urlMessage.kind,
      message: {
        tone: urlMessage.tone,
        title: urlMessage.title,
        body: urlMessage.body,
      },
      pageUrl: url,
    };
  }
  if (!PRODUCT_URL_RE.test(url)) {
    return {
      ok: false,
      state: 'not-product',
      message: PAGE_MESSAGES['not-product'],
      pageUrl: url,
    };
  }

  let harvest;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: harvestPage,
    });
    harvest = results?.[0]?.result;
  } catch (err) {
    // Usually means the activeTab grant lapsed, or the page is a Chrome
    // internal page we cannot script.
    const message = String(err?.message || err);
    if (/Cannot access|Extension manifest must request permission/i.test(message)) {
      return {
        ok: false,
        state: 'blocked',
        message: {
          tone: 'warn',
          title: 'Chrome would not let the extension read this tab',
          body:
            'Reload the product page, then press the toolbar button again. If it keeps ' +
            'failing, open the page normally rather than from a search result ad.',
        },
        pageUrl: url,
      };
    }
    return {
      ok: false,
      state: 'error',
      message: { tone: 'danger', title: 'Could not read the page', body: message },
      pageUrl: url,
    };
  }

  if (!harvest) {
    return {
      ok: false,
      state: 'error',
      message: {
        tone: 'danger',
        title: 'The page returned no data',
        body: 'Reload the product page and try again.',
      },
      pageUrl: url,
    };
  }

  // The punish interstitial is served as a normal 200, so it must be detected
  // explicitly. Recording it would silently save an empty supplier.
  const classification = classifyPage({
    html: harvest.blob ? JSON.stringify(harvest.blob).slice(0, 60000) : '',
    title: harvest.title,
    url: harvest.url,
    hasDetailBlob: Boolean(harvest.blob),
    hasProductHeading: Boolean(harvest.dom?.title),
  });

  if (classification === 'punish') {
    return {
      ok: false,
      state: 'punish',
      message: PAGE_MESSAGES.punish,
      pageUrl: url,
    };
  }
  if (classification === 'block') {
    return { ok: false, state: 'block', message: PAGE_MESSAGES.block, pageUrl: url };
  }

  const { record, diagnostics } = normalize(harvest);
  const diag = await saveDiagnostics({
    blobName: harvest.blobName,
    blobVia: harvest.blobVia,
    keyPaths: harvest.keyPaths,
    tierCounts: diagnostics.tierCounts,
    foundAnyBlob: diagnostics.foundAnyBlob,
    sawLd: diagnostics.sawLd,
    blobTruncated: diagnostics.blobTruncated,
    layers: diagnostics.layers,
  });

  if (!record.title && !record.companyName) {
    return {
      ok: false,
      state: 'not-product',
      message: PAGE_MESSAGES['not-product'],
      pageUrl: url,
      diagnostics: diag,
    };
  }

  const { action } = await upsertRecord(record);
  await refreshBadge();

  return {
    ok: true,
    action,
    record,
    key: recordKey(record),
    diagnostics: diag,
    pageUrl: url,
  };
}

/**
 * Capture, then record the result where the panel will certainly find it.
 *
 * The naive version broadcast the result and let it go. That loses the message
 * whenever the panel is still loading, which is the common case: pressing the
 * toolbar button is what OPENS the panel, so the panel almost always starts up
 * after the capture has already finished. The user then saw nothing at all.
 * Persisting the result closes that race from both directions.
 */
/**
 * The URL of the tab being captured.
 *
 * host_permissions on alibaba.com makes this readable at any time, which is
 * what Re-scan needs: the toolbar click used to supply a one-shot activeTab
 * grant, and that grant did not survive a navigation, so pressing Re-scan after
 * a search produced "Not a product page" on a search page.
 */
async function activeTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { url: tab?.url || '', id: tab?.id };
  } catch {
    return { url: '', id: undefined };
  }
}

async function captureActive() {
  const { url, id } = await activeTabUrl();
  return captureAndReport(id, url);
}

async function captureAndReport(tabId, tabUrl) {
  const kind = classifyUrl(tabUrl || '');
  const result = kind === 'search' || kind === 'home'
    ? await captureSearchTab(tabId, tabUrl)
    : await captureTab(tabId, tabUrl);
  await saveLastCapture({ result, at: Date.now() });
  await broadcast({ type: 'CAPTURE_RESULT', result });
  return result;
}

/**
 * Add everything on a results page in one press.
 *
 * This is the flow the brief actually describes: search Alibaba, then compare
 * the results. Requiring a click into each product page first made the
 * extension look broken at the point of use.
 */
async function captureSearchTab(tabId, tabUrl) {
  let harvest;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: harvestSearchPage,
    });
    harvest = results?.[0]?.result;
  } catch (err) {
    return {
      ok: false,
      state: 'error',
      message: {
        tone: 'danger',
        title: 'Could not read this page',
        body: String(err?.message || err),
      },
      pageUrl: tabUrl,
    };
  }

  if (!harvest || !Array.isArray(harvest.candidates) || harvest.candidates.length === 0) {
    return {
      ok: false,
      state: 'no-results',
      message: {
        tone: 'warn',
        title: 'Nothing to add on this page',
        body:
          'No supplier cards were found. Alibaba only shows results after you search, and it ' +
          'replaces the list as you scroll. Scroll until results are on screen, then try again.',
      },
      pageUrl: tabUrl,
    };
  }

  const records = harvest.candidates
    .map((c) => makeRecord({
      ...c,
      origin: 'search',
      provenance: { __source: 'search-cards' },
      capturedAt: new Date().toISOString(),
    }))
    .filter((r) => r.companyName || r.title);

  // A capture is judged on whether the fields a buyer acts on are actually
  // there, not on how many rows it produced. A full table of wrong values is
  // worse than an error, because it looks like a result.
  const health = assessCapture(records, { strategy: harvest.strategy, anchors: harvest.anchors });
  await saveDiagnostics({
    strategy: harvest.strategy,
    anchors: harvest.anchors,
    cardSamples: harvest.cardSamples,
    health: { verdict: health.verdict, coverage: health.coverage, summary: summarise(health) },
  });

  if (records.length === 0) {
    return {
      ok: false,
      state: 'no-results',
      message: {
        tone: 'warn',
        title: 'No supplier names found',
        body:
          'Cards were found but none of them had a readable company name. Alibaba changes this ' +
          'layout often — use "Copy diagnostic snapshot" in settings and send it in a bug report.',
      },
      pageUrl: tabUrl,
    };
  }

  const { added, updated } = await upsertRecords(records);
  await refreshBadge();

  // The rows are kept — half a table is worth more than none — but the panel is
  // told exactly what is missing, so a broken capture can never pass as a good
  // one again.
  return {
    ok: true,
    action: added > 0 ? 'added-many' : 'updated',
    added,
    updated,
    total: records.length,
    scene: harvest.scene,
    pageUrl: tabUrl,
    health,
    ...(health.verdict === 'ok'
      ? {}
      : {
        message: {
          tone: health.verdict === 'broken' ? 'error' : 'warn',
          title: health.verdict === 'broken' ? 'Capture looks broken' : 'Partial data',
          body: `${health.reason}${health.advice ? ` ${health.advice}` : ''}`,
        },
      }),
  };
}

// ------------------------------------------------------------------ wiring

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => { /* older Chrome: the user opens the panel manually */ });
});
chrome.runtime.onStartup?.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});
refreshBadge();

chrome.action.onClicked.addListener(async (tab) => {
  await captureAndReport(tab.id, tab.url);
});

// Switching tabs invalidates whatever the panel last advised about. On a fresh
// panel the tab URL may be unreadable, so tell the panel to re-check rather than
// leave it describing a page the user has left.
chrome.tabs?.onActivated?.addListener?.(() => {
  broadcast({ type: 'TAB_CHANGED' });
});

// ------------------------------------------------------------------ messages

const HANDLERS = {
  async GET_STATE() {
    return { records: await getRecords(), settings: await getSettings() };
  },

  /**
   * What the panel needs to know about the current page, plus any capture
   * result it missed while it was still loading.
   */
  async GET_TAB_CONTEXT() {
    const { url } = await activeTabUrl();
    const stored = await getLastCapture();
    const fresh = stored && Date.now() - stored.at < CAPTURE_TTL_MS ? stored : null;
    if (!fresh) await clearLastCapture();
    return {
      url,
      kind: classifyUrl(url),
      pendingResult: fresh ? fresh.result : null,
    };
  },

  async CAPTURE() {
    return captureActive();
  },

  async REMOVE({ key }) {
    const records = await removeRecord(key);
    await refreshBadge();
    await broadcast({ type: 'RECORDS_CHANGED', records });
    return { records };
  },

  async CLEAR() {
    const records = await clearRecords();
    await refreshBadge();
    await broadcast({ type: 'RECORDS_CHANGED', records });
    return { records };
  },

  async SET_SETTINGS({ patch }) {
    const settings = await saveSettings(patch || {});
    await broadcast({ type: 'SETTINGS_CHANGED', settings });
    return { settings };
  },

  async GET_DIAGNOSTICS() {
    return { diagnostics: await getDiagnostics() };
  },

  async EXPORT({ exporterId, records, settings }) {
    const exporter = getExporter(exporterId);
    if (!exporter) return { ok: false, error: 'Unknown exporter' };
    const data = exporter.build(records || [], settings || {});
    try {
      await navigator.clipboard.writeText(data);
      return { ok: true, chars: data.length };
    } catch (err) {
      return { ok: false, error: String(err?.message || err), data };
    }
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown message ${message?.type}` });
    return false;
  }
  Promise.resolve(handler(message))
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // async response
});
