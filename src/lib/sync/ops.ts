import type { Amount, CatalogItem, Id, List } from "@/lib/domain";

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
  | (OpBase & { kind: "add_item"; listId: Id; catalogItemId: Id })
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
      kind: "move_item";
      fromListId: Id;
      toListId: Id;
      catalogItemId: Id;
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
    case "add_recipe":
    case "remove_recipe":
      return op.listId;
    case "move_item":
      return op.toListId;
    case "create_catalog_item":
    case "update_catalog_item":
      // Catalog changes are household-wide, not list-scoped.
      return null;
  }
}
