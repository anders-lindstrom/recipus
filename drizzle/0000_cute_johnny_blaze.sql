CREATE TABLE "barcodes" (
	"ean" text PRIMARY KEY NOT NULL,
	"catalog_item_id" text,
	"product_name" text,
	"brand" text,
	"image_url" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_norm" text NOT NULL,
	"category_id" text NOT NULL,
	"icon_ref" text NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL,
	"has_at_home" boolean DEFAULT false NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"icon" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contributions" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"recipe_addition_id" text,
	"amount_value" double precision,
	"amount_unit" text,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "list_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"list_id" text NOT NULL,
	"catalog_item_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"removed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "list_entries_list_item_uq" UNIQUE("list_id","catalog_item_id")
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"icon" text NOT NULL,
	"position" integer NOT NULL,
	"category_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"client_op_id" text NOT NULL,
	"list_id" text,
	"actor" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"catalog_item_id" text NOT NULL,
	"list_id" text NOT NULL,
	"purchased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_additions" (
	"id" text PRIMARY KEY NOT NULL,
	"list_id" text NOT NULL,
	"recipe_id" text NOT NULL,
	"scale_factor" real DEFAULT 1 NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by" text NOT NULL,
	"removed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_ingredients" (
	"id" text PRIMARY KEY NOT NULL,
	"recipe_id" text NOT NULL,
	"position" integer NOT NULL,
	"raw_text" text NOT NULL,
	"amount_value" double precision,
	"amount_unit" text,
	"catalog_item_id" text
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"source_url" text,
	"servings" real DEFAULT 4 NOT NULL,
	"servings_unit" text DEFAULT 'portioner' NOT NULL,
	"image_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestion_dismissals" (
	"catalog_item_id" text NOT NULL,
	"day" text NOT NULL,
	CONSTRAINT "suggestion_dismissals_catalog_item_id_day_pk" PRIMARY KEY("catalog_item_id","day")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"authelia_user" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"color" text DEFAULT '#1f6f4f' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_catalog_item_id_catalog_items_id_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_entry_id_list_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."list_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_entries" ADD CONSTRAINT "list_entries_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_entries" ADD CONSTRAINT "list_entries_catalog_item_id_catalog_items_id_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_catalog_item_id_catalog_items_id_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_additions" ADD CONSTRAINT "recipe_additions_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_additions" ADD CONSTRAINT "recipe_additions_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_catalog_item_id_catalog_items_id_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestion_dismissals" ADD CONSTRAINT "suggestion_dismissals_catalog_item_id_catalog_items_id_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_items_category_idx" ON "catalog_items" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "catalog_items_name_norm_idx" ON "catalog_items" USING btree ("name_norm");--> statement-breakpoint
CREATE INDEX "contributions_entry_idx" ON "contributions" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "contributions_recipe_addition_idx" ON "contributions" USING btree ("recipe_addition_id");--> statement-breakpoint
CREATE INDEX "list_entries_list_idx" ON "list_entries" USING btree ("list_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_client_op_id_uq" ON "ops" USING btree ("client_op_id");--> statement-breakpoint
CREATE INDEX "ops_seq_idx" ON "ops" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "purchases_item_time_idx" ON "purchases" USING btree ("catalog_item_id","purchased_at");--> statement-breakpoint
CREATE INDEX "recipe_additions_list_idx" ON "recipe_additions" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "recipe_ingredients_recipe_idx" ON "recipe_ingredients" USING btree ("recipe_id");