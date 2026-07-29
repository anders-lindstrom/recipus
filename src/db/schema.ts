import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Recipus schema.
 *
 * Two shapes here are load-bearing and explained where they are declared:
 * the unique constraint on (list_id, catalog_item_id), and the fact that a
 * list entry stores contributions rather than a quantity.
 *
 * Every mutable row carries `updated_at` / `updated_by`. Those are not audit
 * columns — they are the inputs to last-write-wins conflict resolution, and the
 * sync reducer compares them on every op. See src/lib/sync/reducer.ts.
 */

// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  // Identity comes from Authelia via a proxy header; we never store credentials.
  autheliaUser: text("authelia_user").primaryKey(),
  displayName: text("display_name").notNull(),
  color: text("color").notNull().default("#1f6f4f"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const categories = pgTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  icon: text("icon").notNull(),
  // Default aisle order. A list may override it via lists.category_order.
  position: integer("position").notNull(),
});

export const catalogItems = pgTable(
  "catalog_items",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // Lowercased and diacritic-folded. Search and recipe matching hit this,
    // never `name` — nobody types "räkor" correctly at speed.
    nameNorm: text("name_norm").notNull(),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id),
    // Emoji codepoint, e.g. "1F95B". Resolved against the OpenMoji sprite when
    // one has been built, and rendered as the system emoji otherwise.
    iconRef: text("icon_ref").notNull(),
    isCustom: boolean("is_custom").notNull().default(false),
    // Staples a recipe should not put on your list: salt, mjöl, olja.
    hasAtHome: boolean("has_at_home").notNull().default(false),
    // Drive recency/frequency ordering of the catalog.
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    index("catalog_items_category_idx").on(t.categoryId),
    index("catalog_items_name_norm_idx").on(t.nameNorm),
  ],
);

export const lists = pgTable("lists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  icon: text("icon").notNull(),
  position: integer("position").notNull(),
  // Category ids in this store's walking order. Hemköp and Bauhaus share the
  // catalog vocabulary but nothing about their layout.
  categoryOrder: jsonb("category_order").$type<string[]>().notNull().default([]),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedBy: text("updated_by").notNull(),
});

/**
 * An item's presence on a list.
 *
 * The unique constraint is the invariant the whole app leans on: an item
 * appears at most once per list. Wanting cream for two different recipes
 * produces two *contributions*, never two tiles — otherwise you walk past the
 * dairy aisle twice and buy half of what you needed.
 *
 * The id is derived from (list_id, catalog_item_id) rather than generated, so
 * two offline phones adding milk converge on one row without coordinating.
 */
export const listEntries = pgTable(
  "list_entries",
  {
    id: text("id").primaryKey(),
    listId: text("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    catalogItemId: text("catalog_item_id")
      .notNull()
      .references(() => catalogItems.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by").notNull(),
    // Soft delete. A hard delete would let a stale add_item from a phone that
    // was offline silently resurrect something already bought; last-write-wins
    // needs something to compare against. Pruned with the ops at 30 days.
    removedAt: timestamp("removed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    unique("list_entries_list_item_uq").on(t.listId, t.catalogItemId),
    index("list_entries_list_idx").on(t.listId),
  ],
);

/**
 * One reason an item is on a list, and the amount that reason asks for.
 *
 * This table is why "you need 8 dl" is trustworthy. The entry holds no
 * quantity of its own; the displayed total is the merge of these rows, so
 * withdrawing one recipe subtracts exactly its share.
 */
export const contributions = pgTable(
  "contributions",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id")
      .notNull()
      .references(() => listEntries.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind")
      .$type<"manual" | "recipe" | "scan" | "suggestion">()
      .notNull(),
    recipeAdditionId: text("recipe_addition_id"),
    // Null means "some, unspecified" — the right default for bread.
    amountValue: doublePrecision("amount_value"),
    amountUnit: text("amount_unit"),
    note: text("note"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    index("contributions_entry_idx").on(t.entryId),
    index("contributions_recipe_addition_idx").on(t.recipeAdditionId),
  ],
);

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export const recipes = pgTable("recipes", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  sourceUrl: text("source_url"),
  // What the recipe's own quantities are for: 6 muffins, 4 portioner.
  servings: real("servings").notNull().default(4),
  servingsUnit: text("servings_unit").notNull().default("portioner"),
  imageUrl: text("image_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdBy: text("created_by").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedBy: text("updated_by").notNull(),
});

export const recipeIngredients = pgTable(
  "recipe_ingredients",
  {
    id: text("id").primaryKey(),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    // The original line, verbatim. Whatever the parser makes of "1 msk
    // finhackad persilja", the user must always be able to see what the recipe
    // actually said.
    rawText: text("raw_text").notNull(),
    amountValue: doublePrecision("amount_value"),
    amountUnit: text("amount_unit"),
    // Null when the parser could not match it. Not an error — the add sheet
    // offers to create it as a new catalog item.
    catalogItemId: text("catalog_item_id").references(() => catalogItems.id),
  },
  (t) => [index("recipe_ingredients_recipe_idx").on(t.recipeId)],
);

export const recipeAdditions = pgTable(
  "recipe_additions",
  {
    id: text("id").primaryKey(),
    listId: text("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    // Target servings ÷ recipe servings. 6 → 12 muffins gives 2.
    scaleFactor: real("scale_factor").notNull().default(1),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    addedBy: text("added_by").notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [index("recipe_additions_list_idx").on(t.listId)],
);

// ---------------------------------------------------------------------------
// Append-only: these never conflict, so they bypass the sync reducer entirely
// ---------------------------------------------------------------------------

/**
 * One row per item ticked off a list — and only when ticking off meant
 * "bought". The long-press "ta bort — köpte inte" path deliberately writes
 * nothing here, because a change of mind must not teach the cadence engine
 * that you buy saffran every Tuesday.
 */
export const purchases = pgTable(
  "purchases",
  {
    id: text("id").primaryKey(),
    catalogItemId: text("catalog_item_id")
      .notNull()
      .references(() => catalogItems.id),
    listId: text("list_id").notNull(),
    purchasedAt: timestamp("purchased_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    actor: text("actor").notNull(),
  },
  (t) => [
    index("purchases_item_time_idx").on(t.catalogItemId, t.purchasedAt),
  ],
);

/**
 * The household's own barcode memory. Every unknown EAN costs one question
 * once; after a few months a normal weekly shop resolves entirely from here,
 * which is what makes scanning instant and offline.
 */
export const barcodes = pgTable("barcodes", {
  ean: text("ean").primaryKey(),
  catalogItemId: text("catalog_item_id").references(() => catalogItems.id),
  productName: text("product_name"),
  brand: text("brand"),
  imageUrl: text("image_url"),
  source: text("source").$type<"off" | "manual">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * The catch-up log — NOT the source of truth. Materialized state lives in the
 * tables above; this exists so a client that has been offline for two days can
 * ask "everything since seq 4471" instead of re-downloading its whole world.
 *
 * client_op_id is unique so a retried op cannot apply twice.
 */
export const ops = pgTable(
  "ops",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    clientOpId: text("client_op_id").notNull(),
    listId: text("list_id"),
    actor: text("actor").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    // Client clock, as sent. Used for last-write-wins; deliberately NOT
    // rewritten to server time, or an offline phone's edits would all lose.
    at: timestamp("at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ops_client_op_id_uq").on(t.clientOpId),
    index("ops_seq_idx").on(t.seq),
  ],
);

/** Per-item suggestion dismissals — "inte den här gången", valid for one day. */
export const suggestionDismissals = pgTable(
  "suggestion_dismissals",
  {
    catalogItemId: text("catalog_item_id")
      .notNull()
      .references(() => catalogItems.id, { onDelete: "cascade" }),
    // Local date string (YYYY-MM-DD) rather than a timestamp: "for the rest of
    // today" is a calendar concept, not a 24-hour window.
    day: text("day").notNull(),
  },
  (t) => [primaryKey({ columns: [t.catalogItemId, t.day] })],
);
