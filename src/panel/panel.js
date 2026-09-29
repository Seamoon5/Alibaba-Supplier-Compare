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
  syncControls();
  render();
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

  if (res.ok === false && res.error) {
    showBanner({
      tone: 'danger', icon: '×',
      title: 'Something went wrong',
      text: res.error,
    });
    return;
  }

  const result = res.result || res;
  if (result?.ok) {
    await loadState();
    const r = result.record;
    const bits = [];
    if (r.companyName) bits.push(r.companyName);
    if (r.priceTiers?.length) bits.push(`${r.priceTiers.length} price tier${r.priceTiers.length > 1 ? 's' : ''}`);
    showBanner({
      tone: 'best', icon: '✓',
      title: result.action === 'updated' ? 'Product updated' : 'Product added',
      text: bits.join(' · ') || 'Saved to the comparison.',
    });
    return;
  }

  if (result?.message) {
    showBanner({
      tone: result.message.tone || 'warn',
      icon: result.state === 'punish' || result.state === 'block' ? '×' : '!',
      title: result.message.title,
      text: result.message.body,
      action: { label: 'Re-scan' },
    });
  }
}

// ------------------------------------------------------------------ render

/**
 * True when a field was attempted but never actually read. "Verified: No" and
 * "no verified status published" are different claims and we must not conflate
 * them.
 */
const notRead = (r, field) => !r.provenance || r.provenance[field] === 'missing';

/** One row definition for the transposed matrix. */
function rowDefs() {
  return [
    {
      label: `Unit price @ ${settings.targetQty}`,
      key: true,
      cell: (c, _r, isBest) => {
        if (c.unitPrice === null) return html`<span class="muted">no price data</span>`;
        const tag = isBest ? raw('<span class="best-tag">Best</span>') : raw('');
        return html`<span class="val-num">${formatPrice(c.unitPrice, c.currency)}</span>${tag}`;
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
      label: 'Lead time',
      cell: (_c, r) => (r.leadTime ? html`${r.leadTime}` : html`<span class="muted">—</span>`),
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
    return;
  }

  const result = rank(records, settings.targetQty, {
    hideBelowMoq: settings.hideBelowMoq,
    verifiedOnly: settings.verifiedOnly,
    manufacturersOnly: settings.manufacturersOnly,
    hideLowConfidence: settings.hideLowConfidence,
  });

  // Header: one column per supplier, best column marked. A boundary is drawn
  // between currency groups so a "Best" in the second group can never be read
  // as beating the first group's best.
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

  // Anything filtered out entirely still needs to be visible, or the user
  // cannot tell a filter hid it from a failure to extract it.
  const shown = new Set(cols.map((c) => c.resolved.key));
  const hidden = records
    .filter((r) => !shown.has(recordKey(r)))
    .map((r) => ({ resolved: resolveSupplier(r, settings.targetQty), isBest: false, currency: r.currency, filtered: true }));

  const all = [...cols, ...hidden];

  const multi = result.groups.length > 1;

  el.matrixHead.innerHTML = `<tr><th class="col-label">Supplier</th>${all
    .map((c) => {
      const r = c.resolved.record;
      const sub = [
        c.currency,
        c.filtered ? 'filtered out' : null,
        r.confidence === 'low' ? 'partial data' : null,
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

  // Notes: cross-currency and filtering explanations.
  const notes = [];
  if (result.multipleCurrencies) {
    notes.push(
      `Suppliers quote in ${result.groups.length} currencies (${result.groups
        .map((g) => g.currency).join(', ')}). Each currency is ranked separately — no cross-currency winner is shown, because that would need a live exchange rate.`,
    );
  }
  if (hidden.length) {
    notes.push(`${hidden.length} supplier${hidden.length > 1 ? 's are' : ' is'} hidden by the current filters.`);
  }
  if (result.totalShown === 0 && records.length > 0) {
    notes.push('No supplier matches the current quantity and filters.');
  }
  el.fxNote.textContent = notes.join(' ');
  el.fxNote.hidden = notes.length === 0;
}

// ------------------------------------------------------------------ actions

el.btnRescan.addEventListener('click', capture);

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
  }
});

async function captureResultUi(result) {
  if (result?.ok) {
    await loadState();
    showBanner({
      tone: 'best', icon: '✓',
      title: result.action === 'updated' ? 'Product updated' : 'Product added',
      text: (result.record?.companyName || 'Saved to the comparison'),
    });
  } else if (result?.message) {
    showBanner({
      tone: result.message.tone || 'warn',
      icon: result.state === 'punish' ? '×' : '!',
      title: result.message.title,
      text: result.message.body,
      action: { label: 'Re-scan' },
    });
  }
}

loadState();
