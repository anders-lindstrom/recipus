-- The file a recipe was read from: a photo, a PDF, or pasted text.
--
-- Written by hand, like 0003 through 0007 — the snapshots stop at 0002, so
-- `drizzle-kit generate` asks whether every column added since is a rename.
--
-- The bytes live on disk under STORAGE_DIR; this table says where. See
-- docs/superpowers/specs/2026-11-16-recipe-file-import-design.md §5.2.
--
-- `recipe_id` is NULL while the recipe is a draft on someone's review screen;
-- the prune job removes drafts nobody saved after a day, which is what the
-- `created_at` index is for. Cascade on the recipe: a recipe pruned for good
-- takes its source rows with it (and prune.ts deletes their files).
CREATE TABLE IF NOT EXISTS "recipe_sources" (
  "id" text PRIMARY KEY NOT NULL,
  "recipe_id" text REFERENCES "recipes"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "media_type" text NOT NULL,
  "storage_key" text NOT NULL,
  "sha256" text NOT NULL,
  "byte_size" integer NOT NULL,
  "file_name" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "recipe_sources_recipe_idx" ON "recipe_sources" ("recipe_id");
CREATE INDEX IF NOT EXISTS "recipe_sources_created_idx" ON "recipe_sources" ("created_at");
