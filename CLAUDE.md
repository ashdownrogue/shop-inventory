# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first, offline-capable PWA that audits a 1,534-item garage shop checklist. No build step for the frontend; `app.js` is plain ES5 (`var`, no modules, no classes) run directly in the browser. An optional Postgres-backed sync API (`api/`, `lib/`) can be turned on for in-app checklist editing and cross-device sync — see "Sync backend" below. Without it configured, the app is exactly the static, zero-dependency tool it always was.

## Commands

```bash
npm start          # python3 -m http.server 8899 — serve locally, open http://localhost:8899
npm test           # node tests/smoke.js — headless smoke suite
npm run seed-db     # one-time: loads data/checklist.md into Postgres with frozen ids
```

There is no lint/build/typecheck step for the frontend. A plain `file://` open will not work (the app `fetch`es the checklist and registers a service worker); always serve it.

`tests/smoke.js` boots `app.js` inside a jsdom window (stubbing `fetch`, `indexedDB`, `localStorage`, `wakeLock`) and runs sequential DOM assertions (status cycling, bulk mark, filters, search, expander, quantity stepper, buy list, exports, editor CRUD, multi-level undo). No network calls happen in this harness, so a passing run is also a regression check that the app still works fully offline with sync unconfigured. It's a single flat script, not a framework — add new checks by pushing more `check(name, cond, extra)` calls in the existing sequence.

Two traps when adding tests, both of which have already caused real breakage:

- **Assert through the DOM only — never `w.someGlobal`.** `app.js` opens with `'use strict'`, and strict-mode indirect eval (which is what jsdom's `w.eval(...)` is) gets its own variable environment: top-level `var`/`function` declarations do *not* land on `window`. `w.ui`, `w.index`, `w.seed` are all `undefined` no matter what the app is doing. Drive state through real DOM events and read results back out of the rendered DOM.
- **Order matters, and leftover UI state leaks forward.** Each check mutates state the next one reads. In particular `ui.query` is shared between the section search and the global search, so a test that types into either one leaves every later section view filtered until something clears it. Clear the search input (set `.value = ''` and dispatch `input`) before any later check that expects a full list. The `ui.query` assignment in `onInput` is synchronous — only the re-render is debounced 140ms — so if the next action triggers its own render, no wait is needed.

Deploy is Vercel (static frontend + zero-config serverless functions under `/api`; see `vercel.json` for cache headers on `sw.js`, `data/checklist.md`, and `icons/`); there's no CI config in the repo.

## Architecture

**`data/checklist.md` is the factory-default seed, not necessarily the live source of truth.** `app.js` fetches and parses it in the browser on first load (`parseChecklist`, ~app.js:73). Once a device has any local edits or has ever synced, its locally-persisted `seed` (IndexedDB) takes over from the freshly-parsed markdown on every subsequent boot — the markdown file is the bootstrap default and the input to the one-time `scripts/seed-db.js` migration, not something re-read into an already-initialized device. The parser derives item structure from heading levels:

- `## N. Title` → section
- `### N.M Title` → subsection
- `- [ ] label` → item, with inline syntax parsed out of the label text: `count: ______` (quantity-tracked), `(want N+)` (restock target), `Model: ______` (spec text field), `(Phase N)` (phase tag)

**Item IDs are content-derived at parse time** (`section-subsection-slug`, e.g. `s03-09-19-mm`) but frozen from then on — `renameEntity()` changes `label`/`title` only, never recomputes `id`. This used to be a real bug (editing a label silently orphaned its marks via `slugify`); it's fixed by treating `id` as assign-once. `scripts/seed-db.js` runs the exact same parse/slugify logic as `app.js` so a fresh Postgres seed's ids match whatever any already-deployed browser already has stored locally.

**Two data graphs, both keyed by item id, now both mutable:**
- `seed` / `index` / `flat` — the checklist structure. Edited in-app via `createItem`/`createSubsection`/`createSection`/`renameEntity`/`deleteEntity`/`undeleteEntity`/`moveEntity` (app.js, "checklist editing" section), each of which stamps `updatedAt` on the touched node and calls `buildIndex()` to rebuild `index`/`flat`. Deletes are soft (`deleted: true`, cascaded onto children by `setDeletedCascade()`) and filtered out in `buildIndex()` plus at every call site that iterates `seed.sections`/`sub.items` directly instead of via `flat` (`sectionStats`, `viewIndex`, `viewSection`, `renderList`, `viewSettings`, `exportMarkdown` — grep `.deleted` if adding another one). Because a soft-deleted item is absent from `index`, any lookup that must reach a possibly-deleted item goes through `findItemAnywhere()` (walks the raw `seed` tree) rather than `index[id]`.
- `user` — the audit state (`{ s: status, q: qty, sp: spec, n: note, c: cost, u: updatedAt }` per id).

Both persist to IndexedDB (`idbSet`/`idbGet`, DB `shop-inventory`, store `kv`, key `user-v1`) with a `localStorage` JSON fallback if IndexedDB is unavailable. Writes are debounced 180ms through `persist()`, which also triggers a debounced sync push when sync is enabled.

**Status model**: `CYCLE = ['unknown','have','missing','upgrade','blocking','na']`. Tapping the status glyph advances through this cycle; tapping the item body opens an expander with explicit set buttons plus quantity/spec/note/cost fields. `GAPS = {missing,upgrade,blocking}` defines what counts as a "gap" for stats and the buy list.

**Restock logic is intentionally conservative**: an item is only "restock" (`isRestock()`) if it has a `target`, is *not* `na`, and has actually been counted (`q !== null`). An uncounted consumable never silently appears on the buy list — this is called out in the README and covered by a smoke test; preserve it.

**Rendering is hand-rolled string-concat HTML**, no virtual DOM/templating library. Views (`viewIndex`, `viewSection`, `viewBuy`, `viewSettings`) build an HTML string and set `innerHTML`. A single delegated click handler (`onClick`) and input handler (`onInput`) on `#view` dispatch on `data-act` attributes (`cycle`, `set`, `expand`, `qty`, `collapse`, `bulk`, `chip`, `group`, `got`, `theme`, `wake`, `reset`, `dl-json`, `dl-md`, `dl-csv`, `copy-md`, plus the editor/sync ones below). When adding a new interactive control, follow this pattern (a `data-act` value + a branch in `onClick`/`onInput`) rather than attaching a new listener.

**Checklist editing** lives inside `viewSection` (an "Edit" toggle, `ui.editMode`, reveals inline rename fields plus move/delete/add-item/add-subsection controls) and `viewSettings` (a "Checklist" card for renaming/reordering/deleting whole sections, plus "+ Add section"). Editor `data-act` values: `edit-toggle`, `move`, `delete-entity`, `add-item`, `add-sub`, `add-sec`, `sec-move`, `sec-delete`; sync ones: `sync-login`, `sync-logout`, `sync-now`. Renaming an item/section title goes through `onInput`'s `data-fld` dispatch (`label` and `sec-title`), calling `renameEntity()` instead of the mark-record `touch()` path.

**Sync** ("sync" section of app.js, above "helpers"): `POST /api/sync` pushes whatever local content/marks changed since the last successful sync (`collectChanged`, gated on each node's own `updatedAt` vs. `sync.lastSyncedAt` — no separate dirty-tracking set) and pulls back everything changed server-side, merged with the same last-write-wins-by-`updatedAt` rule the JSON import already used (`applyServerState`/`mergeSectionRow`/`mergeSubsectionRow`/`mergeItemRow`/`mergeMarkRow`). Triggered after `persist()` (debounced via `queueSyncPush`), on `online`, on `visibilitychange`→visible, and once at boot if `prefs.syncEnabled`. Fails silently to local-only on any network/auth error — sync is additive, never a requirement for the app to function. `syncLogin`/`syncLogout` hit `/api/auth/login`/`logout`; auth is a single shared passphrase (see "Sync backend" below), not per-user accounts.

**Undo is a real multi-level stack** (`undoStack`, capped at `UNDO_MAX` = 50), not the single-slot "last change" the toast originally had. Every recordable mutation pushes an entry carrying just enough to invert itself (`{kind: 'status'|'bulk'|'qty'|'create'|'delete'|'rename'|'move', ...}`); `performUndo()` pops one and hands it to `applyInverse()`. Three things to know before touching it:

- **Every mutating function takes a trailing `record` argument.** Passing `record === false` performs the mutation *without* pushing an undo entry. This is the load-bearing invariant: `applyInverse()` calls the same public mutators with `record: false` so undoing doesn't itself get recorded and trap you in a loop. A new mutator must follow the same shape or it will corrupt the stack.
- `create` and `delete` are exact inverses of each other over the soft-delete cascade, so undoing either just flips `deleted` back via `setDeletedCascade()`.
- **Renames record once per edit session, not per keystroke.** A `focusin` listener snapshots the field's value into the `renameOriginal` map; `input` events live-update the model with `record: false`; the `change` event (fires once, on blur) is what actually pushes a single undo entry diffed against the snapshot.

Free-text fields (note, spec, cost) are deliberately *not* on the stack — per-keystroke entries would swamp it, and the browser's native field-level undo already covers them. For the same reason the `Ctrl/Cmd+Z` handler bails out when focus is in an `INPUT`/`TEXTAREA`, leaving native text undo intact. Undo is reachable three ways: the toast's Undo button, a persistent header pill (`#undoBtn`/`#undoCount`, hidden when the stack is empty, repainted by `renderUndoBadge()`), and the keyboard shortcut. `reset` clears the stack, since its entries would reference marks that no longer exist.

**Routing** is hash-based (`route()`): `#/` (index), `#/s/<sectionId>` (section drill-in), `#/buy` (buy list), `#/settings`. No history/router library.

**Store classification** (`classifyStore`) keyword-matches an item's label + section title against `STORE_RULES` to tag it Welding supply / Hobby shop / Electronics / Auto parts / Harbor Freight / General, used purely for buy-list grouping. Duplicated (deliberately, verbatim) in `scripts/seed-db.js` since that script can't `require` browser code.

**Safety/consumable tagging** happens at parse time: everything in Section 1 is tagged `safety`, as is any subsection whose title mentions fire/medical/safety/battery/charging; any item with a quantity field is tagged `consumable`.

**Exports** (`exportMarkdown`, `exportBuyMarkdown`, `exportCsv`) regenerate output purely from `seed` + `user`, skipping `.deleted` nodes — there's no separate export data model to keep in sync.

**Import/restore** (`onInput`, `importFile` branch) merges a JSON backup's `user` map into the live one, last-write-wins by the `u` (updatedAt) timestamp per item — the same merge rule `applyServerState` uses for network sync.

**Service worker** (`sw.js`) is cache-first for the app shell with a background revalidate; on fetch failure it falls back to cached `index.html`. **Bump `CACHE` (currently `shop-inv-v2`) in the same commit as any change to `index.html`/`app.js`/`styles.css`** — otherwise returning devices keep booting the previous shell and the change looks like it simply didn't ship. The same cache-first behavior bites during local development: after editing, an already-registered worker will keep serving the old file, so verify in the browser only after unregistering the worker and clearing caches (`navigator.serviceWorker.getRegistrations()` → `unregister()`, then `caches.keys()` → `caches.delete()`), or you will be looking at stale output and drawing wrong conclusions.

## Sync backend

Optional, off by default (`prefs.syncEnabled`). See the README's "Cross-device sync" section for setup steps (Vercel Postgres, `db/schema.sql`, `SHOP_PASSPHRASE_HASH`/`SESSION_SECRET` env vars, `npm run seed-db`).

- `lib/auth.js` — passphrase check (scrypt against `SHOP_PASSPHRASE_HASH`) and stateless signed-cookie sessions (HMAC with `SESSION_SECRET`, no session table).
- `lib/db.js` — shared Neon serverless client (`@neondatabase/serverless`, HTTP driver, `DATABASE_URL`); `getChangedSince`/`upsertSections`/`upsertSubsections`/`upsertItems`/`upsertMarks`. Upserts enforce last-write-wins in SQL itself (`WHERE excluded.updated_at > table.updated_at`), not just trusted from the client.
- `api/auth/login.js`, `api/auth/logout.js`, `api/sync.js` — thin handlers over the above two libs.
- `db/schema.sql` — `sections`/`subsections`/`items` (content) + `marks` (audit state), mirroring the client's `seed`/`user` shapes.

This is the one place the project has a real npm dependency (`@neondatabase/serverless`) and server-side code — everything under `index.html`/`app.js`/`styles.css` remains dependency-free and ships unchanged whether or not sync is configured.

## Non-obvious constraints

- The frontend stays offline/local-only by design when sync isn't configured: no network calls except the initial fetch of `data/checklist.md`, the service worker's background revalidation, and (only if `prefs.syncEnabled`) `/api/*`. Don't make sync load-bearing for anything — every sync call must degrade to a no-op, not an error the user has to deal with.
- `app.js` is deliberately ES5/no-dependency on the client side — don't introduce a bundler, transpiler, or npm runtime dependency for the frontend without discussing it first. Server-side code under `api/`/`lib/`/`scripts/` is plain Node CommonJS and can use npm dependencies (currently just `@neondatabase/serverless`).
- `scripts/parse_checklist.py` and `scripts/make_icons.py` are standalone reference/regeneration tools, not part of the app's runtime path. `scripts/seed-db.js` *is* meant to be run (once, by hand) — see the README.
