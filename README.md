# Alibaba Supplier Compare

A Chrome extension for comparing Alibaba suppliers side by side — tiered prices at the quantity
you actually need, MOQ, and supplier credentials — without juggling 20 browser tabs and a
spreadsheet.

![The comparison matrix](docs/screenshots/01-matrix-2qty.png)

---

## The problem it solves

Sourcing a product on Alibaba means opening dozens of tabs, squinting at price ladders, and
re-measuring which supplier is genuinely cheapest at *your* quantity. A $5,200 headline price
means something different at 1 unit than at 5, and a 2-set MOQ quietly rules out a supplier
entirely.

This extension turns that into one table. It computes the **effective unit price at a target
quantity** for every supplier you add, flags anyone whose MOQ is above that quantity, and sorts the
rest by real cost.

## Features

- **One-click capture.** Press the toolbar button on any Alibaba product page. The side panel opens
  and the product is added.
- **Transposed comparison matrix.** Suppliers are columns, fields are rows, so three or more
  suppliers read side by side in the panel without horizontal scrolling.
- **Real unit-price math.** A target-quantity field drives every price: the correct tier is
  selected, order totals are computed, and below-MOQ suppliers are flagged rather than quietly
  mispriced.
- **Supplier trust signals.** Verified Supplier, Trade Assurance, years on platform, business type
  (factory vs trading company), response rate, lead time.
- **Honest data quality.** Every field records which extraction layer read it, and the panel shows
  "not shown" when a page simply does not publish something — it never guesses a `No`.
- **Export to Sheets** (tab-separated, one click, pastes into clean cells), **CSV download**, and a
  **formatted quote summary** for sending to a client or your team.
- **Currency-safe.** Suppliers quoting in different currencies are ranked in separate groups, never
  against each other, because a stale exchange rate would produce a confidently wrong winner.
- **Filters** for verified suppliers, factories only, below-MOQ, and partial data.

## Install

### From source (for development)

1. `git clone` this repository, or download and unzip it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.

Requires **Chrome 116 or newer** (for the side panel and `sidePanel.open`).

### Using it

1. Open an Alibaba **product** page — a URL containing `/product-detail/`.
2. Press the **Alibaba Supplier Compare** toolbar button. The side panel opens and the product is
   added to your comparison.
3. Repeat for each supplier you are considering.
4. Set **Target qty** at the top. The price row re-sorts instantly to the true unit cost at that
   quantity.
5. **Copy for Sheets** to paste the table into a spreadsheet, or **Quote summary** to send a clean
   comparison to a client.

## How the extraction works

Alibaba does not put product data in clean HTML. It ships a large JSON object in the page source
(commonly `window.detailData`). A normal content script cannot read it, because Chrome isolates
extension scripts from page scripts. The extension therefore injects a single function with
`chrome.scripting.executeScript({ world: 'MAIN' })`, which can read the page's own variables.

The reader is deliberately built in four fallback layers, so a layout change on Alibaba's side
degrades gracefully instead of breaking:

| Layer | Method | Reliability |
|---|---|---|
| 1 | Known paths in the JSON (`componentsVO.*`, `globalData.product.*`) | Best |
| 2 | A recursive walk of that JSON matching field names by pattern | Survives renames |
| 3 | `schema.org` JSON-LD on the page | Good when present |
| 4 | A label scan of the visible page text | Last resort |

**Every field remembers which layer produced it.** If a field ever shows "not found", the panel's
diagnostics can tell you exactly which layer broke — that is the difference between a five-minute
fix and an afternoon of guessing.

### When Alibaba shows a verification screen

Alibaba sometimes interposes a CAPTCHA instead of the product page. It is served as a normal
`200 OK`, so a naive scraper reads it as a product with no data and silently stores a blank
supplier. This extension detects the BaXIA/AWSC markers and shows an explicit
"verification screen" state with a **Re-scan** button, and **saves nothing**. A blank row is worse
than an error, because you would not know to distrust it.

## Diagnosing a broken field

If a field stops appearing, an update to Alibaba's markup is the likely cause.

1. Open the panel's settings (sliders icon) → **Copy diagnostic snapshot**. It copies the field
   provenance report and the key paths the extension found, to your clipboard.
2. To test a candidate field name against real data without touching Alibaba, run the offline
   harness: `npm run serve` (or `python3 -m http.server 8099`) and open
   `http://127.0.0.1:8099/tools/diagnostics.html`. Paste a `window.detailData` blob (or load the
   sample) and press **Test extraction**. It shows every field, which layer read it, and the list of
   key paths to search for a fix.
3. Add the new field name to the matching key pattern in `src/extract/normalize.js`.

## Development

```bash
npm test        # 68 unit tests: comparison math, all four extraction layers, exports
npm run icons   # regenerate the PNG icons (pure Python, no dependencies)
npm run preview # render the side panel in a real browser and screenshot every state
```

The comparison math, the four-layer extractor, and the brace-balanced JSON reader are all covered by
unit tests, including the edge cases that produce a wrong "winner" if they regress — tier
boundaries, below-MOQ pricing, mixed currencies, and booleans that are absent rather than false.

To load the panel standalone (useful while styling), run the preview script, which serves the
project and screenshots the empty state, the matrix, filters, the verification-screen state, and a
narrow and wide viewport.

## Privacy

Everything stays on your computer in `chrome.storage.local`. No server, no account, no analytics,
no network requests. See [PRIVACY.md](PRIVACY.md).

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `activeTab` | Read the one product page you point the button at, only when you press it. This is why the extension does **not** need blanket access to `alibaba.com`. |
| `scripting` | Inject the reader into that one page. |
| `sidePanel` | Show the comparison panel. |
| `storage` | Keep your comparison and settings on your machine. |

## Project layout

```
manifest.json
DESIGN.md                    design system, written before the UI
PRIVACY.md
src/
  background.js              service worker: capture, storage, export
  extract/
    harvest.js               MAIN-world reader (runs inside the page)
    normalize.js             four-layer field mapping + provenance
  lib/
    schema.js                record shape, normalisation, confidence
    compare.js               target-quantity math, ranking (pure)
    probe.js                 page classification, CAPTCHA detection
    store.js                 local persistence
    exporters/               tsv.js, clientSummary.js, index.js
  panel/                     side panel UI (html/css/js)
tools/
  make_icon.py               pure-Python icon generator (no dependencies)
  diagnostics.html           offline extractor test harness
  panel-preview.mjs          render + screenshot the panel
test/                        68 unit tests
docs/screenshots/            panel states
```

## Licence

MIT. See [LICENSE](LICENSE).
