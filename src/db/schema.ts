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
    // Drive recency/frequency ordering of the catalog. Derived from purchases,
    // never from an op's patch — see the reducer's update_catalog_item.
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /*
     * Four independent last-write-wins clocks, one per editable fact.
     *
     * The name, the aisle, the icon and "we always have this" are separate
     * opinions that happen to share a row. With one clock for the lot, renaming
     * an item at 17:00 and re-filing it into another aisle at 14:00 converge
     * differently depending on which op the server sees first: applied in that
     * order both stick, applied in the other the re-filing loses and the item
     * silently walks back to its old aisle. Verified by execution.
     *
     * This matters more than it looks. Every one of these fields becomes
     * editable with the item registry, and two people tidying the catalog on a
     * Sunday afternoon is exactly the shape that produces concurrent edits to
     * different fields of the same item.
     *
     * `name` and `name_norm` deliberately share the `name` clock: they are one
     * fact in two representations, and letting them diverge would leave an item
     * findable under a name it no longer displays.
     */
    nameUpdatedAt: timestamp("name_updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    nameUpdatedBy: text("name_updated_by").notNull(),
    categoryUpdatedAt: timestamp("category_updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    categoryUpdatedBy: text("category_updated_by").notNull(),
    iconUpdatedAt: timestamp("icon_updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    iconUpdatedBy: text("icon_updated_by").notNull(),
    homeUpdatedAt: timestamp("home_updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    homeUpdatedBy: text("home_updated_by").notNull(),
    /*
     * "Last touched by anyone", not a conflict-resolution clock.
     *
     * Two things read it: `create_catalog_item`'s own LWW comparison, and the
     * seed guard (`upsertSeedCatalogItem`), which refuses to overwrite a row
     * whose `updated_by` is no longer the seed actor. That second one is why
     * every field write must still stamp this — otherwise a household rename
     * would leave `updated_by = 'system'` and the next deploy would quietly
     * revert it.
     */
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
    /*
     * How much this one matters on the way round the shop.
     *
     * Cleared by removal, which is the rule that keeps it meaning anything:
     * without it, urgency survives being bought and re-added, and once a third
     * of the list is ochre nothing on it reads as urgent.
     *
     * Its own clock, separate from the row's. They answer different questions —
     * "is this on the list" and "how much does it matter" — and sharing one
     * would let "mark urgent" beat a newer removal and push something you have
     * already bought back to the top. NULL means nobody has ever set it, which
     * is not the same as "normal" and is what lets any first write land.
     */
    priority: text("priority")
      .$type<"urgent" | "normal" | "convenient">()
      .notNull()
      .default("normal"),
    priorityUpdatedAt: timestamp("priority_updated_at", { withTimezone: true }),
    priorityUpdatedBy: text("priority_updated_by"),
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
    /*
     * What kind of the thing — "mogna", "osaltat", "laktosfri".
     *
     * On the contribution and never in the entry's id. A modifier that changed
     * identity would split one tile into two and send you past the fruit twice.
     * When ripe mango genuinely deserves its own cadence, that is the registry's
     * split — a decision about the household's own taxonomy — not something
     * typing a word into the add bar should do behind their back.
     */
    modifier: text("modifier"),
    /*
     * The amount and the note carry SEPARATE last-write-wins clocks, and they
     * have to survive the round trip through this table.
     *
     * The reducer already treats them as independent — an older `set_amount`
     * arriving after a newer `set_note` must not take the quantity down with
     * it. But with one `updated_at` for the whole row, both clocks collapse to
     * the same value on write and come back identical on read, so the server
     * reconstructs a state the client never had. You set 5 dl, your partner
     * adds a note, and after a reload the server thinks the note's timestamp
     * governs the amount too — the two devices then disagree about how much
     * cream you need, which is the exact failure this app exists to prevent.
     *
     * NULL means "nobody has ever written this field", and that is the whole
     * meaning — it must NOT fall back to the row clock.
     *
     * It used to. The row clock MOVES: writing the amount at 05:00 pushed
     * `updated_at` to 05:00, so the note's fallback clock silently advanced to
     * 05:00 too, and a note genuinely written at 03:00 arriving afterwards lost
     * a comparison it should have won. In the other arrival order it won, and
     * the two devices ended up with different notes, each correct by its own
     * reckoning. Reproduced by execution.
     *
     * A fallback that moves is not a default, it is a second clock nobody
     * declared. Absent meta is what the reducer itself produces for a field no
     * op has touched — `wins(op, undefined)` is true, so any write lands — and
     * NULL here reconstructs exactly that. Rows written before drizzle/0003 were
     * backfilled from the row clock, which preserves the behaviour they already
     * had rather than retroactively opening them up.
     *
     * Recipe and scan contributions resolve on the row-level key instead, and
     * keep these equal to it.
     */
    amountUpdatedAt: timestamp("amount_updated_at", { withTimezone: true }),
    amountUpdatedBy: text("amount_updated_by"),
    noteUpdatedAt: timestamp("note_updated_at", { withTimezone: true }),
    noteUpdatedBy: text("note_updated_by"),
    modifierUpdatedAt: timestamp("modifier_updated_at", { withTimezone: true }),
    modifierUpdatedBy: text("modifier_updated_by"),
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
    /**
     * The `remove_item` op that recorded this purchase.
     *
     * Its point is undo. Tapping a tile off the list writes a purchase here, and
     * until this column existed there was no way to find that row again — so
     * "Ångra" put the item back on the list and left the purchase standing
     * forever, along with the `use_count` bump. Every read of purchase history
     * was therefore slightly wrong in the one direction users notice: it counted
     * things they had explicitly said they did not buy.
     *
     * Unique, so replaying an op cannot double-count a purchase — the same
     * guarantee `clientOpId` already gives the op log, applied one layer down.
     */
    clientOpId: text("client_op_id").notNull(),
  },
  (t) => [
    index("purchases_item_time_idx").on(t.catalogItemId, t.purchasedAt),
    uniqueIndex("purchases_client_op_id_uq").on(t.clientOpId),
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
