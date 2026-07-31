-- Priority on entries, modifiers on contributions.
--
-- Both are additive and nullable-or-defaulted, so this one is genuinely safe as
-- generated — but it is still written by hand for the same reason as 0003: what
-- `drizzle-kit` cannot know is which columns are allowed to default and which
-- must stay NULL to mean "nobody has written this".
--
-- `priority` defaults to 'normal' because every existing entry genuinely is
-- normal. Its CLOCK stays NULL, which is the important part: NULL means no op
-- has ever set a priority, so the first one to arrive lands whatever its
-- timestamp. Defaulting the clock to now() instead would silently make every
-- pre-existing entry outrank an offline phone's genuine edit.

ALTER TABLE "list_entries" ADD COLUMN IF NOT EXISTS "priority" text DEFAULT 'normal' NOT NULL;
ALTER TABLE "list_entries" ADD COLUMN IF NOT EXISTS "priority_updated_at" timestamp with time zone;
ALTER TABLE "list_entries" ADD COLUMN IF NOT EXISTS "priority_updated_by" text;

ALTER TABLE "contributions" ADD COLUMN IF NOT EXISTS "modifier" text;
ALTER TABLE "contributions" ADD COLUMN IF NOT EXISTS "modifier_updated_at" timestamp with time zone;
ALTER TABLE "contributions" ADD COLUMN IF NOT EXISTS "modifier_updated_by" text;
