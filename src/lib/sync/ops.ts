import type { Amount, CatalogItem, Id, List, Priority } from "@/lib/domain";

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
    // Catalog changes are household-wide, not list-scoped.
    case "create_catalog_item":
    case "update_catalog_item":
      return null;
  }
}
