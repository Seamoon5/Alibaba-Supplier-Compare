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
import { normalize } from './extract/normalize.js';
import { classifyPage, PAGE_MESSAGES } from './lib/probe.js';
import {
  getRecords, upsertRecord, removeRecord, clearRecords,
  getSettings, saveSettings, saveDiagnostics, getDiagnostics,
} from './lib/store.js';
import { recordKey } from './lib/schema.js';
import { getExporter } from './lib/exporters/index.js';

const PRODUCT_URL_RE = /^https?:\/\/([\w-]+\.)?alibaba\.com\/.*(product-detail|showproduct)/i;

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

async function captureActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== 'number') {
    return {
      ok: false,
      state: 'error',
      message: { tone: 'danger', title: 'No active tab', body: 'Switch to a product tab and try again.' },
    };
  }
  return captureTab(tab.id, tab.url);
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
  const result = await captureTab(tab.id, tab.url);
  await broadcast({ type: 'CAPTURE_RESULT', result });
});

// ------------------------------------------------------------------ messages

const HANDLERS = {
  async GET_STATE() {
    return { records: await getRecords(), settings: await getSettings() };
  },

  async CAPTURE({ tabId, tabUrl } = {}) {
    let result;
    if (typeof tabId === 'number') {
      result = await captureTab(tabId, tabUrl);
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      result = await captureTab(tab?.id, tab?.url);
    }
    await broadcast({ type: 'CAPTURE_RESULT', result });
    return result;
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
