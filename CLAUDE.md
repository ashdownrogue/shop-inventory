# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first, offline-capable PWA that audits a 1,534-item garage shop checklist. No build step, no backend, no dependencies. Static files served as-is; `app.js` is plain ES5 (`var`, no modules, no classes) run directly in the browser.

## Commands

```bash
npm start          # python3 -m http.server 8899 — serve locally, open http://localhost:8899
npm test           # node tests/smoke.js — headless smoke suite (needs `npm install jsdom` once)
```

There is no lint/build/typecheck step. A plain `file://` open will not work (the app `fetch`es the checklist and registers a service worker); always serve it.

`tests/smoke.js` boots `app.js` inside a jsdom window (stubbing `fetch`, `indexedDB`, `localStorage`, `wakeLock`) and runs ~31 sequential DOM assertions (status cycling, bulk mark, filters, search, expander, quantity stepper, buy list, exports, undo). It's a single flat script, not a framework — add new checks by pushing more `check(name, cond, extra)` calls in the existing sequence; order matters because each check mutates DOM state the next one reads.

Deploy is Vercel static hosting (see `vercel.json` for cache headers on `sw.js`, `data/checklist.md`, and `icons/`); there's no CI config in the repo.

## Architecture

**Single source of truth is `data/checklist.md`.** `app.js` fetches and parses it in the browser on every load (`parseChecklist`, ~app.js:73). There is no build-time codegen step — editing the checklist means editing that markdown file and reloading. The parser derives item structure from heading levels:

- `## N. Title` → section
- `### N.M Title` → subsection
- `- [ ] label` → item, with inline syntax parsed out of the label text: `count: ______` (quantity-tracked), `(want N+)` (restock target), `Model: ______` (spec text field), `(Phase N)` (phase tag)

**Item IDs are content-derived** (`section-subsection-slug`, e.g. `s03-09-19-mm`), not positional, so reordering/editing checklist lines doesn't orphan a user's existing marks — this is the load-bearing invariant behind everything else. Don't change `slugify`/ID derivation without considering that it will disconnect all saved audit data from its items.

**Two separate data graphs, both keyed by item id:**
- `seed` / `index` / `flat` — the parsed checklist structure (immutable per session, rebuilt via `buildIndex()` on boot)
- `user` — the audit state (`{ s: status, q: qty, sp: spec, n: note, c: cost, u: updatedAt }` per id), persisted to IndexedDB (`idbSet`/`idbGet`, DB `shop-inventory`, store `kv`, key `user-v1`) with a `localStorage` JSON fallback if IndexedDB is unavailable. Writes are debounced 180ms through `persist()`.

**Status model**: `CYCLE = ['unknown','have','missing','upgrade','blocking','na']`. Tapping the status glyph advances through this cycle; tapping the item body opens an expander with explicit set buttons plus quantity/spec/note/cost fields. `GAPS = {missing,upgrade,blocking}` defines what counts as a "gap" for stats and the buy list.

**Restock logic is intentionally conservative**: an item is only "restock" (`isRestock()`, app.js:248) if it has a `target`, is *not* `na`, and has actually been counted (`q !== null`). An uncounted consumable never silently appears on the buy list — this is called out in the README and covered by a smoke test; preserve it.

**Rendering is hand-rolled string-concat HTML**, no virtual DOM/templating library. Views (`viewIndex`, `viewSection`, `viewBuy`, `viewSettings`) build an HTML string and set `innerHTML`. A single delegated click handler (`onClick`, app.js:936) and input handler (`onInput`, app.js:1106) on `#view` dispatch on `data-act` attributes (`cycle`, `set`, `expand`, `qty`, `collapse`, `bulk`, `chip`, `group`, `got`, `theme`, `wake`, `reset`, `dl-json`, `dl-md`, `dl-csv`, `copy-md`). When adding a new interactive control, follow this pattern (a `data-act` value + a branch in `onClick`/`onInput`) rather than attaching a new listener.

**Routing** is hash-based (`route()`, app.js:1189): `#/` (index), `#/s/<sectionId>` (section drill-in), `#/buy` (buy list), `#/settings`. No history/router library.

**Store classification** (`classifyStore`, app.js:60) keyword-matches an item's label + section title against `STORE_RULES` to tag it Welding supply / Hobby shop / Electronics / Auto parts / Harbor Freight / General, used purely for buy-list grouping.

**Safety/consumable tagging** happens at parse time: everything in Section 1 is tagged `safety`, as is any subsection whose title mentions fire/medical/safety/battery/charging; any item with a quantity field is tagged `consumable`.

**Exports** (`exportMarkdown`, `exportBuyMarkdown`, `exportCsv`, app.js:816+) regenerate output purely from `seed` + `user` — there's no separate export data model to keep in sync.

**Import/restore** (`onInput`, `importFile` branch, app.js:1133) merges a JSON backup's `user` map into the live one, last-write-wins by the `u` (updatedAt) timestamp per item.

**Service worker** (`sw.js`) is cache-first for the app shell with a background revalidate; on fetch failure it falls back to cached `index.html`. Bump `CACHE` (currently `shop-inv-v1`) when shipping changes that must not be masked by a stale cache.

## Non-obvious constraints

- Everything is offline/local-only by design: no network calls except the initial fetch of `data/checklist.md` and the service worker's background revalidation. Don't introduce a backend dependency casually — see the README's "Adding cross-device sync later" section for the intended additive path (the `updatedAt`-per-item model already supports last-write-wins sync).
- `app.js` is deliberately ES5/no-dependency (matches the "no build step" constraint) — don't introduce a bundler, transpiler, or npm runtime dependency without discussing it first.
- `scripts/parse_checklist.py` and `scripts/make_icons.py` are standalone reference/regeneration tools, not part of the app's runtime path.
