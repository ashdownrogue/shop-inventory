# Shop Inventory

A local-first, offline-capable audit app for the 1,534-item garage shop checklist.
No build step for the frontend — static files, works with zero setup. An
optional Postgres-backed sync API (a handful of serverless functions under
`/api`) can be turned on later for in-app checklist editing and cross-device
sync; see [Cross-device sync](#cross-device-sync).

## Deploy to Vercel

From this folder, either:

**Option A, CLI (30 seconds):**
```bash
npx vercel --prod
```
Accept the defaults. Vercel auto-detects a static site. No build command needed.

**Option B, drag and drop:**
Zip this folder and drop it on https://vercel.com/new

**Option C, git:**
```bash
git init && git add -A && git commit -m "shop inventory"
gh repo create shop-inventory --private --source=. --push
```
Then import the repo at vercel.com/new.

Nothing to configure for the base app: no environment variables, no database,
no secrets. See [Cross-device sync](#cross-device-sync) if you want that.

## Run locally

```bash
python3 -m http.server 8899
# open http://localhost:8899
```

A plain `file://` open will not work, because the app fetches the checklist and
registers a service worker. Any static server is fine.

## How it works

- `data/checklist.md` is the single source of truth. The app parses it in the
  browser at load, so editing the checklist means editing that one file.
- Item IDs are derived from content (`section-subsection-slug`), so you can edit,
  reorder, or insert checklist lines and your existing marks stay attached.
- Marks live in IndexedDB on the device, with a localStorage fallback. Nothing
  leaves the browser unless you turn on sync (below).
- The service worker caches the shell, so it works with no signal.

## Editing the checklist

**In the app** (once [sync](#cross-device-sync) is set up): open a section,
tap **Edit** in the toolbar to rename, reorder, or delete subsections and
items, add new ones with the "+ Add item" / "+ Add subsection" forms, or
go to Settings → Checklist to rename/reorder/delete a whole section. Every
change syncs to the database and to every other signed-in device — no
redeploy needed. This is the everyday path once sync is set up.

**By hand**, still supported: edit `data/checklist.md` and redeploy. This
is the only path if you haven't set up sync, and it's still how the
database itself gets its starting content (`scripts/seed-db.js`, once).
The parser reads:

| Markdown | Becomes |
|---|---|
| `## 3. Sockets and drivers` | a section |
| `### 3.9 1/2" drive, metric` | a subsection |
| `- [ ] 19 mm` | an item |
| `- [ ] Cover lenses, count: ______` | item with a quantity counter |
| `- [ ] Cutoff wheels, count: ______ (want 25+)` | quantity plus a restock target of 25 |
| `- [ ] Welder, model: ______` | item with a spec text field |
| `- [ ] Plasma cutter (Phase 3)` | item tagged phase 3 |

Everything in Section 1 is auto-tagged as safety. Subsections whose titles mention
fire, medical, safety, battery, or charging are too. Items with a quantity field
are tagged as consumables.

## Status marks

Following ANSI Z535 signage escalation, which is why the colors are what they are:

| Mark | Glyph | Meaning |
|---|---|---|
| Have | `H` | green, owned and fine |
| Upgrade | `U` | yellow caution, owned but junk |
| Missing | `M` | orange warning, do not have |
| Blocking | `!` | red danger, missing and stopping work |
| N/A | `x` | out of scope |
| Not audited | `.` | default |

Tap the left block to cycle. Tap the item name to open quantity, spec, note, and cost.

## Files

```
index.html              app shell
styles.css              design tokens and all styling
app.js                  parser, state, editor, sync client, IndexedDB, views, exports
data/checklist.md       the factory-default checklist (parsed at runtime, pre-sync)
manifest.webmanifest    PWA manifest
sw.js                   service worker, cache-first shell
vercel.json             cache headers
icons/                  app icons
api/auth/login.js       passphrase check, issues the session cookie
api/auth/logout.js      clears the session cookie
api/sync.js             POST /api/sync: push/pull checklist + marks, last-write-wins
lib/auth.js             passphrase hashing + signed-cookie session helpers
lib/db.js               shared Postgres client + upsert/query helpers
db/schema.sql           sections/subsections/items/marks tables
scripts/seed-db.js      one-time: loads data/checklist.md into Postgres with frozen ids
scripts/parse_checklist.py   optional: reference parser, for inspecting the data
scripts/make_icons.py        regenerates the icons
tests/smoke.js          headless test suite
```

## Tests

```bash
npm install
npm test
```

Covers status cycling, bulk marking, filters, search, the expander, quantity
steppers, the buy list and its grouping, cost totals, exports, theme, undo, and
the rule that an uncounted consumable never appears on the buy list.

## Cross-device sync

Optional. Turns on in-app checklist editing (add/rename/reorder/delete
sections, subsections, and items — no more hand-editing markdown) plus
syncing everything, checklist and marks, across every device signed in
with the same passphrase.

**1. Attach a Postgres database.** In the Vercel dashboard, open the
project → **Storage** → **Marketplace**, and add **Neon**. It sets
`DATABASE_URL` (among others) on the project automatically.

> "Vercel Postgres" no longer exists as a separate product — it became the
> Neon integration in December 2024, and the old `@vercel/postgres` SDK is
> deprecated. This project uses Neon's own driver
> (`@neondatabase/serverless`) and reads `DATABASE_URL`.

**2. Apply the schema.** Run [`db/schema.sql`](db/schema.sql) against that
database once — either from the SQL editor in the Neon console, or:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

**3. Set the two auth env vars**, in the Vercel dashboard:

- `SHOP_PASSPHRASE_HASH` — generate with:
  ```bash
  node -e "const c=require('crypto'),s=c.randomBytes(16).toString('hex');
  console.log(s+':'+c.scryptSync(process.argv[1],s,64).toString('hex'))" 'your passphrase here'
  ```
  Set the env var to the printed `salt:hash` string — not the raw passphrase.
- `SESSION_SECRET` — any long random string (e.g. `openssl rand -hex 32`).

**4. Seed the database once**, with `DATABASE_URL` set locally
(`vercel env pull` writes a `.env.local` you can source, or paste the
connection string from the Neon console):

```bash
npm install
DATABASE_URL="postgres://..." npm run seed-db
```

This parses `data/checklist.md` with the exact same logic the app uses in
the browser and inserts it with those content-derived ids frozen in
place — so marks any device has already recorded locally still line up
the first time it syncs.

**5. Deploy**, then open the app → Settings → enter the passphrase → Connect.

Everything still works fully offline with sync off — this is additive,
not required. Conflicts resolve last-write-wins per item on `updatedAt`,
the same rule the JSON import/export already used.
