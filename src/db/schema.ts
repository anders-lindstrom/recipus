import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
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
     * Soft delete — "Ta bort" in the registry, and the losing half of a merge.
     *
     * Soft for the same reason `list_entries.removed_at` is: a hard delete
     * leaves last-write-wins nothing to compare against, so a phone that was
     * offline could silently resurrect a vara somebody deliberately retired.
     *
     * There is deliberately no `deleted_updated_at` pair. Existence is not a
     * field of the row, it is the record itself, and the reducer already carries
     * a record-level clock for it — the `catalog:${id}` meta key, with
     * `deleted: true`. That key is what stamps this column, exactly as
     * `lists.deleted_at` is stamped from `list:${id}`. Giving existence a
     * *field* clock would be the second clock for one fact that this codebase
     * has already paid for three times.
     *
     * It also fixes a production bug that has nothing to do with sync: `seed.ts`
     * re-inserts every seeded catalog item on every boot, so without a
     * tombstone a deleted seeded item comes straight back on the next deploy.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
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
// The registry: two levels, products first-class
//
// A *vara* (`catalog_items`) is the household's own word — "mjölk". A *product*
// is a thing on a shelf — "Arla Mellanmjölk 1.5 l". Two levels, because "400 g"
// and "600 g" are two products of one vara, while a Swedish and a Norwegian
// barcode for the same pack are two barcodes of one product.
//
// Everything here syncs through the op log rather than server CRUD, and the
// reason is buy mode: unknown EANs are scanned *in a shop, offline*, and a
// dropped scan there is a lost purchase. Only the outbox fixes that.
// ---------------------------------------------------------------------------

/**
 * A thing on a shelf.
 *
 * Promoted out of `barcodes`, which used to be all of this with `ean` as the
 * primary key. That shape had three faults: one product with two EANs duplicated
 * its name, brand, size and mapping — and "default size" then had two homes that
 * would drift; a barcode-less product (loose vegetables, the cheese counter)
 * could not exist at all; and the two levels were mixed together.
 *
 * Rejected on the way here: one table with `eans: string[]`. Last-write-wins on
 * an array silently drops one of two concurrently-added EANs, and `wins()`
 * cannot merge them. A row per EAN means two phones adding two different EANs
 * do not conflict at all.
 *
 * `catalog_item_id` is NULL until a human places the product on a vara. That is
 * a real and common state, not a defect: an unplaced product's purchases are
 * invisible to cadence and statistics until somebody says what it was, which is
 * why the review queue advertises the debt rather than hiding it.
 */
export const products = pgTable(
  "products",
  {
    /*
     * DERIVED for scan-born products: `prod:${ean}`.
     *
     * The same reason `list_entries.id` is derived from (list, item). Two
     * offline phones scanning the same unknown EAN must converge on one product
     * rather than quietly creating two — and they cannot coordinate to pick a
     * shared random id. Products created by hand (the cheese counter) get a
     * generated id instead; nothing here depends on the shape.
     */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    brand: text("brand"),
    // NULL means "not yet placed on a vara". See the note above.
    catalogItemId: text("catalog_item_id").references(() => catalogItems.id),
    // The `Amount` pair, identical in shape to a contribution's, so the same
    // parser and the same formatter serve both.
    defaultSizeValue: doublePrecision("default_size_value"),
    defaultSizeUnit: text("default_size_unit"),
    /*
     * Open Food Facts' size string, verbatim.
     *
     * It exists because the parser is lossy in a way that matters here:
     * `parseAmount("6 x 33 cl")` returns `{6, "st"}` — verified by execution.
     * Six of something is not wrong, but it is not 198 cl either, and throwing
     * away what the pack actually said would leave nobody able to tell which.
     */
    sourceSizeText: text("source_size_text"),
    imageUrl: text("image_url"),
    /*
     * EARLIEST-WINS, not last-write-wins.
     *
     * Forced by the derived id. Two offline phones scanning the same EAN both
     * create `prod:${ean}`, so the row has two creations to reconcile and only
     * one can be recorded. Last-write-wins would make the answer depend on
     * arrival order; earliest-wins does not. Same rule and the same helper as
     * `list_entries.created_at` — see `earliestCreation` in the reducer.
     */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by").notNull(),
    /*
     * Four independent clocks, one per editable fact — and every one of them
     * NULLABLE, with no default and no fallback anywhere.
     *
     * NULL means "no op has ever written this field", which is exactly the state
     * the reducer holds for an untouched field: `wins(op, undefined)` is true, so
     * the first write lands whatever its timestamp. That is the whole point here,
     * because a product is BORN from Open Food Facts rather than from a person.
     * Defaulting these to the creation time would make OFF's guess outrank a
     * human correction made on a phone whose clock sat behind the server's — the
     * shape of the bug `drizzle/0004` names for `priority_updated_at`, arriving
     * where it would be least visible.
     *
     * `catalog_items` has the same four-clocks-one-row structure but NOT NULL
     * columns, and the difference is deliberate: a vara is born with all four of
     * its facts asserted by whoever created it, so "never written" is not a state
     * it can be in. A product's mapping starts genuinely unasserted.
     *
     * `size` covers `default_size_value` AND `default_size_unit`: one fact in two
     * columns, treated exactly as `name`/`name_norm` are on a catalog item.
     * Letting the number and the unit carry separate clocks would allow "500" and
     * "l" to settle from different writes and produce a size nobody ever entered.
     *
     * `item` is the mapping to a vara, and it is the one a human argues with —
     * "no, that Gevalia is *kaffe*, not ost". It must be able to beat an
     * auto-map made a second earlier by the machine, which is only true while
     * the auto-map stamps its own clock honestly and nothing else stamps this.
     */
    nameUpdatedAt: timestamp("name_updated_at", { withTimezone: true }),
    nameUpdatedBy: text("name_updated_by"),
    brandUpdatedAt: timestamp("brand_updated_at", { withTimezone: true }),
    brandUpdatedBy: text("brand_updated_by"),
    sizeUpdatedAt: timestamp("size_updated_at", { withTimezone: true }),
    sizeUpdatedBy: text("size_updated_by"),
    itemUpdatedAt: timestamp("item_updated_at", { withTimezone: true }),
    itemUpdatedBy: text("item_updated_by"),
    // Soft, for the same reason `catalog_items.deleted_at` is, and stamped from
    // the same place: the record-level `product:${id}` meta key, never a field
    // clock of its own.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /*
     * "Last touched by anyone" — derived from the field clocks, never stamped
     * with whichever op happened to arrive last. See `latestClock`.
     *
     * It is not a conflict-resolution input for any field on this row; every
     * field above answers for itself. It exists so the tombstone has a timestamp
     * and so `/varor` can order by recency, and it is written last precisely so
     * that nothing is ever tempted to fall back to it. A field clock that falls
     * back to a row clock is a second clock nobody declared — that is the bug in
     * `contributions.note_updated_at`, written down at length there.
     */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    // Both registry reads go through this: "which products sit on this vara"
    // for `/varor`, and `WHERE catalog_item_id IS NULL` for the review queue.
    index("products_catalog_item_idx").on(t.catalogItemId),
  ],
);

/**
 * The household's own barcode memory, demoted to an EAN → product pointer.
 *
 * Every unknown EAN costs one question once; after a few months a normal weekly
 * shop resolves entirely from here, which is what makes scanning instant and
 * offline. What changed is only where the answer lives: the name, brand, image
 * and size moved onto `products`, and this table now holds nothing but the
 * pointer — so two EANs for one pack stop being two half-copies of a product.
 *
 * A row per EAN is what makes concurrent scans conflict-free: two phones adding
 * two different EANs for the same product write two different rows and never
 * compare against each other at all.
 */
export const barcodes = pgTable(
  "barcodes",
  {
    ean: text("ean").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    // How this pointer came to be. It says nothing about the product's data any
    // more — that moved — only whether a person confirmed this EAN or a lookup
    // proposed it.
    source: text("source").$type<"off" | "manual">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by").notNull(),
    // A mis-scanned EAN has to be retractable, and a hard delete would let a
    // stale scan from an offline phone put it straight back.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // The row clock. This record has exactly one editable fact — which product
    // it points at — so the record-level clock IS that fact's clock, and there
    // is nothing for a field clock to disambiguate.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [index("barcodes_product_idx").on(t.productId)],
);

/**
 * Another word for a vara.
 *
 * Deliberately the identical shape to the EAN → product pointer above: a
 * primary-key string, a foreign key, a row clock and a tombstone. One pattern
 * implemented twice rather than two patterns that have to be learned twice.
 *
 * Its job is merges. When "creme fraiche" is merged into "crème fraîche" the
 * losing word survives here, so recipe lines written years ago keep resolving —
 * verified by execution to need zero matcher changes, because `matchIngredient`
 * already takes a candidate list and the caller simply expands each vara into
 * one candidate per name-or-alias.
 *
 * `alias_norm` is the primary key, so two people cannot point the same word at
 * two different varor: that is a genuine conflict and last-write-wins settles it
 * on this row's clock, rather than the matcher silently picking one.
 */
export const catalogItemAliases = pgTable(
  "catalog_item_aliases",
  {
    // Lowercased and diacritic-folded, exactly like `catalog_items.name_norm`.
    // An alias that is not folded the same way is an alias that never matches.
    aliasNorm: text("alias_norm").primaryKey(),
    catalogItemId: text("catalog_item_id")
      .notNull()
      .references(() => catalogItems.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by").notNull(),
    // Soft: an alias removed on one phone must not come back because another
    // phone was offline when the merge happened.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [index("catalog_item_aliases_item_idx").on(t.catalogItemId)],
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
    /*
     * Which vara this purchase counted for — NULLABLE, and the CHECK below is
     * what keeps that from meaning "nothing".
     *
     * Tapping a tile off the list writes `{item, null}`. ANY scan writes
     * `{null, product}`, mapped or not, and the vara is then read through the
     * product:
     *
     *     effective item = COALESCE(purchases.catalog_item_id, products.catalog_item_id)
     *
     * Not denormalising the vara onto a scan-sourced purchase is the whole
     * point. Placing an unplaced product retro-attributes its entire history for
     * free rather than needing a migration; correcting a wrong guess moves every
     * past purchase with it; and a split carries exactly the history it can
     * honestly carry — we know what we scanned, we do not know what we tapped,
     * so tile-tap purchases stay put and are never divided.
     *
     * The stated cost: until a human places the product, its purchases are
     * invisible to cadence and statistics. Deferred, not lost — and it is why
     * the review queue is the thing that makes the numbers true rather than
     * cosmetic tidying.
     */
    catalogItemId: text("catalog_item_id").references(() => catalogItems.id),
    productId: text("product_id").references(() => products.id),
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
    /*
     * How much was bought. Nothing in v1 reads these.
     *
     * They are here anyway because they are the one thing on this table that
     * CANNOT be added later: a purchase row records a moment in a shop, and no
     * amount of future code can reconstruct how many litres of milk went into a
     * basket in March. Every other column here is derivable or correctable after
     * the fact; this one is gone the instant it is not written.
     */
    quantityValue: doublePrecision("quantity_value"),
    quantityUnit: text("quantity_unit"),
  },
  (t) => [
    index("purchases_item_time_idx").on(t.catalogItemId, t.purchasedAt),
    // The scan side of the same question. `loadPurchaseStats` resolves an
    // unmapped purchase through its product, and without this that is a
    // sequential scan of the whole history on every snapshot.
    index("purchases_product_time_idx").on(t.productId, t.purchasedAt),
    uniqueIndex("purchases_client_op_id_uq").on(t.clientOpId),
    /*
     * A purchase must attribute to SOMETHING.
     *
     * Both columns are nullable on their own — a tile tap has no product, a scan
     * of an unplaced product has no vara — so nullability alone would permit a
     * row that records a purchase of nothing at all. There is no code path that
     * writes one today; the constraint is here so there is no code path that can.
     */
    check(
      "purchases_attribution_ck",
      sql`${t.catalogItemId} IS NOT NULL OR ${t.productId} IS NOT NULL`,
    ),
  ],
);

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
