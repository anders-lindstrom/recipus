import type {
  Amount,
  BarcodeSource,
  CatalogItem,
  Id,
  List,
  Priority,
  Product,
} from "@/lib/domain";

/**
 * The operation log.
 *
 * Every change to a shared list is one of these. The client applies an op
 * optimistically the instant you tap; the server applies the same op with the
 * same reducer and fans it out. One implementation running in two places is the
 * only thing keeping two phones' idea of the list identical.
 */

export interface OpBase {
  /** Idempotency key. A retried op must not apply twice. */
  clientOpId: string;
  /** Authelia username of whoever made the change. */
  actor: string;
  /**
   * ISO timestamp from the CLIENT clock, deliberately not rewritten to server
   * time. Rewriting it would make every edit made while offline lose to every
   * edit made online, which is precisely backwards.
   */
  at: string;
}

export type Op =
  | (OpBase & {
      kind: "create_list";
      listId: Id;
      name: string;
      icon: string;
      position: number;
      categoryOrder: Id[];
    })
  | (OpBase & {
      kind: "update_list";
      listId: Id;
      patch: Partial<Pick<List, "name" | "icon" | "position" | "categoryOrder">>;
    })
  | (OpBase & { kind: "delete_list"; listId: Id })
  | (OpBase & { kind: "create_catalog_item"; item: CatalogItem })
  | (OpBase & {
      kind: "update_catalog_item";
      itemId: Id;
      patch: Partial<Omit<CatalogItem, "id">>;
    })
  | (OpBase & {
      kind: "add_item";
      listId: Id;
      catalogItemId: Id;
      /**
       * Set only by undo, naming the `remove_item` whose purchase this retracts.
       *
       * Putting the items back was never the whole job. Tapping a tile off the
       * list writes a purchase row and bumps the item's use count, and undo used
       * to leave both standing — so "bought" quietly included everything anyone
       * had ever tapped by mistake, which is the one direction that matters for
       * a feature whose entire output is "how often do we buy this".
       *
       * Optional, and the reducer ignores it: retraction is a server-side effect
       * exactly like the purchase write it undoes, so an older client receiving
       * this op still applies the add correctly and simply does not know about
       * the history correction.
       */
      undoesClientOpId?: string;
      /**
       * Opt out of the put-it-back rule. Set by scanning, and by nothing else.
       *
       * An ordinary add that puts a vara BACK on the list takes back a purchase
       * of that vara made in the last half hour — see `retractRecentPurchase`.
       * A scan cannot mean that. Scanning asserts the product is in your hand,
       * so `add_and_buy` scanning the same vara twice is two bottles, and its
       * add half would otherwise retract the first bottle and rewrite it a
       * minute later, leaving one purchase where there were two.
       *
       * Optional, and the reducer ignores it, like `undoesClientOpId` beside it:
       * both are server-side history corrections, so a client that has never
       * heard of either still applies the add correctly.
       */
      keepsPurchase?: boolean;
    })
  | (OpBase & {
      kind: "remove_item";
      listId: Id;
      catalogItemId: Id;
      /** True = ticked off in a shop. False = changed your mind; logs no purchase. */
      bought: boolean;
    })
  | (OpBase & {
      kind: "set_amount";
      listId: Id;
      catalogItemId: Id;
      amount: Amount | null;
    })
  | (OpBase & {
      kind: "set_note";
      listId: Id;
      catalogItemId: Id;
      note: string | null;
    })
  | (OpBase & {
      /**
       * Its own op with its own clock, deliberately not folded onto set_amount.
       *
       * A third independent fact on one record needs a third independent clock.
       * Sharing one is the bug already recorded twice in this codebase: an older
       * write to one field arriving after a newer write to another takes the
       * first field's value down with it.
       */
      kind: "set_modifier";
      listId: Id;
      catalogItemId: Id;
      modifier: string | null;
    })
  | (OpBase & {
      kind: "set_priority";
      listId: Id;
      catalogItemId: Id;
      priority: Priority;
    })
  | (OpBase & {
      kind: "add_recipe";
      listId: Id;
      recipeId: Id;
      recipeAdditionId: Id;
      scaleFactor: number;
      /** Amounts are ALREADY scaled by the caller. The reducer stores them as given. */
      items: Array<{ catalogItemId: Id; amount: Amount | null }>;
    })
  | (OpBase & { kind: "remove_recipe"; listId: Id; recipeAdditionId: Id })
  | (OpBase & {
      /**
       * A recipe's share of the ask, moved to another vara.
       *
       * The half of a merge `merge_catalog_items` is forbidden to do. That op
       * tombstones a word and records an alias and NOTHING else, so what hangs
       * off the losing word has to be moved around it by ops of its own — and
       * before this one existed, the only op that could carry a recipe's 1200 g
       * across was `set_amount`, which says "manual". The number survived and
       * the provenance did not: the tile stopped saying "från recept", the
       * breakdown stopped naming the recipe, and `remove_recipe` — which
       * collects by `recipeAdditionId` — no longer recognised the share as its
       * own, so taking the recipe off the list left the 1200 g stranded on the
       * survivor. Adding the recipe back then stacked a second 1200 g on top of
       * it, silently, on one tile.
       *
       * Re-issuing `add_recipe` with the items re-pointed would move the same
       * share with no new op kind, and was rejected: `add_recipe` upserts an
       * entry per item, so it would put every ingredient of that recipe back on
       * the list, including the ones already ticked off in the shop.
       *
       * Order-independent for the reason `move_item` is — the op carries its
       * payload rather than reading the state it rewrites — and each half
       * resolves on its own contribution clock, so the arrival order of a
       * concurrent `add_recipe` cannot leave the share in two places or in
       * none.
       */
      kind: "repoint_recipe_item";
      listId: Id;
      recipeAdditionId: Id;
      fromCatalogItemId: Id;
      toCatalogItemId: Id;
      /** Already scaled, exactly as `add_recipe` carries it. */
      amount: Amount | null;
    })
  | (OpBase & {
      /**
       * Buy it at the other shop instead.
       *
       * The op carries what it moves, and that is the whole design. Every other
       * op states its own change outright; a move phrased as "take whatever is
       * on the source and put it over there" would have to READ the state it
       * rewrites, and a read-modify-write cannot be order-independent. A
       * `set_amount` the mover had not seen yet is present in one arrival order
       * and absent in the other, so two devices settle on different amounts at
       * the destination and neither is wrong by its own reckoning — the exact
       * silent divergence this log exists to rule out.
       *
       * So the moving device names the payload, and the reducer stays a pure
       * function of the op set. The cost is that a concurrent edit the mover had
       * not seen does not travel: it stays on the source entry, invisible under
       * the tombstone, until someone puts the item back on that list. That is a
       * bounded, recoverable loss, and it is the one this trade buys — the
       * alternative is two lists that disagree forever with no error anywhere.
       */
      kind: "move_item";
      fromListId: Id;
      toListId: Id;
      catalogItemId: Id;
      /** The source entry's urgency, travelling with it rather than staying behind. */
      priority: Priority;
      /**
       * The source entry's own amount/note/modifier, or null when it had none.
       *
       * Only the MANUAL contribution moves. A recipe's share is keyed to a
       * recipe addition, and additions are list-scoped
       * (`recipe_additions.list_id`) — a recipe that asked for cream at Hemköp
       * has no meaning at Bauhaus, and dragging its contribution across would
       * make one recipe appear on two lists. Moving an item is a statement about
       * where you will buy it, not about the recipe.
       */
      manual: {
        amount: Amount | null;
        note: string | null;
        modifier: string | null;
      } | null;
    })
  | RegistryOp;

/**
 * The registry ops.
 *
 * Kept in the op log rather than behind server CRUD, which was argued both ways
 * and decided by one fact: unknown barcodes are created in a shop, offline. The
 * design doc already promises they are queued rather than dropped, and with buy
 * mode a dropped scan is a lost purchase — only the outbox can fix that.
 */
export type RegistryOp =
  | (OpBase & {
      /**
       * A product the household has met — usually from scanning an unknown
       * barcode, sometimes typed in for something the cheese counter sells.
       *
       * `product.id` is DERIVED for scan-born products (`prod:${ean}`), so two
       * offline phones scanning the same barcode create the same product rather
       * than two. That makes creation earliest-wins rather than last-write-wins:
       * both devices are creating the same row, and only one creation timestamp
       * can be recorded, so it must be the one that does not depend on which op
       * happened to arrive first.
       */
      kind: "create_product";
      product: Product;
    })
  | (OpBase & {
      /**
       * Correcting a product, one fact at a time.
       *
       * Four independent clocks — name, brand, size, and the mapping to a vara —
       * for the reason `update_catalog_item` has four: a patch that says nothing
       * about the brand must not stamp the brand's clock, or an op that is silent
       * about a field beats one that actually changes it.
       *
       * `catalogItemId` is the interesting one. It starts null for anything born
       * from Open Food Facts, and placing it is the whole job of the review
       * queue; it also has to be *re-placeable*, because a wrong auto-map is
       * exactly the thing a person is there to fix.
       */
      kind: "update_product";
      productId: Id;
      patch: Partial<
        Pick<
          Product,
          "name" | "brand" | "catalogItemId" | "defaultSize" | "sourceSizeText"
        >
      >;
    })
  | (OpBase & {
      /**
       * One barcode, pointing at a product.
       *
       * A row per EAN rather than an array on the product, deliberately: two
       * phones adding two different barcodes for the same pack then do not
       * conflict at all, whereas last-write-wins on an array would silently drop
       * one of them and `wins()` has no way to merge.
       */
      kind: "link_barcode";
      ean: string;
      productId: Id;
      source: BarcodeSource;
    })
  | (OpBase & { kind: "delete_catalog_item"; itemId: Id })
  | (OpBase & {
      /**
       * Two words for one thing, resolved into one.
       *
       * The reducer does exactly two things: tombstones `fromItemId`, and records
       * `aliasNorm` as a way of reaching `toItemId`. It must NEVER rewrite entry
       * or contribution rows, and that constraint is load-bearing rather than
       * laziness — a merge implemented as row rewriting diverges. `merge(B→A)` at
       * T5 followed by a long-offline `add_item(B)` at T7 ends with an entry for
       * B in one arrival order and for A in the other. Tombstoning only means
       * both orders end with the same orphan entry on a tombstoned vara: visible,
       * manually fixable, and above all identical on every device.
       *
       * Purchases, recipe ingredients and aliases are re-pointed by a bounded,
       * idempotent server-side effect — the same boundary purchases already sit
       * on, and for the same reason.
       *
       * `aliasNorm` is what keeps old recipe lines resolving: without it a line
       * reading "köttfärs" goes from a perfect match to nothing at all, since it
       * shares no prefix, compound head or whole word with "nötfärs".
       */
      kind: "merge_catalog_items";
      fromItemId: Id;
      toItemId: Id;
      /** The merged-away word, already normalized. */
      aliasNorm: string;
    });

export type OpKind = Op["kind"];

/** The list an op concerns, for routing it to the right SSE stream. */
export function opListId(op: Op): Id | null {
  switch (op.kind) {
    case "create_list":
    case "update_list":
    case "delete_list":
    case "add_item":
    case "remove_item":
    case "set_amount":
    case "set_note":
    case "set_modifier":
    case "set_priority":
    case "add_recipe":
    case "remove_recipe":
    case "repoint_recipe_item":
      return op.listId;
    // A move concerns TWO lists, and this function returns one id. Returning
    // `toListId` meant a device with the SOURCE list open never received the op
    // at all — src/api/routes/stream.ts filters on this value — so it went on
    // showing milk at Hemköp indefinitely after someone else moved it to
    // Bauhaus, until something happened to make it re-hydrate.
    //
    // Null means household-wide, which both the live filter and the catch-up
    // query (`opsCatchUpWhere`) already treat as "deliver to every list". It is
    // deliberately over-broad: a move is rare and the extra delivery is a few
    // bytes to at most a couple of devices, whereas widening the event to carry
    // two ids would change the event contract for this one case.
    case "move_item":
    // Catalog and registry changes are household-wide, not list-scoped. A vara,
    // a product and a barcode all belong to the household rather than to one
    // shop, so every list's stream must receive them.
    case "create_catalog_item":
    case "update_catalog_item":
    case "create_product":
    case "update_product":
    case "link_barcode":
    case "delete_catalog_item":
    case "merge_catalog_items":
      return null;
  }
}
