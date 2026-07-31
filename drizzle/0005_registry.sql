-- The item registry: products become first-class, barcodes are demoted to a
-- pointer, and a purchase can attribute to a product instead of a vara.
--
-- Written by hand, like 0003 and 0004, and for a sharper reason than either.
-- `drizzle-kit generate` sees "barcodes loses four columns and gains a NOT NULL
-- product_id" and emits DROP COLUMN + ADD COLUMN ... NOT NULL. That aborts on
-- any table with rows, and if it did not it would silently throw away every
-- barcode the household has ever confirmed. The product rows below have to be
-- built FROM those columns before they can be dropped.
--
-- Every step is create → backfill → tighten, in dependency order, so it is safe
-- against a live database and safe to run twice.

-- ---------------------------------------------------------------------------
-- catalog_items: soft delete.
--
-- Nullable and undefaulted, which is all a tombstone needs — the timestamp is
-- stamped from the record-level `catalog:${id}` meta, exactly as
-- lists.deleted_at is. Deliberately NO deleted_updated_at pair: existence is not
-- a field of the row, and a second clock for one fact is the bug this codebase
-- has now paid for three times.
-- ---------------------------------------------------------------------------
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;

-- ---------------------------------------------------------------------------
-- products.
--
-- All four field clocks are NULLABLE with no default, and that is the load-
-- bearing part of this table. NULL means "no op has ever written this field",
-- which is what the reducer holds for an untouched field, so the first write
-- lands whatever its timestamp. Defaulting them to the creation time would make
-- Open Food Facts' guess outrank a human correction typed on a phone whose clock
-- runs behind the server's — the `priority_updated_at` bug from 0004, in the one
-- place where nobody would look for it.
--
-- created_at/created_by are earliest-wins rather than last-write-wins, because
-- scan-born ids are DERIVED (`prod:${ean}`) and two offline phones scanning the
-- same EAN both create the same row. Same rule as list_entries.created_at.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "products" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "brand" text,
  "catalog_item_id" text,
  "default_size_value" double precision,
  "default_size_unit" text,
  -- Open Food Facts' string verbatim, because parseAmount("6 x 33 cl") returns
  -- {6, "st"} — verified by execution, and the reason this column exists.
  "source_size_text" text,
  "image_url" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" text NOT NULL,
  "name_updated_at" timestamp with time zone,
  "name_updated_by" text,
  "brand_updated_at" timestamp with time zone,
  "brand_updated_by" text,
  -- One clock for both size columns. They are one fact in two representations,
  -- like name/name_norm on a catalog item; separate clocks would let "500" and
  -- "l" settle from different writes and produce a size nobody ever entered.
  "size_updated_at" timestamp with time zone,
  "size_updated_by" text,
  -- The mapping to a vara. NULL clock, so a human's "no, that is kaffe" beats an
  -- auto-map regardless of whose clock is ahead.
  "item_updated_at" timestamp with time zone,
  "item_updated_by" text,
  "deleted_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "products" ADD CONSTRAINT "products_catalog_item_id_catalog_items_id_fk"
    FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Serves both registry reads: "which products sit on this vara" for /varor, and
-- `WHERE catalog_item_id IS NULL` for the review queue.
CREATE INDEX IF NOT EXISTS "products_catalog_item_idx" ON "products" ("catalog_item_id");

-- ---------------------------------------------------------------------------
-- catalog_item_aliases.
--
-- Deliberately the identical shape to the EAN → product pointer below. Its job
-- is merges: the merged-away word survives here so recipe lines written years
-- ago keep resolving. alias_norm is the primary key so two people cannot point
-- one word at two different varor without that being a conflict the row clock
-- settles.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "catalog_item_aliases" (
  "alias_norm" text PRIMARY KEY NOT NULL,
  "catalog_item_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" text NOT NULL,
  "deleted_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "catalog_item_aliases" ADD CONSTRAINT "catalog_item_aliases_catalog_item_id_catalog_items_id_fk"
    FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "catalog_item_aliases_item_idx" ON "catalog_item_aliases" ("catalog_item_id");

-- ---------------------------------------------------------------------------
-- barcodes: demoted to an EAN → product pointer.
--
-- This is the step that must not be generated. Every existing barcode row IS a
-- product — its name, brand, image and mapping are sitting in columns about to
-- be dropped — so each one is promoted into `products` first, under the same
-- derived id a scan would mint for it (`prod:${ean}`), and only then does the
-- old shape go.
--
-- INSERT ... SELECT rather than a loop, and ON CONFLICT DO NOTHING so a re-run
-- promotes nothing twice. `name` is NOT NULL on products while `product_name`
-- was nullable here, hence the COALESCE onto the EAN: a nameless product is
-- still a real product somebody scanned, and dropping the row instead would lose
-- a confirmed mapping.
--
-- Guarded on the old column still existing, because unlike everything else in
-- this file the promotion cannot be expressed with IF NOT EXISTS — it reads
-- columns that the end of this section drops. Without the guard the migration
-- runs exactly once and then fails, which is a bad property for the one step
-- here that moves data rather than shape.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'barcodes' AND column_name = 'product_name'
  ) THEN
    INSERT INTO "products" (
      "id", "name", "brand", "catalog_item_id", "image_url",
      "created_at", "created_by", "updated_at", "updated_by",
      -- The name, brand and size clocks stay NULL. Nobody has edited these
      -- products through the registry — they were written by the old barcode
      -- route — so "never written" is the truth, and it is also what leaves the
      -- first genuine edit free to land whatever its timestamp.
      "item_updated_at", "item_updated_by"
    )
    SELECT
      'prod:' || b."ean",
      COALESCE(b."product_name", b."ean"),
      b."brand",
      b."catalog_item_id",
      b."image_url",
      b."created_at",
      'system',
      b."created_at",
      'system',
      -- One exception: a row that already carries a mapping got it from a person
      -- answering the confirm prompt, and that assertion has to be preserved or
      -- the next stale auto-map overwrites it. Its honest clock is the only
      -- timestamp the old table kept.
      CASE WHEN b."catalog_item_id" IS NOT NULL THEN b."created_at" END,
      CASE WHEN b."catalog_item_id" IS NOT NULL THEN 'system' END
    FROM "barcodes" b
    ON CONFLICT ("id") DO NOTHING;
  END IF;
END $$;

ALTER TABLE "barcodes" ADD COLUMN IF NOT EXISTS "product_id" text;
ALTER TABLE "barcodes" ADD COLUMN IF NOT EXISTS "created_by" text;
ALTER TABLE "barcodes" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
ALTER TABLE "barcodes" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
ALTER TABLE "barcodes" ADD COLUMN IF NOT EXISTS "updated_by" text;

UPDATE "barcodes" SET
  "product_id"  = COALESCE("product_id",  'prod:' || "ean"),
  "created_by"  = COALESCE("created_by",  'system'),
  -- Backfilled from created_at, not now(). These rows have not been touched
  -- since they were written, and stamping them with the migration's clock would
  -- make every one of them outrank an offline edit made yesterday.
  "updated_at"  = COALESCE("updated_at",  "created_at"),
  "updated_by"  = COALESCE("updated_by",  'system');

ALTER TABLE "barcodes" ALTER COLUMN "product_id" SET NOT NULL;
ALTER TABLE "barcodes" ALTER COLUMN "created_by" SET NOT NULL;
ALTER TABLE "barcodes" ALTER COLUMN "updated_at" SET NOT NULL;
ALTER TABLE "barcodes" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "barcodes" ALTER COLUMN "updated_by" SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_product_id_products_id_fk"
    FOREIGN KEY ("product_id") REFERENCES "public"."products"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "barcodes_product_idx" ON "barcodes" ("product_id");

-- Only now, once every value they held lives on a product row.
ALTER TABLE "barcodes" DROP CONSTRAINT IF EXISTS "barcodes_catalog_item_id_catalog_items_id_fk";
ALTER TABLE "barcodes" DROP COLUMN IF EXISTS "catalog_item_id";
ALTER TABLE "barcodes" DROP COLUMN IF EXISTS "product_name";
ALTER TABLE "barcodes" DROP COLUMN IF EXISTS "brand";
ALTER TABLE "barcodes" DROP COLUMN IF EXISTS "image_url";

-- ---------------------------------------------------------------------------
-- purchases: a scan attributes to a product, a tile tap to a vara.
--
-- catalog_item_id becomes nullable so ANY scan can write {null, product},
-- mapped or not — the vara is then read through
-- COALESCE(purchases.catalog_item_id, products.catalog_item_id), which makes
-- placing a product retro-attribute its whole history for free.
--
-- The CHECK is what stops "nullable" from becoming "attributes to nothing".
-- Nothing writes such a row today; this is so nothing can.
--
-- quantity_value/quantity_unit are added now, unread by anything in v1, because
-- they are the only columns here that cannot be backfilled: no future code can
-- reconstruct how many litres went into a basket last March.
-- ---------------------------------------------------------------------------
ALTER TABLE "purchases" ALTER COLUMN "catalog_item_id" DROP NOT NULL;
ALTER TABLE "purchases" ADD COLUMN IF NOT EXISTS "product_id" text;
ALTER TABLE "purchases" ADD COLUMN IF NOT EXISTS "quantity_value" double precision;
ALTER TABLE "purchases" ADD COLUMN IF NOT EXISTS "quantity_unit" text;

DO $$ BEGIN
  ALTER TABLE "purchases" ADD CONSTRAINT "purchases_product_id_products_id_fk"
    FOREIGN KEY ("product_id") REFERENCES "public"."products"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "purchases" ADD CONSTRAINT "purchases_attribution_ck"
    CHECK ("catalog_item_id" IS NOT NULL OR "product_id" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "purchases_product_time_idx" ON "purchases" ("product_id","purchased_at");
