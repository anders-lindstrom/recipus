-- Per-field last-write-wins clocks that do not move.
--
-- Written by hand rather than generated. `drizzle-kit` emits a bare
-- `ADD COLUMN ... NOT NULL` with no default, which aborts on any table that
-- already has rows — and it cannot know that the honest backfill value is the
-- row's existing clock rather than now(). Same reason migration 0002 was
-- hand-adjusted.
--
-- Every step is add-nullable → backfill → tighten, so it is safe to run against
-- a live database and safe to run twice.

-- ---------------------------------------------------------------------------
-- contributions: the amount/note clocks already existed and stay NULLABLE — but
-- NULL now means "nobody has ever written this field", full stop. It used to
-- fall back to the row clock at read time, and the row clock moves whenever
-- EITHER field is written: setting the amount silently advanced the note's clock
-- and a genuinely older note write lost a comparison it should have won, in one
-- arrival order only. Two devices, two different notes, no error anywhere.
--
-- The columns are backfilled rather than left alone because for rows written
-- before this migration, NULL did mean "the row clock governs". Backfilling
-- preserves the behaviour those rows already had; leaving them NULL would
-- retroactively reopen them to any ancient op that turned up.
-- ---------------------------------------------------------------------------
UPDATE "contributions" SET "amount_updated_at" = "updated_at" WHERE "amount_updated_at" IS NULL;
UPDATE "contributions" SET "amount_updated_by" = "updated_by" WHERE "amount_updated_by" IS NULL;
UPDATE "contributions" SET "note_updated_at" = "updated_at" WHERE "note_updated_at" IS NULL;
UPDATE "contributions" SET "note_updated_by" = "updated_by" WHERE "note_updated_by" IS NULL;

-- ---------------------------------------------------------------------------
-- catalog_items: four new clocks, one per editable fact. Backfilled from the
-- row clock, which is exactly right — before this migration every field was
-- last written by whatever last touched the row.
-- ---------------------------------------------------------------------------
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "name_updated_at" timestamp with time zone;
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "name_updated_by" text;
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "category_updated_at" timestamp with time zone;
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "category_updated_by" text;
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "icon_updated_at" timestamp with time zone;
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "icon_updated_by" text;
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "home_updated_at" timestamp with time zone;
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "home_updated_by" text;

UPDATE "catalog_items" SET
  "name_updated_at"     = COALESCE("name_updated_at",     "updated_at"),
  "name_updated_by"     = COALESCE("name_updated_by",     "updated_by"),
  "category_updated_at" = COALESCE("category_updated_at", "updated_at"),
  "category_updated_by" = COALESCE("category_updated_by", "updated_by"),
  "icon_updated_at"     = COALESCE("icon_updated_at",     "updated_at"),
  "icon_updated_by"     = COALESCE("icon_updated_by",     "updated_by"),
  "home_updated_at"     = COALESCE("home_updated_at",     "updated_at"),
  "home_updated_by"     = COALESCE("home_updated_by",     "updated_by");

ALTER TABLE "catalog_items" ALTER COLUMN "name_updated_at" SET NOT NULL;
ALTER TABLE "catalog_items" ALTER COLUMN "name_updated_at" SET DEFAULT now();
ALTER TABLE "catalog_items" ALTER COLUMN "name_updated_by" SET NOT NULL;
ALTER TABLE "catalog_items" ALTER COLUMN "category_updated_at" SET NOT NULL;
ALTER TABLE "catalog_items" ALTER COLUMN "category_updated_at" SET DEFAULT now();
ALTER TABLE "catalog_items" ALTER COLUMN "category_updated_by" SET NOT NULL;
ALTER TABLE "catalog_items" ALTER COLUMN "icon_updated_at" SET NOT NULL;
ALTER TABLE "catalog_items" ALTER COLUMN "icon_updated_at" SET DEFAULT now();
ALTER TABLE "catalog_items" ALTER COLUMN "icon_updated_by" SET NOT NULL;
ALTER TABLE "catalog_items" ALTER COLUMN "home_updated_at" SET NOT NULL;
ALTER TABLE "catalog_items" ALTER COLUMN "home_updated_at" SET DEFAULT now();
ALTER TABLE "catalog_items" ALTER COLUMN "home_updated_by" SET NOT NULL;
