# AGENTS.md — rules for working on this extension

## The rule that matters

**Never write a selector you have not seen in the real page.**

This extension shipped broken three times, every time for the same reason: the
extractor was written from an assumed idea of Alibaba's markup. Unit tests
passed. The build was green. The user got a full table of wrong values and had
to report it.

If you cannot get the page, you cannot write the extractor. Ask for a saved page
(Ctrl+S in Chrome lands in `~/Downloads`) and read it before writing code.

## Before you say "fixed"

```bash
node tools/verify-all.mjs
```

Seven stages, exit 0 only if all pass. It checks the real page, not just the
code:

| Stage | What it protects against |
|---|---|
| unit tests | logic regressions |
| pre-flight | manifest, permissions, broken imports |
| **capture contract vs the real page** | Alibaba changed the markup |
| **real-page capture** | the shipped extractor does not work on real HTML |
| **every panel state rendered** | a state that hides data, or an error in the console |
| **a broken capture is rejected** | the honesty layer being quietly broken |
| export shape | the sheet missing a required field or going ragged |

Then **look at the screenshots** in `docs/screenshots/`. Defects that survived
every automated check were found there: a panel that was correct but silently
empty because an invisible saved filter hid every row.

## The capture contract

`docs/capture-contract.json` is the single source of truth for what a working
capture looks like: which anchors the page must have, which fields must be
filled, how much of them, and which export column each field reaches. Change the
extractor and the contract together, in the same commit.

Rules it encodes:

- **No class names.** Alibaba hashes them per deploy (`CawI5`, `TMl6f`, `f3wvg`).
  `tools/contract-check.mjs` fails the build if one appears.
- **Required fields must be present** on at least `minRatio` of rows. Everything
  else may be missing without an alarm — that is a note, not a failure.
- **A field the page does not publish shows `—`.** It is never guessed.

## Honesty rules

A capture is judged by whether the values are *plausible*, not by how many rows
it produced. A full table of wrong values is worse than an error, because it
looks like a result. `src/lib/health.js` enforces this:

- a company name that parses as a price (`US$5,000 Min. order: 1 set`) counts as
  **missing**, which is the exact failure that shipped twice
- a missing required field raises a banner naming the field and the row count
- a capture that had to fall back to label scanning is flagged as living on
  borrowed time

`docs/fixtures/broken-capture-v1.json` is the capture that actually shipped
broken. The gate asserts it is still rejected.

## One paste fixes a bug

The panel's **Copy page structure** button copies the two result cards as they
are actually rendered, plus which anchors matched. If the extension ever breaks
again, that single paste is enough — no screenshots, no guessing, no asking the
user to describe what they see.

## House rules

- The extractor is **one self-contained function** on purpose: Chrome serialises
  it into the page, and that is what lets `tools/real-page-test.mjs` run the
  shipped code against a real DOM. Do not add imports or closure references.
- Every field records where it came from. That is what turns a five-minute fix
  into a five-minute fix.
- No field the page does not publish is ever invented. `—` is honest.
- Filters, sorting and hiding must always say what they are hiding and offer a
  way to see it. A panel that looks empty must never be silently empty.
- `npm test` must stay fast and browser-free; browser work lives in `tools/`.
