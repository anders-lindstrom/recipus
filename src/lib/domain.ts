/**
 * Shared domain types for Recipus.
 *
 * Every module — the pure engines, the API, the client store and the UI —
 * speaks these types. They are deliberately plain data: no classes, no methods,
 * nothing that cannot survive a trip through JSON, IndexedDB or Postgres.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export type Id = string;

/**
 * A list entry's id is derived from its natural key rather than generated.
 *
 * This matters more than it looks. Two phones offline in different shops both
 * adding milk must converge on *one* entry when they sync, and they cannot
 * coordinate on a random UUID. Deriving the id from (listId, catalogItemId)
 * makes the two adds literally the same operation, which is why the sync
 * reducer needs no special case for it.
 */
export function entryId(listId: Id, catalogItemId: Id): Id {
  return `${listId}:${catalogItemId}`;
}

/**
 * The manual amount on an entry is a singleton, so typing "2 l" on two phones
 * resolves last-write-wins rather than accumulating to 4 l.
 */
export function manualContributionId(entry: Id): Id {
  return `${entry}#manual`;
}

/**
 * A recipe's contribution to one item is likewise deterministic: the same
 * recipe addition asking for the same item is always the same contribution,
 * however many times the op is replayed.
 */
export function recipeContributionId(
  recipeAdditionId: Id,
  catalogItemId: Id,
): Id {
  return `${recipeAdditionId}#${catalogItemId}`;
}

// ---------------------------------------------------------------------------
// Units and amounts
// ---------------------------------------------------------------------------

export type UnitFamily = "volume" | "mass" | "count";

export type VolumeUnit = "ml" | "krm" | "tsk" | "msk" | "cl" | "dl" | "l";
export type MassUnit = "g" | "hg" | "kg";
export type CountUnit = "st" | "förp" | "burk" | "påse" | "knippe" | "pkt";

export type Unit = VolumeUnit | MassUnit | CountUnit;

export interface Amount {
  value: number;
  unit: Unit;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface User {
  autheliaUser: string;
  displayName: string;
  /** Hex colour used for the presence dot and avatar. */
  color: string;
}

export interface Category {
  id: Id;
  name: string;
  /** Emoji codepoint, e.g. "1F34E". See CatalogItem.iconRef. */
  icon: string;
  position: number;
}

export interface CatalogItem {
  id: Id;
  name: string;
  /** Lowercased, diacritic-folded name used for search and matching. */
  nameNorm: string;
  categoryId: Id;
  /**
   * An emoji codepoint such as "1F95B". Rendered from the OpenMoji sprite when
   * `pnpm icons:build` has produced one, and as the corresponding system emoji
   * character otherwise — so the app is never iconless.
   */
  iconRef: string;
  /** True for items the household created, false for seeded ones. */
  isCustom: boolean;
  /**
   * Staples you always have: salt, peppar, olja, bakpulver. Excluded by default
   * when a recipe is added to a list, one tap to include anyway.
   */
  hasAtHome: boolean;
  /**
   * Kept, but out of the way — not offered by search, the catalog well or the
   * add bar's "Vanligast" panel.
   *
   * This is what makes a household's own kinds safe to invent. Splitting "mogna
   * blåbär" off as its own vara is the supported answer to wanting two kinds
   * tracked apart, and the whole point of it is that the vara persists and can
   * be picked again next month. But the app cannot know whether a sort typed
   * once was a taxonomy decision or a one-off, and a catalog that only ever
   * grows makes the next search worse — so there has to be a way to nudge one
   * out of the way afterwards.
   *
   * Deliberately NOT the soft delete `deletedAt` already provides. That one
   * means "we do not buy this": it is blocked while the vara sits on a list or
   * carries products, and it turns a live tile into a stand-in. Hiding makes no
   * claim about the thing at all — the purchases, products and recipe matches
   * all stay, and `/varor` still lists it so it can come straight back.
   */
  hidden: boolean;
  /** Drives recency/frequency ordering of the catalog. */
  useCount: number;
  lastUsedAt: string | null;
}

export interface List {
  id: Id;
  name: string;
  icon: string;
  position: number;
  /** Category ids in this store's walking order. Categories not listed fall to the end. */
  categoryOrder: Id[];
}

export type SourceKind = "manual" | "recipe" | "scan" | "suggestion";

/**
 * One reason an item is on a list, with the amount that reason asks for.
 *
 * An entry holds a set of these rather than a single number. That is what makes
 * the total trustworthy — 8 dl for the muffins plus 3 dl for the sauce shows as
 * 11 dl — and what lets one recipe be withdrawn without disturbing the rest.
 */
export interface Contribution {
  id: Id;
  entryId: Id;
  sourceKind: SourceKind;
  /** Set when sourceKind is "recipe"; identifies which addition asked for it. */
  recipeAdditionId: Id | null;
  /** Null means "some, unspecified" — the correct default for bread. */
  amount: Amount | null;
  note: string | null;
  /**
   * What kind of the thing — "mogna", "osaltat", "laktosfri".
   *
   * On the contribution and never in an id. A modifier that changed the entry's
   * identity would split one tile into two, and you would walk past the fruit
   * twice. When the household genuinely wants ripe mango tracked as its own
   * thing with its own cadence, that is the registry's split — a decision about
   * their taxonomy — not something typing a word into the add bar should do
   * behind their back.
   */
  modifier: string | null;
}

/**
 * A manual contribution with nothing left to say — the reducer holds no record
 * for one of these (see `setManualField`), but its CLOCKS still matter.
 *
 * Both database loaders need this exact test, because the row and the record are
 * not the same thing here: the row has to survive so the per-field clocks
 * survive with it, while the record must stay absent so the server's state
 * matches what the client reducer produces from the same ops.
 *
 * Restricted to `manual` on purpose. A recipe contribution with no amount is a
 * perfectly ordinary "the recipe wants salt, quantity unstated" and must keep
 * its record.
 */
export function isClearedManualContribution(c: Contribution): boolean {
  return (
    c.sourceKind === "manual" &&
    c.amount === null &&
    c.note === null &&
    c.modifier === null
  );
}

/**
 * How much this one matters, on the way round the shop.
 *
 * Three states rather than a flag, because "grab it if you pass it" is a real
 * and different instruction from "we are out of it" — and a two-state urgent
 * flag makes everything else read as "not urgent", which is not what a normal
 * item is.
 */
export type Priority = "urgent" | "normal" | "convenient";

export interface ListEntry {
  id: Id;
  listId: Id;
  catalogItemId: Id;
  createdAt: string;
  createdBy: string;
  /**
   * Tombstone. Removal is a soft delete so that last-write-wins can compare a
   * late-arriving add against it; a hard delete would let a stale add silently
   * resurrect something you already bought. Pruned after 30 days with the ops.
   */
  removedAt: string | null;
  /**
   * Cleared by removal, deliberately.
   *
   * Otherwise urgency becomes permanent decoration: buy the urgent milk, re-add
   * it next week, and it is still ochre and still first. Once a third of the
   * list is urgent, nothing is.
   */
  priority: Priority;
  /** LWW metadata: whoever wrote last, and when, by client clock. */
  updatedAt: string;
  updatedBy: string;
}

export interface RecipeIngredient {
  id: Id;
  recipeId: Id;
  position: number;
  /** The original line, kept verbatim so nothing is ever silently lost. */
  rawText: string;
  amount: Amount | null;
  /** Null when the parser could not match it to the catalog. */
  catalogItemId: Id | null;
}

export interface Recipe {
  id: Id;
  title: string;
  sourceUrl: string | null;
  /** What the recipe's own quantities are for — 6 muffins, 4 portioner. */
  servings: number;
  servingsUnit: string;
  imageUrl: string | null;
  /**
   * The method, one step per entry, in order. Empty when nobody has written or
   * imported one — which is common, and is why the screen has to read well with
   * no steps at all rather than treating it as a missing field.
   */
  instructions: string[];
  /** The household's own note. Never overwritten by an import — it is theirs. */
  notes: string | null;
  ingredients: RecipeIngredient[];
}

export interface RecipeAddition {
  id: Id;
  listId: Id;
  recipeId: Id;
  /** Target servings ÷ recipe servings. 6 → 12 muffins gives 2. */
  scaleFactor: number;
  addedAt: string;
  addedBy: string;
}

/**
 * A specific thing on a shelf — "Arla Standardmjölk 1,5 l" — as opposed to the
 * household's word for it, which is the `CatalogItem` ("mjölk").
 *
 * Two levels, because the old single table could not represent what a household
 * actually has: "400 g" and "600 g" of the same thing are two products, while a
 * Swedish and a Norwegian barcode for one pack are two barcodes of one product.
 * And a product with no barcode at all — the cheese counter, loose vegetables —
 * has to be expressible, which it was not when the EAN was the primary key.
 */
export interface Product {
  id: Id;
  name: string;
  brand: string | null;
  /**
   * The vara this is an instance of, or null for "not placed yet".
   *
   * Null is a real and common state, not a missing value: a product born from a
   * scan of an unknown barcode has a name from Open Food Facts and nobody's
   * opinion yet about which of the household's words it belongs under. Its
   * purchases are invisible to cadence until someone says — deferred, not lost,
   * which is what the review queue exists to clear.
   */
  catalogItemId: Id | null;
  /** What one pack contains. Same `Amount` shape, so one parser serves both. */
  defaultSize: Amount | null;
  /**
   * Open Food Facts' size string, verbatim.
   *
   * The parser is lossy in a way that matters here: `parseAmount("6 x 33 cl")`
   * returns `{6, "st"}`. Six of something is not wrong, but it is not 198 cl
   * either, and throwing away what the pack said leaves nobody able to tell.
   */
  sourceSizeText: string | null;
  imageUrl: string | null;
  createdAt: string;
  createdBy: string;
}

/**
 * Scan-born product ids are DERIVED, for the same reason `entryId` is.
 *
 * Two phones offline in different shops scanning the same unknown barcode must
 * converge on one product rather than quietly creating two, and they cannot
 * coordinate on a random id. Products created by hand get a generated id
 * instead; nothing depends on the shape.
 */
export function productId(ean: string): Id {
  return `prod:${ean}`;
}

/**
 * An extra word that reaches a vara.
 *
 * The entire mechanism behind "a merged-away word keeps resolving": merging
 * `köttfärs` into `nötfärs` tombstones the first and keeps its word as an alias
 * of the second, so every recipe line already written against it still matches.
 * Deliberately the same one-row-per-value shape as the EAN→product pointer —
 * one pattern implemented twice rather than an array column, because
 * last-write-wins on an array silently drops one of two concurrent additions.
 */
export interface CatalogItemAlias {
  /** Already normalized, exactly as the column stores it. Also the identity. */
  aliasNorm: string;
  catalogItemId: Id;
  createdAt: string;
  createdBy: string;
}

/** One barcode, pointing at the product it identifies. */
export interface BarcodeLink {
  ean: string;
  productId: Id;
  source: BarcodeSource;
}

export type BarcodeSource = "off" | "manual";

export interface Barcode {
  ean: string;
  catalogItemId: Id | null;
  productName: string | null;
  brand: string | null;
  imageUrl: string | null;
  source: BarcodeSource;
}

export interface Purchase {
  id: Id;
  catalogItemId: Id;
  listId: Id;
  purchasedAt: string;
  actor: string;
}

// ---------------------------------------------------------------------------
// The state the sync reducer owns
// ---------------------------------------------------------------------------

/**
 * Last-write-wins bookkeeping for one record.
 *
 * DO NOT REMOVE. src/lib/sync/reducer.ts depends on this, and without it
 * conflict resolution silently stops working — two phones' lists diverge with
 * no error anywhere.
 *
 * Kept in a side map rather than on the records themselves so the domain types
 * stay the shape the UI and the database actually want. `deleted` is a
 * tombstone: without it, a delete would erase the very timestamp a late-arriving
 * create needs to lose against, and the record would silently come back.
 */
export interface RecordMeta {
  at: string;
  by: string;
  deleted?: boolean;
}

/**
 * Everything that syncs, as plain maps. The client holds one of these in memory
 * (mirrored to IndexedDB); the server derives the same shape from Postgres when
 * it needs to apply an op. Purchases and barcodes are deliberately absent —
 * they are append-only and never conflict, so they do not need the reducer.
 */
export interface SyncState {
  lists: Record<Id, List>;
  catalog: Record<Id, CatalogItem>;
  entries: Record<Id, ListEntry>;
  contributions: Record<Id, Contribution>;
  recipes: Record<Id, Recipe>;
  recipeAdditions: Record<Id, RecipeAddition>;
  /**
   * The registry, synced through the op log rather than server CRUD.
   *
   * Curating the catalog is an online, sit-down activity, which argued for plain
   * endpoints — but unknown barcodes are created *in a shop, offline*, and with
   * buy mode a dropped scan is a lost purchase. Only the outbox fixes that. Two
   * things fall out for free: `/varor` renders from this state and works offline
   * with no new endpoint, and the "local EAN map" the design doc promised (and
   * which never existed) is simply `barcodes` below.
   */
  products: Record<Id, Product>;
  /** Keyed by `aliasNorm`, which is the alias's whole identity. */
  aliases: Record<string, CatalogItemAlias>;
  /** Keyed by EAN. One row per barcode, so two phones adding two different
   * barcodes for one product do not conflict at all. */
  barcodes: Record<string, BarcodeLink>;
  /**
   * Keyed "list:x", "catalog:x", "entry:x", "contribution:x",
   * "contribution:x:amount", "contribution:x:note", "addition:x".
   * The exact key shapes live in src/lib/sync/reducer.ts — mirror them from
   * there rather than retyping, because a mismatched key silently disables
   * conflict resolution instead of failing.
   */
  meta: Record<string, RecordMeta>;
}

export function emptyState(): SyncState {
  return {
    lists: {},
    catalog: {},
    entries: {},
    contributions: {},
    recipes: {},
    recipeAdditions: {},
    products: {},
    aliases: {},
    barcodes: {},
    meta: {},
  };
}
