// Shared Postgres access for the /api/* serverless functions.
//
// Uses Neon's serverless driver over HTTP. DATABASE_URL is set automatically
// by the Neon native integration in the Vercel Marketplace. (The old
// @vercel/postgres SDK is deprecated and Vercel Postgres no longer exists as
// a product -- those databases were migrated to Neon.)
//
// Note: with the HTTP driver a tagged-template query resolves to the rows
// ARRAY itself, not a { rows } wrapper like node-postgres returns. Each
// statement is its own round trip, so there are no multi-statement
// transactions here -- every write below is a single self-contained upsert.

const { neon } = require('@neondatabase/serverless');

// Built lazily, not at module load: neon() throws immediately when
// DATABASE_URL is missing, which would take the whole function down at
// cold start with an opaque FUNCTION_INVOCATION_FAILED. Deferring it means
// a project deployed before the database is attached still imports fine and
// fails with a readable message only when a query is actually attempted.
let client = null;
function db() {
  if (!client) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — attach the Neon integration in the Vercel dashboard (see README, "Cross-device sync").');
    }
    client = neon(process.env.DATABASE_URL);
  }
  return client;
}

// Row shape mirrors app.js's in-browser `seed`/`user` structures so the
// client can merge sync responses with the same fields it already knows.

async function getChangedSince(since) {
  const sql = db();
  const ts = since || '1970-01-01T00:00:00.000Z';
  const [sections, subsections, items, marks] = await Promise.all([
    sql`SELECT id, num, title, sort_order, deleted, updated_at
        FROM sections WHERE updated_at > ${ts}`,
    sql`SELECT id, section_id, num, title, sort_order, deleted, updated_at
        FROM subsections WHERE updated_at > ${ts}`,
    sql`SELECT id, subsection_id, label, qty, target, spec, phase, tags,
               store, sort_order, deleted, updated_at
        FROM items WHERE updated_at > ${ts}`,
    sql`SELECT item_id, status, q, sp, n, c, updated_at
        FROM marks WHERE updated_at > ${ts}`,
  ]);
  return { sections, subsections, items, marks };
}

// Each upsert only applies a row if it's missing or the incoming
// updated_at is newer than what's stored -- last-write-wins enforced in
// the database itself, not just trusted from the client.

async function upsertSections(rows) {
  const sql = db();
  for (const r of rows) {
    await sql`
      INSERT INTO sections (id, num, title, sort_order, deleted, updated_at)
      VALUES (${r.id}, ${r.num}, ${r.title}, ${r.sortOrder}, ${!!r.deleted}, ${r.updatedAt})
      ON CONFLICT (id) DO UPDATE SET
        num = excluded.num, title = excluded.title,
        sort_order = excluded.sort_order, deleted = excluded.deleted,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at > sections.updated_at`;
  }
}

async function upsertSubsections(rows) {
  const sql = db();
  for (const r of rows) {
    await sql`
      INSERT INTO subsections (id, section_id, num, title, sort_order, deleted, updated_at)
      VALUES (${r.id}, ${r.sectionId}, ${r.num}, ${r.title}, ${r.sortOrder}, ${!!r.deleted}, ${r.updatedAt})
      ON CONFLICT (id) DO UPDATE SET
        section_id = excluded.section_id, num = excluded.num, title = excluded.title,
        sort_order = excluded.sort_order, deleted = excluded.deleted,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at > subsections.updated_at`;
  }
}

async function upsertItems(rows) {
  const sql = db();
  for (const r of rows) {
    await sql`
      INSERT INTO items (id, subsection_id, label, qty, target, spec, phase,
                          tags, store, sort_order, deleted, updated_at)
      VALUES (${r.id}, ${r.subsectionId}, ${r.label}, ${!!r.qty}, ${r.target},
              ${!!r.spec}, ${r.phase}, ${r.tags || []}, ${r.store || 'General'},
              ${r.sortOrder}, ${!!r.deleted}, ${r.updatedAt})
      ON CONFLICT (id) DO UPDATE SET
        subsection_id = excluded.subsection_id, label = excluded.label,
        qty = excluded.qty, target = excluded.target, spec = excluded.spec,
        phase = excluded.phase, tags = excluded.tags, store = excluded.store,
        sort_order = excluded.sort_order, deleted = excluded.deleted,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at > items.updated_at`;
  }
}

async function upsertMarks(rows) {
  const sql = db();
  for (const r of rows) {
    await sql`
      INSERT INTO marks (item_id, status, q, sp, n, c, updated_at)
      VALUES (${r.itemId}, ${r.status || null}, ${r.q}, ${r.sp || null},
              ${r.n || null}, ${r.c}, ${r.updatedAt})
      ON CONFLICT (item_id) DO UPDATE SET
        status = excluded.status, q = excluded.q, sp = excluded.sp,
        n = excluded.n, c = excluded.c, updated_at = excluded.updated_at
      WHERE excluded.updated_at > marks.updated_at`;
  }
}

module.exports = {
  db,
  getChangedSince,
  upsertSections,
  upsertSubsections,
  upsertItems,
  upsertMarks,
};
