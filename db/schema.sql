-- Shop Inventory sync schema (Vercel Postgres / Neon).
-- Run once against the Postgres connection string before the first
-- `node scripts/seed-db.js`. Safe to re-run (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS sections (
  id text PRIMARY KEY,
  num int NOT NULL,
  title text NOT NULL,
  sort_order int NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subsections (
  id text PRIMARY KEY,
  section_id text NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  num text NOT NULL,
  title text NOT NULL,
  sort_order int NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Content: what the item is. Rarely changes; edited via the in-app editor.
CREATE TABLE IF NOT EXISTS items (
  id text PRIMARY KEY,
  subsection_id text NOT NULL REFERENCES subsections(id) ON DELETE CASCADE,
  label text NOT NULL,
  qty boolean NOT NULL DEFAULT false,
  target int,
  spec boolean NOT NULL DEFAULT false,
  phase int,
  tags text[] NOT NULL DEFAULT '{}',
  store text NOT NULL DEFAULT 'General',
  sort_order int NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS items_subsection_idx ON items(subsection_id);
CREATE INDEX IF NOT EXISTS items_updated_idx ON items(updated_at);
CREATE INDEX IF NOT EXISTS subsections_updated_idx ON subsections(updated_at);
CREATE INDEX IF NOT EXISTS sections_updated_idx ON sections(updated_at);

-- Audit state: the same shape as the `user[id]` record in app.js.
CREATE TABLE IF NOT EXISTS marks (
  item_id text PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  status text,
  q int,
  sp text,
  n text,
  c numeric,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marks_updated_idx ON marks(updated_at);
