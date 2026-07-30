# Shop Inventory

A local-first, offline-capable audit app for the 1,534-item garage shop checklist.
No build step, no backend, no dependencies. Static files only.

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

There is nothing to configure: no environment variables, no database, no secrets.

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
  leaves the browser.
- The service worker caches the shell, so it works with no signal.

## Editing the checklist

Edit `data/checklist.md` and redeploy. The parser reads:

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
app.js                  parser, state, IndexedDB, views, exports
data/checklist.md       the canonical checklist (parsed at runtime)
manifest.webmanifest    PWA manifest
sw.js                   service worker, cache-first shell
vercel.json             cache headers
icons/                  app icons
scripts/parse_checklist.py   optional: reference parser, for inspecting the data
scripts/make_icons.py        regenerates the icons
tests/smoke.js          headless test suite, 31 checks
```

## Tests

```bash
npm install jsdom
node tests/smoke.js
```

Covers status cycling, bulk marking, filters, search, the expander, quantity
steppers, the buy list and its grouping, cost totals, exports, theme, undo, and
the rule that an uncounted consumable never appears on the buy list.

## Adding cross-device sync later

The data model already carries `updatedAt` per item for this purpose. The additive
path: a `/api/sync` route handler, a Postgres or Turso table mirroring the local
shape, item-level last-write-wins on `updatedAt`, and a passphrase in an env var
behind middleware. No migration of existing marks required.
