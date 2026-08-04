-- A recipe gets a method and a note of its own.
--
-- Written by hand, like 0003 through 0006. `drizzle-kit generate` cannot run
-- against this repo without a TTY — the snapshots stopped at 0002, so its diff
-- asks whether every column added since is a rename — and the SQL a migration
-- needs here is three lines anyway.
--
-- Both columns are additive and safe to run twice. Neither can fail on a live
-- database: one has a default, the other is nullable.

-- The steps, one per array element, in order.
--
-- `jsonb` rather than a `recipe_steps` table because a step has no identity: it
-- is never pointed at, never queried for on its own, and is always read and
-- written whole. `lists.category_order` is stored the same way for the same
-- reason. Contrast `recipe_ingredients`, which is a table precisely BECAUSE a
-- line points at a vara and merges have to re-aim that pointer.
--
-- `'[]'` for every existing row is the truthful backfill: no recipe imported
-- before this migration captured a method, so none of them has one. It is also
-- what a fresh import of a page that publishes no steps will store, and the two
-- cases are genuinely the same fact — "we do not have the method for this".
ALTER TABLE "recipes"
  ADD COLUMN IF NOT EXISTS "instructions" jsonb DEFAULT '[]'::jsonb NOT NULL;

-- The household's own note, and nullable on purpose: NULL means nobody has
-- written one, which is different from having written and then cleared it. The
-- editor sends NULL for an empty field, so the two collapse in practice — but
-- the column should not be the thing that decides that.
ALTER TABLE "recipes"
  ADD COLUMN IF NOT EXISTS "notes" text;
