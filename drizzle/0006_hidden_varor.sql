-- Hiding a vara: kept, findable in the registry, out of the way everywhere else.
--
-- Written by hand for the same reason 0003 was, and it is the clock rather than
-- the flag that forces it. `drizzle-kit` emits `ADD COLUMN ... NOT NULL DEFAULT
-- now()` for `hidden_updated_at`, and now() is precisely the wrong backfill: it
-- would stamp every vara in the catalog with the migration's timestamp, so a
-- genuine "dölj den här" made on a phone that was in a drawer yesterday arrives
-- OLDER than a fact nobody ever asserted and loses silently. The honest value is
-- the row's existing clock — before this migration, every field of a row was
-- last written by whatever last touched it.
--
-- add-nullable → backfill → tighten, exactly as 0003, so this is safe against a
-- live database and safe to run twice.

-- The flag itself. False is genuinely right for every existing row: nothing
-- could have hidden a vara before this migration existed.
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "hidden" boolean DEFAULT false NOT NULL;

ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "hidden_updated_at" timestamp with time zone;
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "hidden_updated_by" text;

UPDATE "catalog_items" SET
  "hidden_updated_at" = COALESCE("hidden_updated_at", "updated_at"),
  "hidden_updated_by" = COALESCE("hidden_updated_by", "updated_by");

ALTER TABLE "catalog_items" ALTER COLUMN "hidden_updated_at" SET NOT NULL;
ALTER TABLE "catalog_items" ALTER COLUMN "hidden_updated_at" SET DEFAULT now();
ALTER TABLE "catalog_items" ALTER COLUMN "hidden_updated_by" SET NOT NULL;

-- Serves the one query that needs it: the catalog well and the add bar both ask
-- for "everything not hidden", which on a 341-row table is a sequential scan
-- either way — but /varor's "Dolda" section asks the complement, and that one is
-- a handful of rows out of the whole catalog.
CREATE INDEX IF NOT EXISTS "catalog_items_hidden_idx" ON "catalog_items" ("hidden");
