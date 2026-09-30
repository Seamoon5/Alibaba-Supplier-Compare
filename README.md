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

- **One-click capture.** Press the toolbar button on an Alibaba product page. The side panel opens
  and the product is added.
- **Add a whole results page at once.** On an Alibaba search or supplier-directory page, one press
  adds every supplier currently on screen — name, MOQ, years, verified status, response time,
  on-time delivery, reorder rate and revenue. You do not have to click into 20 product pages first.
- **Reads the Suppliers tab the way it is actually built.** On the Suppliers tab each card is a
  *company*, so one card is one comparison row: the company name and flag come from the header, and
  the prices come from the product tiles on that card (`US$1,250-4,500`). The whole product strip is
  kept, so you can see what else the factory makes.
- **Transposed comparison matrix.** Suppliers are columns, fields are rows, so three or more
  suppliers read side by side in the panel without horizontal scrolling.
- **Real unit-price math.** A target-quantity field drives every price: the correct tier is
  selected, order totals are computed, and below-MOQ suppliers are flagged rather than quietly
  mispriced.
- **Supplier trust signals.** Verified Supplier, Trade Assurance, years on platform, business type
  (factory vs trading company), response time, on-time delivery, reorder rate, online revenue.
- **Honest data quality.** Every field records which extraction layer read it, and the panel shows
  "not shown" when a page simply does not publish something — it never guesses a `No`.
- **Unpriced suppliers are kept.** A supplier card with no published price is shown with its MOQ and
  credentials, and excluded from ranking rather than hidden.
- **Export to Sheets** (tab-separated, one click, pastes into clean cells), **CSV download**, and a
  **formatted quote summary** for sending to a client or your team.
- **Currency-safe.** Suppliers quoting in different currencies are ranked in separate groups, never
  against each other, because a stale exchange rate would produce a confidently wrong winner.
- **Filters** for verified suppliers, factories only, below-MOQ, and partial data. Active
  filters are always named above the comparison, so a panel that looks empty explains itself.
- **Sourcing facts Alibaba actually prints**: rating and review count, province, factory vs
  trading company from Alibaba's own flag, and the supplier's "Main products" list.

## Install

### From source (for development)

1. `git clone` this repository, or download and unzip it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.

Requires **Chrome 116 or newer** (for the side panel and `sidePanel.open`).

### Using it

1. **On a search or supplier-directory page** (e.g. `alibaba.com/search/page?SearchScene=suppliers`):
   press the toolbar button once to add every supplier shown on the page. Scroll so the results are
   on screen first — Alibaba replaces the list as you scroll.
2. **On a product page** (a URL containing `/product-detail/`): press the toolbar button to add that
   product with its full tiered price ladder. Repeat for each product you are comparing.
3. Set **Target qty** at the top. The price row re-sorts instantly to the true unit cost at that
   quantity, and anything whose MOQ is above it is flagged.
4. **Copy for Sheets** to paste the table into a spreadsheet, or **Quote summary** to send a clean
   comparison to a client.

The panel tells you which of these applies to the page you are actually on, so it never sits there
looking idle.

## How the extraction works

Alibaba does not put product data in clean HTML. On product pages it ships a large JSON object in
the page source (commonly `window.detailData`). A normal content script cannot read it, because
Chrome isolates extension scripts from page scripts. The extension therefore injects a single
function with `chrome.scripting.executeScript({ world: 'MAIN' })`, which can read the page's own
variables.

Results pages are different: the cards are built from the DOM and there is no single stable JSON
blob, so the results extractor anchors on the product links each card contains, walks up to the
card that owns the link, and label-scans the text. That survives class-name churn better than a
fixed selector list, and it means one card holding five products is one supplier, not five.

The two results tabs have genuinely different shapes and are read by different code:

| Tab | Card is | One card means | Price comes from |
|---|---|---|---|
| Products | one **offer** | one product row | the card's price-tier box |
| Suppliers | one **company** | one supplier column | that company's product tiles |

Alibaba rebuilds this page with **hashed class names** (`CawI5`, `TMl6f`, `f3wvg`) that
change per deploy, so nothing here matches on a class. What stays stable is the semantics:

| What | Selector that carries it |
|---|---|
| the card | `[data-supplier-card="true"]` |
| company id, factory flag, product ids | `data-dot-params` (JSON) |
| company name | the first `span[title]` that is not inside a product tile |
| country | `img[alt="countryFlag"]`, code in the next sibling, province in the previous |
| years on platform | `[data-supplier-card-gold-years]` |
| rating and review count | `.../5` text and `[data-supplier-card-reviews]` |
| each product, its price and its MOQ | `a[data-supplier-card-product]` |

Reading the Suppliers tab with the Products strategy is what broke v1.0: a price-tier box
became the supplier name (`US$5,000`), the country came out of the `US$` of a price (`US`),
and the whole page reported "no published price". A label-only fallback still runs when
`data-supplier-card` is absent, so a redesign degrades instead of emptying.

Alibaba writes USD as `US$`, not `USD`, so the price reader knows the symbol forms (`US$`, `C$`,
`A$`, `HK$`, `CN¥`, `€`, `£`, `₹`, …) as well as the ISO codes. A published *range*
(`US$1,250-4,500`) is stored as both ends: the low end ranks the row, the high end is shown beside
it and exported, because a sheet that shows only the low end quietly misquotes the supplier.

Each product on a supplier card carries its own minimum order — 2 pieces on one line, 500 on the
next — so the MOQ reported is the one belonging to the product actually being priced.

### Testing against a real page

`npm test` proves the code does what it was written to do. It cannot prove Alibaba still renders
the page that way, and three broken versions of this extension came from guessing at that. So:

```bash
# 1. Save a live page: open a suppliers search, press Ctrl+S, press Enter.
# 2. Run the shipped extractor against that saved HTML in a real browser:
npm run test:real
```

It prints every supplier it found with its country, factory flag, rating, price range, MOQ and
product count, and fails if any row is missing a name or a country. The capture it writes to
`docs/fixtures/real-capture-sample.json` feeds `npm run preview`, so the panel screenshots in
`docs/screenshots/` are rendered from **real extracted data**, not invented fixtures.

The product reader is built in four fallback layers, so a layout change on Alibaba's side degrades
gracefully instead of breaking:

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
npm test         # 83 unit tests: comparison math, both extractors, all four layers, exports
npm run icons    # regenerate the PNG icons (pure Python, no dependencies)
npm run preview  # render the side panel in a real browser and screenshot every state
npm run verify   # pre-flight checks: manifest, permissions, module graph, no remote code
npm run live-test  # load the extension into a real browser and try it on a real Alibaba page
```

The comparison math, both extractors, the four-layer reader and the brace-balanced JSON reader are
all covered by unit tests, including the edge cases that produce a wrong "winner" if they regress —
tier boundaries, below-MOQ pricing, mixed currencies, booleans that are absent rather than false,
and suppliers that have no price at all.

`npm run preview` serves the project and renders the panel in real Chromium, asserting layout
facts rather than just taking pictures: the matrix and the empty state, search and home page
contexts, the verification-screen state, a supplier-origin matrix, and narrow and wide viewports.

`npm run live-test` is the one that matters for extractor changes. It loads this extension into a
real Chromium, points it at a live Alibaba page, and reports whether the page was reachable and
whether the CAPTCHA interstitial was detected. From a datacenter IP you will normally get
`BLOCKED (Alibaba CAPTCHA)`, which is itself the confirmation that the detection works. To
validate the extractors against pages Alibaba will actually serve, run it from a machine with a
logged-in Chrome profile, or press the toolbar button on a real page and send in the diagnostic
snapshot from the panel.

## Privacy

Everything stays on your computer in `chrome.storage.local`. No server, no account, no analytics,
no network requests. See [PRIVACY.md](PRIVACY.md).

The extension has standing read access to `alibaba.com` pages only, and the `tabs` permission is
deliberately **not** requested, so it cannot see the URL or title of any other site you visit.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `https://*.alibaba.com/*` (host access) | Read the product data and the page's own URL on Alibaba pages. Scoped to Alibaba and nothing else. |
| `scripting` | Inject the reader into those pages. |
| `sidePanel` | Show the comparison panel. |
| `storage` | Keep your comparison and settings on your machine. |

**Why host access rather than `activeTab`.** The first version asked for `activeTab` only, which
grants access for a single invocation. That is genuinely more private, but the grant does not
survive a navigation, so the **Re-scan button could not read the tab URL at all** — it reported
"Not a product page" while sitting on a search results page, and could not inject into the page
either. That is worse than a narrower permission list with a working button, so the extension now
asks for Alibaba-only host access. It still cannot see any other site, and it does not request the
broad `tabs` permission.

## Project layout

```
manifest.json
DESIGN.md                    design system, written before the UI
PRIVACY.md
src/
  background.js              service worker: capture, storage, export
  extract/
    harvest.js               MAIN-world product-page reader (runs inside the page)
    search.js                MAIN-world results-page reader
    normalize.js             four-layer field mapping + provenance
  lib/
    schema.js                record shape, normalisation, confidence
    compare.js               target-quantity math, ranking (pure)
    probe.js                 page classification, CAPTCHA detection, URL routing
    store.js                 local persistence
    exporters/               tsv.js, clientSummary.js, index.js
  panel/                     side panel UI (html/css/js)
tools/
  make_icon.py               pure-Python icon generator (no dependencies)
  diagnostics.html           offline extractor test harness
  panel-preview.mjs          render + screenshot the panel
  verify.mjs                 pre-flight / store-readiness checks
  live-test.mjs              run the real extension against a live Alibaba page
  real-page-test.mjs         run the extractor against a page you saved (Ctrl+S)
test/                        90 unit tests
docs/screenshots/            panel states, rendered from a real capture
docs/fixtures/              a real capture, committed so previews are never invented
```

## Version history

| Version | Date | What changed |
|---|---|---|
| **2.1.0** | 2026-09-30 | **Rewritten against a real saved page.** The Suppliers tab is marked up with hashed class names and was being read by guesswork. Now every field comes from a stable signal: `data-supplier-card`, `data-dot-params` (company id + Alibaba's own factory flag), `span[title]` for the name, `img[alt="countryFlag]` for the country and province, `data-supplier-card-gold-years`, `data-supplier-card-reviews`, `a[data-supplier-card-product]` for each product's price and its own MOQ. Adds rating, review count, province and Main products to the panel and the export. New `npm run test:real` runs the shipped extractor against a page you saved with Ctrl+S, in a real browser, and fails if any supplier comes back without a name or a country; its capture renders the panel screenshots. The panel now names the active filters instead of saying "hidden by the current filters". Fixed: a card with no `title` attribute lost its name because the fallback reader was handed a pipe-joined string instead of the card text; `<1k` revenue was dropped because the reader had no comparator; product offers were lost on layouts without product-tile markers. |
| **2.0.0** | 2026-09-29 | **The Suppliers tab is read correctly.** The company card is now measured from its header (name, flag, badges, credentials) and its prices come from the product tiles, not from the price-tier box. Fixes `US$5,000` appearing as a supplier name and `US` as a country, and the whole page reporting "no published price". New: price ranges kept (`up to X`), the product strip shown in the panel, `Unit price up to` / `Products listed` / `Other products` columns in the export, clearer note about unpriced suppliers. `Response time` keeps its `<` so `<1h` is not flattened to `1h`. |
| 1.2.0 | 2026-09-29 | Re-scan could not read the page at all. `activeTab` is a single-use grant that does not survive a navigation, so the toolbar click consumed it. Now requests `https://*.alibaba.com/*` host access (still no `tabs`). Verified end to end on a real suppliers search. |
| 1.1.0 | 2026-09-29 | Fixed the panel appearing to do nothing (capture result is persisted and replayed to the panel) and added support for the Suppliers results page. 82 unit tests. |
| 1.0.0 | 2026-09-29 | First release: capture, transposed comparison matrix, target-quantity math, filters, TSV/CSV/quote export. |

## Licence

MIT. See [LICENSE](LICENSE).
