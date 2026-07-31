# Shop Inventory: sync backend + in-app checklist editor

## Context

Today `data/checklist.md` is the single source of truth for the 1,534-item
checklist, hand-parsed in the browser on load. There is no way to change it
except: edit the markdown by hand, respect fragile inline syntax
(`count: ______`, `(want N+)`, `(Phase N)`), commit, push, and wait for a
Vercel redeploy. Marks (have/missing/qty/notes/cost) live only in one
browser's IndexedDB — nothing syncs between devices.

Two problems, one root cause: there's no backend. This plan adds one —
a Postgres database + a handful of serverless API routes on Vercel, gated
by a single shared passphrase — and uses it for two things:

1. **Checklist content becomes editable in the app itself.** Add a tool,
   rename a line, add a section — no more hand-editing markdown or
   redeploying.
2. **Everything syncs across devices** — both the checklist content and the
   audit marks — using the last-write-wins-on-`updatedAt` approach the
   README already sketched for this exact purpose.

The app stays local-first and works fully offline; the backend is an
enhancement layered on top, not a replacement for that.

### A bug this plan also fixes

Item IDs today are derived from the item's label text (`slugify(label)`).
Editing a label to fix a typo silently changes the item's ID, which
orphans any mark already recorded against it. This has to be fixed for
in-app editing to be safe at all — see "ID stability" below.

## Architecture

**Database: Vercel Postgres (Neon).** Relational, fits the
section → subsection → item hierarchy directly, native Vercel integration,
usable free tier for a dataset this small (~1,600 rows total).

**Auth: single shared passphrase.** `POST /api/auth/login` checks the
passphrase against a hashed value in an env var (Node's built-in `scrypt`,
no dependency needed) and issues an HMAC-signed, HttpOnly, `Secure` cookie
(`SESSION_SECRET` env var) with a 30-day expiry. No user accounts, no
external auth library — matches the README's original sketch and the
project's "no unnecessary dependencies" ethos. Every `/api/*` route except
`login` requires a valid cookie.

**Sync model: single bidirectional endpoint, since-cursor + LWW.**
`POST /api/sync` takes `{ since, items, marks }` (the client's local
changes with their `updatedAt` timestamps, plus the last time it synced)
and returns `{ items, marks, now }` (everything changed server-side since
`since`, after merging the client's push with last-write-wins per record).
This is one endpoint instead of separate CRUD routes per entity, and it
reuses the merge-by-`updatedAt` logic that already exists in
`onInput`'s `importFile` handler in [app.js](app.js) — same algorithm,
now also run against the network instead of only against an imported
JSON file.

**ID stability.** Add a real `id` column that is *set once and never
recomputed*. A one-time migration script parses `data/checklist.md` with
the exact same `slugify` logic `app.js` uses today and inserts those IDs
into Postgres as permanent — so everyone's already-collected local marks
still line up on first sync. From that point on:
- Editing a label only changes `label`; `id` never changes again.
- New items created in-app get `crypto.randomUUID()` IDs (built into
  browsers, no dependency).

**What happens to `data/checklist.md`.** It stops being the runtime
source of truth for anyone who has synced. It remains the "factory
default" seed (what a fresh, never-logged-in install shows, so the app
still works with zero setup) and the input to the one-time migration
script. `parseChecklist()` in `app.js` is unchanged and still used for
that offline/first-run path.

## Server-side changes (new)

- `db/schema.sql` — `sections`, `subsections`, `items` (content, with the
  frozen `id`, plus `deleted boolean` for soft-delete and `sort_order`),
  `marks` (`item_id` PK, `status`, `q`, `sp`, `n`, `c`, `updated_at`).
- `lib/db.js` — shared `@vercel/postgres` client + a couple of query
  helpers (`getChangedSince`, `upsertItems`, `upsertMarks`).
- `api/auth/login.js`, `api/auth/logout.js` — passphrase check, cookie
  issue/clear.
- `api/sync.js` — the push/pull handler described above, gated on the
  session cookie.
- `scripts/seed-db.js` — one-time migration: reads `data/checklist.md`,
  parses it with the same logic as `parseChecklist()` in `app.js`
  (ported to Node — mirrors what `scripts/parse_checklist.py` already
  does, just targeting Postgres instead of `seed.json`), inserts rows
  with today's content-derived IDs frozen in place. Run once by hand
  (`node scripts/seed-db.js`) against the Vercel Postgres connection
  string.
- `package.json` — add `@vercel/postgres` as a real dependency (this
  moves the project from zero-dependency to "zero dependency for the
  static frontend, one small dependency for the sync backend" — worth
  calling out since it's a departure from today's README claim).

No framework, no build step for the frontend: Vercel auto-detects
`/api/*.js` as serverless Node functions regardless of the "Other"
static framework preset already in use, so `index.html`/`app.js` keep
shipping exactly as they do today.

## Client-side changes (`app.js`)

**Sync module** (new functions, same file — no new build tooling):
- `syncNow()` — debounced like `persist()` (reuse that 180ms-debounce
  pattern), POSTs local changes since last sync, merges the response into
  `seed`/`user` using the existing LWW-by-`updatedAt` comparison from the
  import-merge code, then calls `buildIndex()` and re-renders.
- Triggers: after `persist()`, on `window.addEventListener('online', ...)`,
  and on `visibilitychange` → visible (mirrors the existing wake-lock
  re-apply pattern in `boot()`).
- Fails silently to local-only mode if there's no session or the network
  is unreachable — the app must keep working exactly as it does today for
  anyone who never sets a passphrase.

**Checklist becomes mutable.** `seed` is no longer parsed once and treated
read-only. Add:
- `createItem(subsectionId, {label, qty, target, spec, phase})`,
  `createSubsection(sectionId, title)`, `createSection(title)`
- `renameEntity(kind, id, newLabel)`
- `deleteEntity(kind, id)` (soft-delete: sets a `deleted` flag, filtered
  out of `flat`/rendering, still present for sync tombstoning)
- `moveEntity(kind, id, direction)` (up/down reorder via `sort_order` —
  no drag-and-drop library, consistent with the no-dependency frontend)

Each of these mutates the in-memory `seed` structure, calls the existing
`buildIndex()` to rebuild `index`/`flat`, persists the whole checklist
structure into IndexedDB alongside `user` (extending `persist()`'s
payload), and queues a `syncNow()` push — the same pattern marks already
follow, just extended to checklist content.

**UI additions:**
- Section view (`viewSection`): an "Edit" toggle in the toolbar that
  turns item rows into inline-rename fields and reveals per-row move/
  delete controls, plus "+ Add item" per subsection and "+ Add
  subsection" / "+ Add section" actions.
- Settings view (`viewSettings`): a new "Sync" card — passphrase field,
  connect/disconnect, last-synced timestamp, manual "Sync now" button.
  Styled with the existing `.card`/`.field-in`/`.btn` patterns already in
  `styles.css`, same as the Data/Display/Start-over cards right next to
  it.
- A small sync-status dot near the header tally, reusing the existing
  `--safety`/`--warning`/`--steel-500` color tokens for
  synced/pending/offline.

**Bug fix bundled in (same code paths get touched anyway):**
`patchItemDom()` updates `data-s` and the glyph text but never updates
the button's `aria-label`, so screen readers announce a stale status
after a quick cycle/set. Fix alongside the editor work since both touch
item-row rendering.

## Documentation updates

- `README.md` — replace "Adding cross-device sync later" with actual
  setup steps (Vercel Postgres env vars, `SHOP_PASSPHRASE`,
  `SESSION_SECRET`, running `scripts/seed-db.js` once).
- `CLAUDE.md` — update the architecture section to describe the sync
  layer and the now-frozen ID scheme once this lands.

## Verification

- `npm test` (existing 31-check smoke suite) must still pass unmodified
  — it boots the app with `fetch`/`indexedDB` stubbed and no network, so
  it's also a regression check that the app still works with zero
  backend configured.
- Add a few smoke checks for the new editor flows (add item, rename,
  delete, reorder) using the same jsdom harness pattern already in
  `tests/smoke.js`.
- Manual end-to-end pass (documented, not automated, given the scope):
  1. Set `SHOP_PASSPHRASE`/`SESSION_SECRET` in Vercel, run
     `scripts/seed-db.js` once against the Postgres connection string.
  2. Log in on device/browser A, mark a few items, add a custom item,
     rename an existing item's label.
  3. Log in with the same passphrase in a private window (device B),
     confirm the custom item, marks, and the renamed label all appear,
     and that the renamed item's mark is still attached (proves the ID
     fix).
  4. Go offline (devtools), make edits, go back online, confirm the
     queued sync flushes without duplicating or dropping anything.
