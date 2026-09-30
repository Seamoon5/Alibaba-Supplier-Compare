/**
 * panel.js — side panel view.
 *
 * This file owns no business rules. It reads state from the background worker,
 * calls the pure functions in lib/compare.js, and renders. All persistence goes
 * through chrome.runtime.sendMessage so there is exactly one writer.
 */

import { rank, resolveSupplier, formatPrice, isManufacturer, tierShape } from '../lib/compare.js';
import { recordKey } from '../lib/schema.js';
import { getExporter } from '../lib/exporters/index.js';

const $ = (id) => document.getElementById(id);

const el = {
  hdrCount: $('hdrCount'),
  qty: $('inpQty'),
  filters: $('filters'),
  fVerified: $('fVerified'),
  fManufacturers: $('fManufacturers'),
  fBelowMoq: $('fBelowMoq'),
  fLowConf: $('fLowConf'),
  banner: $('banner'),
  bannerIcon: $('bannerIcon'),
  bannerTitle: $('bannerTitle'),
  bannerText: $('bannerText'),
  bannerAction: $('bannerAction'),
  bannerClose: $('bannerClose'),
  scanning: $('scanning'),
  empty: $('empty'),
  wrap: $('wrap'),
  fxNote: $('fxNote'),
  matrixHead: $('matrixHead'),
  matrixBody: $('matrixBody'),
  ftr: $('ftr'),
  toast: $('toast'),
  btnRescan: $('btnRescan'),
  btnSettings: $('btnSettings'),
  btnTsv: $('btnTsv'),
  btnQuote: $('btnQuote'),
  btnCsv: $('btnCsv'),
  btnClear: $('btnClear'),
  btnDiagnostics: $('btnDiagnostics'),
  btnReset: $('btnReset'),
};

let records = [];
let settings = { targetQty: 1 };
let busy = false;
let toastTimer = null;
let tabContext = { kind: 'unknown', url: '' };

/** What the empty state should say, given the page the user is actually on. */
const CONTEXT_COPY = {
  home: {
    title: 'Start with a search',
    text: 'You are on the Alibaba home page. Search for what you need, then come back here and press the button again — this will add every result on the page at once.',
  },
  search: {
    title: 'Add everyone on this page',
    text: 'This is a results page. Press the button to add every supplier shown here at once, then open an individual product page to add its tiered prices.',
  },
  product: {
    title: 'Compare suppliers, not tabs',
    text: 'This page looks like a product page. Press the button to add it, then repeat for each supplier you are considering.',
  },
  offsite: {
    title: 'Open an Alibaba page first',
    text: 'This tab is not on alibaba.com. Switch to an Alibaba product or search page and press the button again.',
  },
  unknown: {
    title: 'Compare suppliers, not tabs',
    text: 'Open an Alibaba product page, then press the toolbar button. Its prices, MOQ and credentials are added to a matrix you can read at a glance.',
  },
};

// ---------------------------------------------------------------- messaging

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || { ok: false, error: 'no response' });
    });
  });
}

async function loadState() {
  const res = await send('GET_STATE');
  records = res.records || [];
  settings = res.settings || { targetQty: 1 };
  await refreshContext();
  syncControls();
  render();
}

/**
 * Ask the worker what the current tab is, and pick up any capture result that
 * was produced while this panel was still loading.
 */
async function refreshContext() {
  let res;
  try {
    res = await send('GET_TAB_CONTEXT');
  } catch {
    return;
  }
  if (!res || res.ok === false) return;
  tabContext = { kind: res.kind || 'unknown', url: res.url || '' };
  if (res.pendingResult) captureResultUi(res.pendingResult);
}

// ------------------------------------------------------------------- chrome

function syncControls() {
  el.qty.value = String(settings.targetQty ?? 1);
  el.fVerified.checked = !!settings.verifiedOnly;
  el.fManufacturers.checked = !!settings.manufacturersOnly;
  el.fBelowMoq.checked = !!settings.hideBelowMoq;
  el.fLowConf.checked = !!settings.hideLowConfidence;
  el.hdrCount.textContent = String(records.length);
  el.hdrCount.hidden = records.length === 0;
}

function toast(message, tone = '') {
  el.toast.textContent = message;
  el.toast.className = 'toast' + (tone ? ` tone-${tone}` : '');
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

function showBanner({ tone = 'warn', icon = '!', title, text, action }) {
  el.banner.className = 'banner' + (tone ? ` tone-${tone}` : '');
  el.bannerIcon.textContent = icon;
  el.bannerTitle.textContent = title;
  el.bannerText.textContent = text;
  el.bannerAction.hidden = !action;
  if (action) el.bannerAction.textContent = action.label;
  el.banner.hidden = false;
}

function hideBanner() { el.banner.hidden = true; }

// ------------------------------------------------------------------ capture

async function capture() {
  if (busy) return;
  busy = true;
  el.scanning.hidden = false;
  hideBanner();

  const res = await send('CAPTURE');

  el.scanning.hidden = true;
  busy = false;

  if (res?.ok === false && res.error) {
    showBanner({
      tone: 'danger', icon: '×',
      title: 'Something went wrong',
      text: res.error,
    });
    return;
  }

  await captureResultUi(res?.result || res);
}

// ------------------------------------------------------------------ render

/**
 * True when a field was attempted but never actually read. "Verified: No" and
 * "no verified status published" are different claims and we must not conflate
 * them.
 */
const notRead = (r, field) => !r.provenance || r.provenance[field] === 'missing';

/**
 * The empty state is the first thing anyone sees, so it has to answer the
 * question the user is actually asking: "what do I press, and will it work on
 * the page I'm looking at?" It reads the current tab and says so.
 */
function renderEmpty() {
  const copy = CONTEXT_COPY[tabContext.kind] || CONTEXT_COPY.unknown;
  $('emptyTitle').textContent = copy.title;
  $('emptyText').textContent = copy.text;

  const addable = tabContext.kind === 'product' || tabContext.kind === 'search' || tabContext.kind === 'home';
  const action = $('ctxAction');
  action.hidden = !addable;
  if (addable) {
    action.textContent = tabContext.kind === 'product'
      ? 'Add this product'
      : 'Add every result on this page';
  }

  $('ctxNote').hidden = tabContext.kind === 'product';
  if (tabContext.kind !== 'product') {
    $('ctxNote').textContent = `Currently on: ${shortUrl(tabContext.url)}`;
  }

  // The four-step list only helps when the extension is being set up; once the
  // user is on a real page it is noise competing with the action button.
  $('emptySteps').hidden = tabContext.kind !== 'unknown' && tabContext.kind !== 'offsite';
}

function shortUrl(url) {
  if (!url) return 'no page detected';
  if (url === 'chrome://extensions/') return 'the extensions page';
  try {
    const u = new URL(url);
    const tail = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
    return u.hostname.replace(/^www\./, '') + tail.slice(0, 40);
  } catch {
    return url.slice(0, 60);
  }
}

/** One row definition for the transposed matrix. */
function rowDefs() {
  return [
    {
      label: `Unit price @ ${settings.targetQty}`,
      key: true,
      cell: (c, r, isBest) => {
        if (c.unitPrice === null) return html`<span class="muted">no price data</span>`;
        const tag = isBest ? raw('<span class="best-tag">Best</span>') : raw('');
        // A supplier card publishes a RANGE ("US$1,250-4,500"), not a single
        // price. Ranking uses the low end and the high end is shown next to it,
        // so the number can never be read as a firm quote.
        const hi = Number(r.priceTo);
        const range = Number.isFinite(hi) && hi > c.unitPrice
          ? html`<div class="muted">up to ${formatPrice(hi, c.currency)}</div>`
          : raw('');
        return html`<span class="val-num">${formatPrice(c.unitPrice, c.currency)}</span>${tag}${range}`;
      },
    },
    {
      label: 'Order total',
      cell: (c) => html`<span class="val-num">${formatPrice(c.total, c.currency)}</span>`,
    },
    {
      label: 'MOQ',
      cell: (c, r) => {
        const qty = r.moqQty ?? '—';
        const unit = r.moqUnit ? ` ${r.moqUnit}` : '';
        if (!c.belowMoq) return html`<span class="val-num">${qty}${unit}</span>`;
        return html`<span class="val-num">${qty}${unit}</span>
                   <span class="flag flag-warn">! Below MOQ</span>`;
      },
    },
    {
      label: 'Verified',
      cell: (_c, r) => {
        if (notRead(r, 'verifiedSupplier')) return html`<span class="muted">— not shown</span>`;
        return r.verifiedSupplier
          ? html`<span class="verified-yes">✓ Yes</span>`
          : html`<span class="verified-no">— No</span>`;
      },
    },
    {
      label: 'Trade Assur.',
      cell: (_c, r) => {
        if (notRead(r, 'tradeAssurance')) return html`<span class="muted">— not shown</span>`;
        return r.tradeAssurance
          ? html`<span class="verified-yes">✓ Yes</span>`
          : html`<span class="verified-no">— No</span>`;
      },
    },
    {
      label: 'Years',
      cell: (_c, r) => Number.isFinite(r.yearsOnPlatform)
        ? html`<span class="val-num">${r.yearsOnPlatform}</span>`
        : html`<span class="muted">—</span>`,
    },
    {
      label: 'Business type',
      cell: (_c, r) => {
        if (!r.businessType) return html`<span class="muted">—</span>`;
        // The flag goes on its own line: sharing the line with a long word
        // like "Manufacturer" forces a mid-word break in a narrow column.
        const tag = isManufacturer(r.businessType)
          ? raw('<div><span class="flag flag-best">✓ factory</span></div>')
          : raw('');
        return html`${r.businessType}${tag}`;
      },
    },
    {
      label: 'Country',
      cell: (_c, r) => (r.country ? html`${r.country}` : html`<span class="muted">—</span>`),
    },
    {
      label: 'Response',
      cell: (_c, r) => (r.responseRate ? html`${r.responseRate}` : html`<span class="muted">—</span>`),
    },
    {
      label: 'On-time',
      cell: (_c, r) => (Number.isFinite(r.onTimeDelivery)
        ? html`<span class="val-num">${r.onTimeDelivery}%</span>`
        : html`<span class="muted">—</span>`),
    },
    {
      label: 'Reorder',
      cell: (_c, r) => (Number.isFinite(r.reorderRate)
        ? html`<span class="val-num">${r.reorderRate}%</span>`
        : html`<span class="muted">—</span>`),
    },
    {
      label: 'Revenue',
      cell: (_c, r) => (r.onlineRevenue
        ? html`${r.onlineRevenue}`
        : html`<span class="muted">—</span>`),
    },
    {
      label: 'Lead time',
      cell: (_c, r) => (r.leadTime ? html`${r.leadTime}` : html`<span class="muted">—</span>`),
    },
    {
      label: 'Products listed',
      cell: (_c, r) => {
        if (!Array.isArray(r.products) || r.products.length === 0) {
          return html`<span class="muted">—</span>`;
        }
        // The cheapest offer is already the unit price above, so what is left is
        // "the rest of what this factory makes". One product per line, capped,
        // so a long title cannot run into the next one.
        const rest = r.products.slice(1, 4);
        if (rest.length === 0) return html`<span class="muted">nothing else listed</span>`;
        const lines = rest.map((p) => {
          const hi = Number(p.to);
          const range = Number.isFinite(hi) && hi > p.from
            ? `–${hi.toLocaleString('en-US')}`
            : '';
          const title = p.title ? p.title.slice(0, 30) : 'Product';
          return `<div>${escapeHtml(title)}<span class="muted"> ${escapeHtml(
            `${p.from.toLocaleString('en-US')}${range}`,
          )}</span></div>`;
        });
        if (r.products.length > rest.length + 1) {
          lines.push(`<div class="muted">+${r.products.length - rest.length - 1} more</div>`);
        }
        return raw(lines.join(''));
      },
    },
    {
      label: 'Ladder',
      cell: (_c, r) => (r.priceTiers.length ? sparkline(r.priceTiers, settings.targetQty) : html`<span class="muted">—</span>`),
    },
    {
      label: 'Data quality',
      cell: (_c, r) => r.confidence === 'low'
        ? html`<span class="flag flag-warn">~ Partial</span>${raw(
            `<div class="muted">${escapeHtml(r.missing.join(', ') || 'unknown')}</div>`)}`
        : html`<span class="flag flag-best">✓ Complete</span>`,
    },
    {
      label: 'Photo',
      cell: (_c, r) => (r.image
        ? html`<img class="prod-img" src="${r.image}" alt="Product photo from the Alibaba listing" loading="lazy" referrerpolicy="no-referrer">`
        : html`<span class="muted">— none</span>`),
    },
    {
      label: 'Links',
      cell: (_c, r) => {
        const parts = [];
        if (r.sourceUrl) {
          parts.push(`<a class="prod-link" href="${escapeHtml(r.sourceUrl)}" target="_blank" rel="noreferrer noopener">Product</a>`);
        }
        if (r.companyUrl) {
          parts.push(`<a class="prod-link" href="${escapeHtml(r.companyUrl)}" target="_blank" rel="noreferrer noopener">Company</a>`);
        }
        if (parts.length === 0) return html`<span class="muted">—</span>`;
        return raw(parts.join(' '));
      },
    },
  ];
}

/**
 * Markup that is already trusted and must not be escaped again.
 * Everything else passed to `html` is escaped, so building HTML by
 * concatenation is safe by default.
 */
const RAW = Symbol('raw');
const raw = (s) => ({ [RAW]: String(s) });

/** Flatten a value to an HTML string: raw() passes through, text is escaped. */
function cellHtml(value) {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(cellHtml).join('');
  if (typeof value === 'object' && RAW in value) return value[RAW];
  return escapeHtml(String(value));
}

/**
 * Tagged template for building cell markup. Plain interpolations are escaped,
 * raw() fragments are not. Returns a raw value, so a cell can be built from
 * several pieces without any of them being escaped twice.
 */
function html(strings, ...values) {
  return raw(strings.reduce((acc, s, i) => acc + cellHtml(values[i - 1]) + s));
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function sparkline(tiers, targetQty) {
  const pts = tierShape(tiers, targetQty);
  const W = 108;
  const H = 22;
  if (pts.length === 0) return raw('');
  if (pts.length === 1) {
    const y = H - 4 - pts[0].norm * (H - 8);
    return raw(`<svg class="spark" width="${W}" height="${H}" role="img" aria-label="Single price tier">
      <circle cx="6" cy="${y.toFixed(1)}" r="3" fill="var(--accent)"/></svg>`);
  }
  const maxX = Math.max(...pts.map((p) => p.minQty)) || 1;
  const coords = pts.map((p) => {
    const x = 6 + (p.minQty / maxX) * (W - 12);
    const y = H - 4 - p.norm * (H - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = coords[coords.length - 1].split(',');
  return raw(`<svg class="spark" width="${W}" height="${H}" role="img"
    aria-label="Price falls as quantity rises, ${pts.length} tiers">
    <polyline points="${coords.join(' ')}" fill="none" stroke="var(--accent)"
      stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="3" fill="var(--accent)"/></svg>`);
}

function render() {
  const hasRecords = records.length > 0;

  el.empty.hidden = hasRecords;
  el.wrap.hidden = !hasRecords;
  el.ftr.hidden = !hasRecords;

  if (!hasRecords) {
    el.hdrCount.hidden = true;
    renderEmpty();
    return;
  }

  const result = rank(records, settings.targetQty, {
    hideBelowMoq: settings.hideBelowMoq,
    verifiedOnly: settings.verifiedOnly,
    manufacturersOnly: settings.manufacturersOnly,
    hideLowConfidence: settings.hideLowConfidence,
  });

  // Ranked columns first, then suppliers with no published price. Unpriced
  // suppliers still belong in a supplier comparison — MOQ, years and
  // on-time delivery are the reason to keep them — so they are shown, just not
  // ranked against anything.
  const cols = [];
  result.groups.forEach((group, groupIndex) => {
    group.rows.forEach((row, i) => {
      cols.push({
        resolved: row,
        isBest: row.key === group.bestKey,
        currency: group.currency,
        groupStart: i === 0,
        groupIndex,
      });
    });
  });

  for (const row of result.unpriced) {
    cols.push({
      resolved: row,
      isBest: false,
      currency: row.currency,
      groupStart: false,
      unpriced: true,
    });
  }

  const all = cols;
  const multi = result.groups.length > 1;

  el.matrixHead.innerHTML = `<tr><th class="col-label">Supplier</th>${all
    .map((c) => {
      const r = c.resolved.record;
      const sub = [
        c.currency,
        c.unpriced ? 'no published price' : null,
        c.resolved.record.confidence === 'low' ? 'partial data' : null,
      ].filter(Boolean).join(' · ');
      const cls = [c.isBest ? 'col-best' : '', c.groupStart && multi ? 'group-start' : '']
        .filter(Boolean).join(' ');
      const groupTag = c.groupStart && multi
        ? `<span class="group-tag">${escapeHtml(c.currency)} group</span>`
        : '';
      return `<th class="${cls}" data-key="${escapeHtml(c.resolved.key)}">
        <b class="col-name">${escapeHtml(r.companyName || 'Unnamed supplier')}</b>
        <div class="col-foot">
          <span class="col-sub">${escapeHtml(sub)}</span>
          <button class="col-drop" data-remove="${escapeHtml(c.resolved.key)}"
            title="Remove this supplier" aria-label="Remove ${escapeHtml(r.companyName || 'supplier')}">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
        ${groupTag}
      </th>`;
    }).join('')}</tr>`;

  const defs = rowDefs();
  el.matrixBody.innerHTML = defs
    .map((def) => {
      const cls = def.key ? 'row-key' : '';
      return `<tr class="${cls}"><th scope="row">${escapeHtml(def.label)}</th>${all
        .map((c) => {
          const td = [c.isBest ? 'cell-best' : '', c.groupStart && multi ? 'group-start' : '']
            .filter(Boolean).join(' ');
          return `<td class="${td}">${cellHtml(def.cell(c.resolved, c.resolved.record, c.isBest))}</td>`;
        })
        .join('')}</tr>`;
    })
    .join('');

  // Notes: explain anything a user might otherwise read as a bug.
  const notes = [];
  if (result.multipleCurrencies) {
    notes.push(
      `Suppliers quote in ${result.groups.length} currencies (${result.groups
        .map((g) => g.currency).join(', ')}). Each currency is ranked separately — no cross-currency winner is shown, because that would need a live exchange rate.`,
    );
  }
  if (result.unpriced.length) {
    const priced = records.length - result.unpriced.length;
    notes.push(
      `${priced} of ${records.length} supplier${records.length > 1 ? 's publish' : ' publishes'} a price on this page, so ${
        result.unpriced.length > 1 ? 'the rest are' : 'the other is'
      } shown but not ranked.`,
    );
  }
  if (records.some((r) => Number.isFinite(Number(r.priceTo)) && Number(r.priceTo) > Number(r.priceTiers[0]?.unitPrice))) {
    notes.push(
      'Where a supplier publishes a range, the unit price is the low end and the high end is shown under it.',
    );
  }
  if (result.filtered.length) {
    notes.push(`${result.filtered.length} hidden by the current filters.`);
  }
  if (result.totalShown === 0 && result.unpriced.length === 0 && records.length > 0) {
    notes.push('No supplier matches the current quantity and filters.');
  }
  el.fxNote.textContent = notes.join(' ');
  el.fxNote.hidden = notes.length === 0;
}

// ------------------------------------------------------------------ actions

el.btnRescan.addEventListener('click', capture);
$('ctxAction').addEventListener('click', capture);

el.btnSettings.addEventListener('click', () => {
  const open = el.filters.hidden;
  el.filters.hidden = !open;
  el.btnSettings.setAttribute('aria-expanded', String(open));
});

el.bannerClose.addEventListener('click', hideBanner);
el.bannerAction.addEventListener('click', capture);

let qtyTimer = null;
el.qty.addEventListener('input', () => {
  const n = parseInt(el.qty.value, 10);
  if (!Number.isFinite(n) || n < 1) return;
  clearTimeout(qtyTimer);
  qtyTimer = setTimeout(async () => {
    settings.targetQty = n;
    render();
    await send('SET_SETTINGS', { patch: { targetQty: n } });
  }, 200);
});

for (const [node, key] of [
  [el.fVerified, 'verifiedOnly'],
  [el.fManufacturers, 'manufacturersOnly'],
  [el.fBelowMoq, 'hideBelowMoq'],
  [el.fLowConf, 'hideLowConfidence'],
]) {
  node.addEventListener('change', async () => {
    settings[key] = node.checked;
    render();
    await send('SET_SETTINGS', { patch: { [key]: node.checked } });
  });
}

// One delegated handler covers both the header cells and the body cells,
// because the remove button lives in the sticky supplier header.
$('matrix').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  const key = btn.getAttribute('data-remove');
  const res = await send('REMOVE', { key });
  if (res.ok) {
    records = res.records || [];
    render();
    toast('Supplier removed');
  }
});

el.btnClear.addEventListener('click', async () => {
  if (!records.length) return;
  if (!confirm(`Remove all ${records.length} suppliers from the comparison?`)) return;
  const res = await send('CLEAR');
  if (res.ok) {
    records = [];
    render();
    hideBanner();
    toast('Comparison cleared');
  }
});

el.btnReset.addEventListener('click', async () => {
  if (!confirm('Remove every saved supplier and reset filters? This cannot be undone.')) return;
  const res = await send('CLEAR');
  if (res.ok) {
    records = [];
    settings = { targetQty: settings.targetQty };
    syncControls();
    render();
    toast('Saved data reset');
  }
});

el.btnDiagnostics.addEventListener('click', async () => {
  const res = await send('GET_DIAGNOSTICS');
  const d = res.diagnostics;
  if (!d) {
    toast('No capture diagnostics yet', 'error');
    return;
  }
  const report = [
    'Alibaba Supplier Compare — capture diagnostics',
    `Saved: ${d.savedAt || 'unknown'}`,
    `Blob variable : ${d.blobName || 'not found'} (via ${d.blobVia || 'n/a'})`,
    `Blob present  : ${d.foundAnyBlob ? 'yes' : 'no'}`,
    `JSON-LD found : ${d.sawLd ? 'yes' : 'no'}`,
    `Blob truncated: ${d.blobTruncated ? 'yes' : 'no'}`,
    '',
    'Field provenance:',
    ...(d.layers || []).map((l) => `  ${String(l.field).padEnd(18)} ${l.via}${l.ok ? '' : '  (not found)'}`),
    '',
    'Key paths seen in the blob (first 120):',
    ...(d.keyPaths || []).slice(0, 120).map((p) => `  ${p}`),
  ].join('\n');
  try {
    await navigator.clipboard.writeText(report);
    toast('Diagnostic snapshot copied');
  } catch {
    toast('Could not copy — check clipboard access', 'error');
  }
});

async function copyExport(exporterId, label) {
  const exporter = getExporter(exporterId);
  if (!exporter) return;
  const data = exporter.build(records, settings);
  try {
    await navigator.clipboard.writeText(data);
    toast(`${label} copied`);
  } catch {
    // Clipboard can be blocked in a side panel; fall back to a selectable box.
    showFallbackText(label, data);
  }
}

function showFallbackText(label, data) {
  const pre = document.createElement('textarea');
  pre.value = data;
  pre.style.cssText =
    'position:fixed;left:8px;right:8px;top:8px;height:60vh;z-index:70;' +
    'font:12px var(--font);padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--surface)';
  pre.readOnly = true;
  pre.addEventListener('click', () => pre.select());
  document.body.appendChild(pre);
  pre.select();
  toast('Clipboard blocked — text selected, press Ctrl+C', 'error');
  setTimeout(() => pre.remove(), 30000);
}

el.btnTsv.addEventListener('click', () => copyExport('tsv', 'Table'));
el.btnQuote.addEventListener('click', () => copyExport('clientSummary', 'Quote summary'));

el.btnCsv.addEventListener('click', () => {
  const exporter = getExporter('csv');
  const data = exporter.build(records, settings);
  const blob = new Blob([data], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `alibaba-comparison-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('CSV downloaded');
});

// ------------------------------------------------------- worker broadcasts

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'CAPTURE_RESULT') {
    if (!busy) {
      // Capture triggered by the toolbar button.
      captureResultUi(message.result);
    }
  } else if (message?.type === 'RECORDS_CHANGED') {
    records = message.records || [];
    render();
  } else if (message?.type === 'SETTINGS_CHANGED') {
    settings = message.settings || settings;
    syncControls();
    render();
  } else if (message?.type === 'TAB_CHANGED') {
    if (!records.length) refreshContext().then(render);
  }
});

async function captureResultUi(result) {
  if (result?.ok) {
    await loadState();
    hideBanner();

    if (result.action === 'added-many') {
      const n = result.added || 0;
      const upd = result.updated || 0;
      const bits = [`${n} added`];
      if (upd) bits.push(`${upd} refreshed`);
      showBanner({
        tone: 'best',
        icon: '✓',
        title: n > 0 ? 'Results page added' : 'Already added',
        text: `${bits.join(', ')} from this ${result.scene === 'suppliers' ? 'supplier' : 'product'} search. Set your quantity above to rank them.`,
      });
    } else {
      const r = result.record || {};
      const bits = [];
      if (r.companyName) bits.push(r.companyName);
      if (r.priceTiers?.length) bits.push(`${r.priceTiers.length} price tier${r.priceTiers.length > 1 ? 's' : ''}`);
      showBanner({
        tone: 'best',
        icon: '✓',
        title: result.action === 'updated' ? 'Product updated' : 'Product added',
        text: bits.join(' · ') || 'Saved to the comparison.',
      });
    }
    return;
  }

  if (result?.message) {
    showBanner({
      tone: result.message.tone || 'warn',
      icon: result.state === 'punish' || result.state === 'error' ? '×' : '!',
      title: result.message.title,
      text: result.message.body,
      action: { label: result.state === 'no-results' ? 'Try again' : 'Re-scan' },
    });
    // Reflect the page we just rejected in the empty state, so the panel never
    // sits there looking idle.
    if (!records.length) await refreshContext();
  }
}

loadState();
