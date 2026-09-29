# DESIGN.md — Alibaba Supplier Compare

Design system for the Chrome side panel. Written **before** any UI code, on purpose: the panel lives
directly next to Alibaba's own loud orange interface, so it must be visually calm enough to read a
dense price matrix without fighting the page.

---

## 1. Context and constraints

| Constraint | Consequence |
|---|---|
| Chrome side panel, ~320–520px wide, resizable | A wide spreadsheet is impossible. The matrix is **transposed**: fields are rows, suppliers are columns. |
| Dense B2B data (numbers, flags, names) | Tabular numerals are mandatory, not optional. Rows must align vertically. |
| Sits beside Alibaba's orange product page | Neutral, desaturated palette. One accent, used sparingly. |
| Comparison is the product, not extraction | The winning price must be the single most visible thing on screen. |
| Reads in seconds while browsing | Target quantity drives everything; the user should not have to scroll to see the answer. |

## 2. Layout model

```
┌─────────────────────────────────────┐
│  HEADER            [settings] [×]    │  sticky, 48px
│  Target qty  [  2  ] units   $ USD  │  control bar, sticky, 56px
├─────────────────────────────────────┤
│                                     │
│   FIELD ═══════ SUPPLIER A SUPPLIER B│  ← transposed matrix
│   Unit price   $4,850.00  $5,200.00 │  ← pinned best row
│   Total @ Qty  $9,700.00 $10,400.00 │
│   MOQ          1 set       1 set    │
│   Supplier     Hangzhou…   Ningbo…   │
│   Years        12          7         │
│   Verified     ✓           —         │
│   …                                 │
│                                     │
├─────────────────────────────────────┤
│  FOOTER  [Copy TSV] [Quote] [Clear] │  sticky
└─────────────────────────────────────┘
```

**Why transposed:** with 3–6 suppliers, one supplier per column means the eye can scan *down* a
column to read that supplier's whole profile, and scan *across* the "Unit price" row to find the
winner. The opposite orientation (suppliers as rows) would require 15+ horizontal scrolls.

**Sticky:** header, control bar, the "Unit price @ Qty" row, and the footer. The pinned price row is
what the user came for; it must never scroll out of view.

**Sticky first column:** field names stay put while supplier columns scroll.

## 3. Colour

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--canvas` | `#FBFAF8` | `#16181B` | Panel background |
| `--surface` | `#FFFFFF` | `#1E2125` | Cards, header, footer |
| `--surface-2` | `#F3F1ED` | `#262A30` | Row banding, inputs |
| `--ink` | `#16181D` | `#E8EAED` | Primary text |
| `--ink-soft` | `#5C6470` | `#98A1AD` | Secondary text, units |
| `--ink-faint` | `#8A919C` | `#6C7580` | Disabled, hints |
| `--line` | `#E6E3DE` | `#2C3138` | Hairlines |
| `--accent` | `#3A5BC7` | `#7A93E8` | Primary actions, focus ring |
| `--best` | `#17795E` | `#3FBF96` | Best unit price, verified ✓ |
| `--warn` | `#9A6700` | `#D9A441` | Below MOQ, low confidence |
| `--danger` | `#B3261E` | `#E8776E` | Errors, verification screen |

**Contrast:** every text token meets WCAG AA (≥4.5:1) against its own background. `--ink-faint` is
used only for non-essential hints and never for a value the user must read.

**Accent discipline:** `--accent` is the only colour used for interactive chrome. Green, amber and
red are *reserved for data meaning* and never used for buttons. This stops "is that a button or a
warning?" ambiguity in a panel where the data is dense.

## 4. Type

- Stack: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
- **All numeric cells: `font-variant-numeric: tabular-nums`** and `font-feature-settings: "tnum"`.
  Without this, digits have differing widths and columns of prices will not align, which makes a
  comparison table genuinely hard to read.
- Scale: 11px (labels, units) · 12px (table body) · 13px (body) · 15px (section) · 17px (panel title)
- Weights: 400 body, 500 labels, 600 numbers and headings. Never 200/300 at these sizes.
- Field labels are 11px, `--ink-soft`, uppercase, `letter-spacing: .04em`.

## 5. Spacing, radius, elevation

- Spacing scale: `4 / 8 / 12 / 16 / 24 / 32`. Only these values.
- Radius: `6px` inputs and buttons · `10px` cards · `999px` pills and badges.
- Elevation: one level only — `0 1px 2px rgba(0,0,0,.06)` on the header and footer. The panel is
  already visually separated from the page; heavy shadows would be noise.
- Interactive row/cell height: **min 40px**, buttons min 36px. Comfortable for a side panel,
  which is clicked, not tapped.

## 6. Motion

Deliberately minimal — a data panel, not a toy.

| Interaction | Motion |
|---|---|
| Column added | 180ms opacity 0→1 + 4px translateY |
| Cell value updates on quantity change | 120ms colour flash on `--best` only |
| Panel state change (empty→matrix) | 200ms ease-out fade, no slide, no bounce |
| Best-price marker | Static. No pulse, no glow loop. |

All motion is wrapped in `@media (prefers-reduced-motion: reduce)` → transitions removed. No
elastic easing, no slide-in-from-offscreen, no attention-seeking animation.

## 7. State coverage

Every state below is a real, designed screen — not an afterthought.

| State | Treatment |
|---|---|
| **Empty** | Centred: one-line explanation, the single action to take, and a 3-step how-it-works list. Never a blank panel. |
| **Not an Alibaba product page** | Explains which URLs are supported, lists the real product-page URL pattern. |
| **Scanning** | Shimmer bar + "Reading product data…" on the target row. No fake progress %. |
| **Verification screen** | `--danger` banner: "Alibaba is showing a verification screen." + explain + **Re-scan** button. Explicitly states nothing was saved. |
| **Low confidence** | Amber badge on the cell *and* a row-level warning; a banner lists which fields are missing. Never a blank cell with no explanation. |
| **Mixed currency** | If suppliers report different currencies, the price row shows each in its own currency and marks the row as non-comparable with a warning, rather than silently converting at a stale rate. |
| **Duplicate** | Re-adding a product already in the list updates it and reports "updated", not a second row. |
| **Storage error** | Inline error with a retry, no silent failure. |

## 8. Meaning never carried by colour alone

Every flag has a glyph and a text label:

- Verified supplier → `✓` glyph + word "Yes"/"No"
- Below MOQ at target qty → `!` glyph + "Below MOQ"
- Best price → "Best" text label + a left border on the column
- Low confidence → `~` glyph + "Partial"

This satisfies the accessibility rule that colour must not be the only channel, and it also survives
the common case of a user on a poor monitor in a bright warehouse.

## 9. Comparison arithmetic (the product)

For a target quantity `Q`, each supplier resolves to:

1. Find the price tier where `minQty ≤ Q ≤ maxQty` → `unitPrice`
2. If `Q < moqQty` → flag **Below MOQ**, and additionally compute `unitPriceAtMoq` for reference
3. `total = unitPrice × Q` (order in the supplier's own currency)
4. Rank by `unitPrice` ascending; ties broken by years-on-platform descending

If two suppliers report different currencies, they are ranked **separately per currency group** and
the panel states that no cross-currency ranking is shown. A wrong conversion is worse than no
conversion.

## 10. Rejected alternatives

- **Supplier-as-row wide table** — unreadable in a 400px panel without heavy horizontal scrolling.
- **A full dashboard tab** — more screen real estate, but breaks the "compare while browsing" loop
  that is the entire reason the panel exists. Deferred to v2, not rejected on merit.
- **Live conversion to a single currency** — requires a rate source, introduces staleness and a
  network dependency, and can silently produce a wrong "winner".
- **Colour-coded price heatmap** — implies a value judgement the data does not support, and fails
  the colour-independence rule.
