import { describe, expect, it } from "vitest";
import {
  emptyState,
  entryId,
  manualContributionId,
  recipeContributionId,
  type CatalogItem,
  type SyncState,
} from "@/lib/domain";
import type { Op } from "./ops";
import {
  applyOp,
  applyOps,
  contributionFieldKey,
  entryPriorityKey,
  pruneTombstones,
} from "./reducer";

const LIST = "hemkop";
/** The other shop, for move_item. A different aisle order, a different trip. */
const OTHER = "bauhaus";
const CREAM = "gradde";
const MILK = "mjolk";

function at(minutes: number): string {
  // Fixed clock. Never `new Date()` — a reducer test that depends on wall time
  // is a reducer test that fails at midnight.
  return new Date(Date.UTC(2026, 2, 12, 10, minutes, 0)).toISOString();
}

let opSeq = 0;
function base(actor: string, minute: number) {
  return { clientOpId: `op-${++opSeq}`, actor, at: at(minute) };
}

function item(id: string): CatalogItem {
  return {
    id,
    name: id,
    nameNorm: id,
    categoryId: "mejeri-agg",
    iconRef: "1F95B",
    isCustom: false,
    hasAtHome: false,
    useCount: 0,
    lastUsedAt: null,
  };
}

/**
 * Every distinct ordering of a small op set.
 *
 * Exhaustive beats a seeded shuffle here: with five or six ops the whole
 * permutation space is cheap, and "we tried every order" is a much stronger
 * statement than "we tried some orders".
 */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i], ...p]);
  }
  return out;
}

/** Compare only what a user can observe — meta is bookkeeping. */
function observable(state: SyncState) {
  return {
    lists: state.lists,
    catalog: state.catalog,
    entries: state.entries,
    contributions: state.contributions,
    recipeAdditions: state.recipeAdditions,
  };
}

describe("convergence", () => {
  it("reaches the same state under every ordering of interleaved ops", () => {
    // Two people, two shops, no signal. Their ops arrive in whatever order the
    // network manages. This is the property the whole design rests on.
    const ops: Op[] = [
      { ...base("anders", 0), kind: "create_catalog_item", item: item(CREAM) },
      { ...base("anders", 1), kind: "add_item", listId: LIST, catalogItemId: CREAM },
      {
        ...base("maria", 2),
        kind: "set_amount",
        listId: LIST,
        catalogItemId: CREAM,
        amount: { value: 5, unit: "dl" },
      },
      { ...base("anders", 3), kind: "add_item", listId: LIST, catalogItemId: MILK },
      {
        ...base("maria", 4),
        kind: "remove_item",
        listId: LIST,
        catalogItemId: MILK,
        bought: true,
      },
      {
        ...base("anders", 5),
        kind: "set_note",
        listId: LIST,
        catalogItemId: CREAM,
        note: "helst ekologisk",
      },
    ];

    const orderings = permutations(ops);
    expect(orderings.length).toBe(720);

    const reference = observable(applyOps(emptyState(), orderings[0]));
    for (const ordering of orderings) {
      expect(observable(applyOps(emptyState(), ordering))).toEqual(reference);
    }
  });

  it("converges on concurrent add versus remove", () => {
    const add: Op = {
      ...base("anders", 5),
      kind: "add_item",
      listId: LIST,
      catalogItemId: CREAM,
    };
    const remove: Op = {
      ...base("maria", 9),
      kind: "remove_item",
      listId: LIST,
      catalogItemId: CREAM,
      bought: true,
    };

    const a = applyOps(emptyState(), [add, remove]);
    const b = applyOps(emptyState(), [remove, add]);

    expect(observable(a)).toEqual(observable(b));
    // The later op is the removal, so the item is off the list either way.
    expect(a.entries[entryId(LIST, CREAM)].removedAt).not.toBeNull();
  });

  it("converges on two people setting different amounts at the same instant", () => {
    const mine: Op = {
      ...base("anders", 7),
      kind: "set_amount",
      listId: LIST,
      catalogItemId: CREAM,
      amount: { value: 2, unit: "dl" },
    };
    const theirs: Op = {
      ...base("maria", 7),
      kind: "set_amount",
      listId: LIST,
      catalogItemId: CREAM,
      amount: { value: 5, unit: "dl" },
    };

    const a = applyOps(emptyState(), [mine, theirs]);
    const b = applyOps(emptyState(), [theirs, mine]);
    expect(observable(a)).toEqual(observable(b));

    // Identical timestamps break on actor name — arbitrary, but the same
    // arbitrary choice on both phones, which is all that matters.
    const cid = manualContributionId(entryId(LIST, CREAM));
    expect(a.contributions[cid].amount).toEqual({ value: 5, unit: "dl" });
  });

  it("keeps the earliest creation regardless of arrival order", () => {
    // The bug that motivated earliestCreation(): a losing op returns early and
    // never lowers createdAt, so the two orders disagreed.
    const add: Op = {
      ...base("anders", 1),
      kind: "add_item",
      listId: LIST,
      catalogItemId: CREAM,
    };
    const viaRecipe: Op = {
      ...base("maria", 9),
      kind: "add_recipe",
      listId: LIST,
      recipeId: "r1",
      recipeAdditionId: "ra1",
      scaleFactor: 2,
      items: [{ catalogItemId: CREAM, amount: { value: 8, unit: "dl" } }],
    };

    const a = applyOps(emptyState(), [add, viaRecipe]);
    const b = applyOps(emptyState(), [viaRecipe, add]);

    expect(observable(a)).toEqual(observable(b));
    expect(a.entries[entryId(LIST, CREAM)].createdAt).toBe(at(1));
  });
});

describe("idempotency and immutability", () => {
  it("applying the same ops twice equals applying them once", () => {
    const ops: Op[] = [
      { ...base("anders", 0), kind: "create_catalog_item", item: item(CREAM) },
      { ...base("anders", 1), kind: "add_item", listId: LIST, catalogItemId: CREAM },
      {
        ...base("anders", 2),
        kind: "add_recipe",
        listId: LIST,
        recipeId: "r1",
        recipeAdditionId: "ra1",
        scaleFactor: 1,
        items: [{ catalogItemId: CREAM, amount: { value: 3, unit: "dl" } }],
      },
    ];

    const once = applyOps(emptyState(), ops);
    const twice = applyOps(once, ops);
    expect(observable(twice)).toEqual(observable(once));
  });

  it("never mutates the state it was given", () => {
    const before = emptyState();
    const snapshot = JSON.stringify(before);
    applyOp(before, {
      ...base("anders", 1),
      kind: "add_item",
      listId: LIST,
      catalogItemId: CREAM,
    });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("tombstones", () => {
  it("does not let a stale add resurrect something already bought", () => {
    // A phone that was offline in the shop finally syncs. Its add is older than
    // the removal, and milk must stay bought.
    const state = applyOps(emptyState(), [
      {
        ...base("maria", 9),
        kind: "remove_item",
        listId: LIST,
        catalogItemId: MILK,
        bought: true,
      },
      { ...base("anders", 2), kind: "add_item", listId: LIST, catalogItemId: MILK },
    ]);

    expect(state.entries[entryId(LIST, MILK)].removedAt).not.toBeNull();
  });

  it("lets a genuinely newer add put it back", () => {
    const state = applyOps(emptyState(), [
      {
        ...base("maria", 2),
        kind: "remove_item",
        listId: LIST,
        catalogItemId: MILK,
        bought: true,
      },
      { ...base("anders", 9), kind: "add_item", listId: LIST, catalogItemId: MILK },
    ]);

    expect(state.entries[entryId(LIST, MILK)].removedAt).toBeNull();
  });

  it("records a removal for an item it has never seen", () => {
    // The remove overtook the add. Without a tombstone the add would win later
    // and the item would reappear after you bought it.
    const state = applyOp(emptyState(), {
      ...base("maria", 5),
      kind: "remove_item",
      listId: LIST,
      catalogItemId: MILK,
      bought: true,
    });
    expect(state.entries[entryId(LIST, MILK)].removedAt).not.toBeNull();
  });
});

describe("recipes", () => {
  const addMuffins: Op = {
    ...base("anders", 1),
    kind: "add_recipe",
    listId: LIST,
    recipeId: "muffins",
    recipeAdditionId: "ra-muffins",
    scaleFactor: 2,
    items: [{ catalogItemId: CREAM, amount: { value: 8, unit: "dl" } }],
  };
  const addSauce: Op = {
    ...base("anders", 2),
    kind: "add_recipe",
    listId: LIST,
    recipeId: "sauce",
    recipeAdditionId: "ra-sauce",
    scaleFactor: 1,
    items: [{ catalogItemId: CREAM, amount: { value: 3, unit: "dl" } }],
  };

  it("stores the caller's already-scaled amount without multiplying again", () => {
    // Scaling twice is the 16 dl bug: the sheet says 8, the list says 16.
    const state = applyOp(emptyState(), addMuffins);
    const cid = recipeContributionId("ra-muffins", CREAM);
    expect(state.contributions[cid].amount).toEqual({ value: 8, unit: "dl" });
  });

  it("keeps two recipes' shares of one item separate", () => {
    const state = applyOps(emptyState(), [addMuffins, addSauce]);
    const forCream = Object.values(state.contributions).filter(
      (c) => c.entryId === entryId(LIST, CREAM),
    );
    expect(forCream).toHaveLength(2);
  });

  it("withdraws exactly one recipe's share and leaves the other", () => {
    const state = applyOps(emptyState(), [
      addMuffins,
      addSauce,
      {
        ...base("anders", 5),
        kind: "remove_recipe",
        listId: LIST,
        recipeAdditionId: "ra-muffins",
      },
    ]);

    expect(state.contributions[recipeContributionId("ra-muffins", CREAM)]).toBeUndefined();
    expect(state.contributions[recipeContributionId("ra-sauce", CREAM)]).toBeDefined();
    // The entry stays: the sauce still wants cream.
    expect(state.entries[entryId(LIST, CREAM)].removedAt).toBeNull();
  });

  it("leaves the entry in place even when the last contribution goes", () => {
    // "Bread, amount unspecified" is a valid entry, so removing the only
    // quantity must not silently remove the item too.
    const state = applyOps(emptyState(), [
      addMuffins,
      {
        ...base("anders", 5),
        kind: "remove_recipe",
        listId: LIST,
        recipeAdditionId: "ra-muffins",
      },
    ]);
    expect(state.entries[entryId(LIST, CREAM)].removedAt).toBeNull();
  });

  it("is idempotent when the same recipe addition replays", () => {
    const state = applyOps(emptyState(), [addMuffins, addMuffins]);
    expect(Object.keys(state.contributions)).toHaveLength(1);
  });
});

describe("lists and catalog", () => {
  const create: Op = {
    ...base("anders", 0),
    kind: "create_list",
    listId: "bauhaus",
    name: "Bauhaus",
    icon: "1F528",
    position: 1,
    categoryOrder: ["ovrigt"],
  };

  it("creates, renames and deletes a list", () => {
    let state = applyOp(emptyState(), create);
    expect(state.lists.bauhaus.name).toBe("Bauhaus");

    state = applyOp(state, {
      ...base("anders", 1),
      kind: "update_list",
      listId: "bauhaus",
      patch: { name: "Byggvaror" },
    });
    expect(state.lists.bauhaus.name).toBe("Byggvaror");

    state = applyOp(state, {
      ...base("anders", 2),
      kind: "delete_list",
      listId: "bauhaus",
    });
    expect(state.lists.bauhaus).toBeUndefined();
  });

  it("tombstones a deleted list's entries so they cannot orphan", () => {
    const state = applyOps(emptyState(), [
      create,
      { ...base("anders", 1), kind: "add_item", listId: "bauhaus", catalogItemId: "skruv" },
      { ...base("anders", 2), kind: "delete_list", listId: "bauhaus" },
    ]);
    expect(state.entries[entryId("bauhaus", "skruv")].removedAt).not.toBeNull();
  });

  it("ignores an update for a list it has never seen", () => {
    // Conjuring a half-built list from a patch would render a nameless tab.
    const state = applyOp(emptyState(), {
      ...base("anders", 1),
      kind: "update_list",
      listId: "ghost",
      patch: { name: "Nope" },
    });
    expect(state.lists.ghost).toBeUndefined();
  });

  it("accepts an add for a catalog item that has not arrived yet", () => {
    // Ops arrive out of order. Refusing here would make the final state depend
    // on arrival order, which is the one thing we cannot allow.
    const state = applyOp(emptyState(), {
      ...base("anders", 1),
      kind: "add_item",
      listId: LIST,
      catalogItemId: "unknown-item",
    });
    expect(state.entries[entryId(LIST, "unknown-item")]).toBeDefined();
  });

  it("patches a catalog item that already exists", () => {
    const state = applyOps(emptyState(), [
      { ...base("anders", 0), kind: "create_catalog_item", item: item(CREAM) },
      {
        ...base("anders", 1),
        kind: "update_catalog_item",
        itemId: CREAM,
        patch: { hasAtHome: true },
      },
    ]);
    expect(state.catalog[CREAM].hasAtHome).toBe(true);
    // Untouched fields survive the patch.
    expect(state.catalog[CREAM].categoryId).toBe("mejeri-agg");
  });

  it("ignores an update for a catalog item it has never seen", () => {
    // Same reasoning as the list case: there is nothing derivable to conjure a
    // whole item from (no name, no category), so the patch is dropped.
    const state = applyOp(emptyState(), {
      ...base("anders", 1),
      kind: "update_catalog_item",
      itemId: "unknown-item",
      patch: { hasAtHome: true },
    });
    expect(state.catalog["unknown-item"]).toBeUndefined();
  });
});

describe("amounts and notes", () => {
  it("setting an amount puts the item on the list", () => {
    // Typing "mjölk 2 l" must not record a quantity for something invisible.
    const state = applyOp(emptyState(), {
      ...base("anders", 1),
      kind: "set_amount",
      listId: LIST,
      catalogItemId: MILK,
      amount: { value: 2, unit: "l" },
    });
    expect(state.entries[entryId(LIST, MILK)].removedAt).toBeNull();
  });

  it("clearing the amount keeps a note that is still there", () => {
    const state = applyOps(emptyState(), [
      {
        ...base("anders", 1),
        kind: "set_note",
        listId: LIST,
        catalogItemId: MILK,
        note: "laktosfri",
      },
      {
        ...base("anders", 2),
        kind: "set_amount",
        listId: LIST,
        catalogItemId: MILK,
        amount: null,
      },
    ]);
    const cid = manualContributionId(entryId(LIST, MILK));
    expect(state.contributions[cid].amount).toBeNull();
    expect(state.contributions[cid].note).toBe("laktosfri");
  });

  it("drops the record only when both the amount and the note are gone", () => {
    const state = applyOps(emptyState(), [
      {
        ...base("anders", 1),
        kind: "set_note",
        listId: LIST,
        catalogItemId: MILK,
        note: "laktosfri",
      },
      {
        ...base("anders", 2),
        kind: "set_note",
        listId: LIST,
        catalogItemId: MILK,
        note: null,
      },
    ]);
    const cid = manualContributionId(entryId(LIST, MILK));
    expect(state.contributions[cid]).toBeUndefined();
    // The item itself is still wanted — just without any qualifier.
    expect(state.entries[entryId(LIST, MILK)].removedAt).toBeNull();
  });

  it("keeps the note when only the amount changes", () => {
    const state = applyOps(emptyState(), [
      {
        ...base("anders", 1),
        kind: "set_note",
        listId: LIST,
        catalogItemId: MILK,
        note: "laktosfri",
      },
      {
        ...base("anders", 2),
        kind: "set_amount",
        listId: LIST,
        catalogItemId: MILK,
        amount: { value: 2, unit: "l" },
      },
    ]);
    const cid = manualContributionId(entryId(LIST, MILK));
    expect(state.contributions[cid].note).toBe("laktosfri");
    expect(state.contributions[cid].amount).toEqual({ value: 2, unit: "l" });
  });
});

describe("move_item", () => {
  /**
   * The move carries what it moves.
   *
   * `move_item` is the only op that would otherwise have to READ the state it
   * rewrites — "take whatever is on the source and put it over there" — and a
   * read-modify-write cannot be order-independent. A `set_amount` the mover had
   * not seen yet is present in one arrival order and absent in the other, so the
   * two devices settle on different amounts at the destination and neither is
   * wrong by its own reckoning. Putting the payload IN the op makes the reducer a
   * pure function of the op set again, which is the property everything here
   * rests on. The permutation test at the bottom of this block is what proves it.
   */
  function moveOp(
    actor: string,
    minute: number,
    carried: {
      priority?: "urgent" | "normal" | "convenient";
      manual?: Extract<Op, { kind: "move_item" }>["manual"];
    } = {},
  ): Op {
    return {
      ...base(actor, minute),
      kind: "move_item",
      fromListId: LIST,
      toListId: OTHER,
      catalogItemId: CREAM,
      priority: carried.priority ?? "normal",
      manual: carried.manual ?? null,
    };
  }

  const FULL = {
    priority: "urgent" as const,
    manual: {
      amount: { value: 5, unit: "dl" as const },
      note: "helst ekologisk",
      modifier: "vispgrädde",
    },
  };

  it("moves an item between lists", () => {
    const state = applyOps(emptyState(), [
      { ...base("anders", 1), kind: "add_item", listId: LIST, catalogItemId: CREAM },
      moveOp("anders", 2),
    ]);

    expect(state.entries[entryId(LIST, CREAM)].removedAt).not.toBeNull();
    expect(state.entries[entryId(OTHER, CREAM)].removedAt).toBeNull();
  });

  it("carries the amount, note, modifier and priority to the destination", () => {
    const state = applyOps(emptyState(), [
      { ...base("anders", 1), kind: "add_item", listId: LIST, catalogItemId: CREAM },
      moveOp("anders", 5, FULL),
    ]);

    expect(state.entries[entryId(OTHER, CREAM)].priority).toBe("urgent");
    expect(state.contributions[manualContributionId(entryId(OTHER, CREAM))]).toEqual({
      id: manualContributionId(entryId(OTHER, CREAM)),
      entryId: entryId(OTHER, CREAM),
      sourceKind: "manual",
      recipeAdditionId: null,
      amount: { value: 5, unit: "dl" },
      note: "helst ekologisk",
      modifier: "vispgrädde",
    });
  });

  /**
   * A move relocates; it does not copy. Leaving the qualifier behind would mean
   * the item is at Bauhaus and the "helst ekologisk" is still at Hemköp, waiting
   * to reappear the moment anyone puts cream back on the first list.
   */
  it("takes the manual contribution and the urgency off the source", () => {
    // Built with real ops rather than asserted against an empty source: an
    // implementation that never touches the source passes vacuously otherwise,
    // which is exactly the defect this test exists to catch.
    const state = applyOps(emptyState(), [
      {
        ...base("anders", 1),
        kind: "set_amount",
        listId: LIST,
        catalogItemId: CREAM,
        amount: { value: 5, unit: "dl" },
      },
      {
        ...base("anders", 2),
        kind: "set_note",
        listId: LIST,
        catalogItemId: CREAM,
        note: "helst ekologisk",
      },
      {
        ...base("anders", 3),
        kind: "set_modifier",
        listId: LIST,
        catalogItemId: CREAM,
        modifier: "vispgrädde",
      },
      {
        ...base("anders", 4),
        kind: "set_priority",
        listId: LIST,
        catalogItemId: CREAM,
        priority: "urgent",
      },
      moveOp("anders", 5, FULL),
    ]);

    const source = state.entries[entryId(LIST, CREAM)];
    expect(source.removedAt).not.toBeNull();
    // The urgency travelled with the item; it did not stay behind to reappear
    // the next time anyone puts cream back on this list.
    expect(source.priority).toBe("normal");
    expect(
      state.contributions[manualContributionId(entryId(LIST, CREAM))],
    ).toBeUndefined();
    // And it really did arrive at the other end, from the source's own values.
    expect(
      state.contributions[manualContributionId(entryId(OTHER, CREAM))].note,
    ).toBe("helst ekologisk");
  });

  /**
   * The values move with their clocks, or the move is a data-loss bug waiting for
   * the next op.
   *
   * A written value whose clock is absent is not "no opinion", it is "anything
   * wins" — `wins(op, undefined)` is true whatever the op's timestamp says. So a
   * destination amount with no clock loses to the first stale `set_amount` that
   * turns up, and the source's surviving clocks would let a stale write refill
   * the record the move just emptied.
   */
  it("stamps both ends' clocks, so neither is open to a stale write", () => {
    const state = applyOps(emptyState(), [
      { ...base("anders", 1), kind: "add_item", listId: LIST, catalogItemId: CREAM },
      moveOp("anders", 5, FULL),
    ]);

    const stamp = { at: at(5), by: "anders" };
    for (const field of ["amount", "note", "modifier"] as const) {
      expect(
        state.meta[
          contributionFieldKey(manualContributionId(entryId(OTHER, CREAM)), field)
        ],
      ).toEqual(stamp);
      expect(
        state.meta[
          contributionFieldKey(manualContributionId(entryId(LIST, CREAM)), field)
        ],
      ).toEqual(stamp);
    }
    expect(state.meta[entryPriorityKey(entryId(OTHER, CREAM))]).toEqual(stamp);
  });

  it("loses the carried amount to a genuinely newer write on the destination", () => {
    const state = applyOps(emptyState(), [
      moveOp("anders", 5, FULL),
      {
        ...base("maria", 9),
        kind: "set_amount",
        listId: OTHER,
        catalogItemId: CREAM,
        amount: { value: 1, unit: "l" },
      },
    ]);
    const cid = manualContributionId(entryId(OTHER, CREAM));
    expect(state.contributions[cid].amount).toEqual({ value: 1, unit: "l" });
    // Only the amount lost. The note and the modifier were nobody else's claim.
    expect(state.contributions[cid].note).toBe("helst ekologisk");
  });

  it("beats a write on the destination that predates it", () => {
    const state = applyOps(emptyState(), [
      {
        ...base("maria", 2),
        kind: "set_amount",
        listId: OTHER,
        catalogItemId: CREAM,
        amount: { value: 1, unit: "l" },
      },
      moveOp("anders", 5, FULL),
    ]);
    expect(
      state.contributions[manualContributionId(entryId(OTHER, CREAM))].amount,
    ).toEqual({ value: 5, unit: "dl" });
  });

  /**
   * A recipe's share stays on the list the recipe was added to.
   *
   * Recipe additions are list-scoped (`recipe_additions.list_id`), so a recipe
   * that asked for cream at Hemköp has no meaning at Bauhaus — dragging its
   * contribution across would make one recipe appear on two lists. Moving an item
   * is a statement about where you will buy it, not about the recipe. The manual
   * contribution is different: its id is a pure function of the entry, and the
   * ask is the person's own.
   */
  it("leaves a recipe's share on the list the recipe was added to", () => {
    const state = applyOps(emptyState(), [
      {
        ...base("anders", 1),
        kind: "add_recipe",
        listId: LIST,
        recipeId: "r1",
        recipeAdditionId: "ra1",
        scaleFactor: 1,
        items: [{ catalogItemId: CREAM, amount: { value: 8, unit: "dl" } }],
      },
      moveOp("anders", 5),
    ]);

    const share = state.contributions[recipeContributionId("ra1", CREAM)];
    expect(share.entryId).toBe(entryId(LIST, CREAM));
    expect(share.amount).toEqual({ value: 8, unit: "dl" });
    expect(
      state.contributions[manualContributionId(entryId(OTHER, CREAM))],
    ).toBeUndefined();
  });

  /**
   * The test that has caught every real bug in this codebase, pointed at the op
   * that re-treads all of their ground at once: two entries, two priority clocks,
   * three manual field clocks, and edits landing on both lists.
   */
  const interleaved: Op[] = [
    { ...base("anders", 1), kind: "add_item", listId: LIST, catalogItemId: CREAM },
    {
      ...base("maria", 2),
      kind: "set_amount",
      listId: LIST,
      catalogItemId: CREAM,
      amount: { value: 5, unit: "dl" },
    },
    {
      ...base("anders", 3),
      kind: "set_amount",
      listId: OTHER,
      catalogItemId: CREAM,
      amount: { value: 1, unit: "l" },
    },
    moveOp("anders", 4, {
      priority: "urgent",
      manual: { amount: { value: 2, unit: "dl" }, note: "till såsen", modifier: null },
    }),
    {
      ...base("maria", 6),
      kind: "set_priority",
      listId: OTHER,
      catalogItemId: CREAM,
      priority: "convenient",
    },
  ];

  it("converges under every ordering of a move and edits on both lists", () => {
    const orderings = permutations(interleaved);
    expect(orderings.length).toBe(120);

    const reference = observable(applyOps(emptyState(), orderings[0]));
    for (const ordering of orderings) {
      expect(observable(applyOps(emptyState(), ordering))).toEqual(reference);
    }
  });

  it("converges on the bookkeeping too, and on one further op after it", () => {
    // What the user sees agreeing is not enough: `meta` is what the NEXT op
    // resolves against, so a clock that ended up different diverges one write
    // later, long after the ordering that caused it is forgotten.
    const probe: Op = {
      ...base("maria", 9),
      kind: "set_amount",
      listId: OTHER,
      catalogItemId: CREAM,
      amount: { value: 3, unit: "dl" },
    };

    const orderings = permutations(interleaved);
    const first = applyOps(emptyState(), orderings[0]);
    const referenceMeta = first.meta;
    const referenceProbed = observable(applyOp(first, probe));

    for (const ordering of orderings) {
      const state = applyOps(emptyState(), ordering);
      expect(state.meta).toEqual(referenceMeta);
      expect(observable(applyOp(state, probe))).toEqual(referenceProbed);
    }
  });
});

describe("pruneTombstones", () => {
  it("drops old tombstones and keeps live entries", () => {
    const state = applyOps(emptyState(), [
      { ...base("anders", 1), kind: "add_item", listId: LIST, catalogItemId: CREAM },
      {
        ...base("anders", 2),
        kind: "remove_item",
        listId: LIST,
        catalogItemId: MILK,
        bought: true,
      },
    ]);

    const pruned = pruneTombstones(state, new Date(at(30)));
    expect(pruned.entries[entryId(LIST, CREAM)]).toBeDefined();
    expect(pruned.entries[entryId(LIST, MILK)]).toBeUndefined();
  });

  it("keeps a tombstone that is still inside the retention window", () => {
    const state = applyOp(emptyState(), {
      ...base("anders", 20),
      kind: "remove_item",
      listId: LIST,
      catalogItemId: MILK,
      bought: true,
    });

    const pruned = pruneTombstones(state, new Date(at(10)));
    expect(pruned.entries[entryId(LIST, MILK)]).toBeDefined();
  });

  it("forgets the meta row for a pruned entry too", () => {
    // Otherwise the meta map — the one thing this function exists to bound —
    // grows forever even after the entry it describes is gone.
    const state = applyOp(emptyState(), {
      ...base("anders", 1),
      kind: "remove_item",
      listId: LIST,
      catalogItemId: MILK,
      bought: true,
    });
    expect(Object.keys(state.meta).length).toBeGreaterThan(0);

    const pruned = pruneTombstones(state, new Date(at(30)));
    expect(Object.keys(pruned.meta)).toHaveLength(0);
  });

  /**
   * Per-field clocks have to go with their record.
   *
   * They carry no `deleted` flag of their own — a cleared amount is a value, not
   * a tombstone — so the ordinary "keep unless deleted and old" rule kept them
   * forever. Every clock this codebase has added since (amount, note, modifier,
   * priority, and four on the catalog) would have leaked the same way, and the
   * meta map is re-serialised on every tap.
   */
  it("forgets per-field clocks along with the record they describe", () => {
    const state = applyOps(emptyState(), [
      {
        ...base("anders", 1),
        kind: "set_amount",
        listId: LIST,
        catalogItemId: MILK,
        amount: { value: 2, unit: "l" },
      },
      {
        ...base("anders", 2),
        kind: "set_modifier",
        listId: LIST,
        catalogItemId: MILK,
        modifier: "laktosfri",
      },
      {
        ...base("anders", 3),
        kind: "set_priority",
        listId: LIST,
        catalogItemId: MILK,
        priority: "urgent",
      },
      {
        ...base("anders", 4),
        kind: "remove_item",
        listId: LIST,
        catalogItemId: MILK,
        bought: true,
      },
    ]);
    expect(
      Object.keys(state.meta).some((k) => k.endsWith(":modifier")),
    ).toBe(true);

    const pruned = pruneTombstones(state, new Date(at(30)));
    expect(Object.keys(pruned.meta)).toHaveLength(0);
  });

  /**
   * A live record's own clock survives even when its id ends in a field name.
   *
   * Ids contain colons (`entryId` is `listId:catalogItemId`), so a custom item
   * slugged "priority" makes `entry:hemkop:priority` look exactly like a field
   * key. Pruning it would drop a live entry's clock — and a missing clock is
   * "anything wins", which is a resurrection bug.
   */
  it("does not mistake an item named like a field for a field clock", () => {
    const state = applyOp(emptyState(), {
      ...base("anders", 1),
      kind: "add_item",
      listId: LIST,
      catalogItemId: "priority",
    });

    const pruned = pruneTombstones(state, new Date(at(30)));
    expect(pruned.meta[`entry:${entryId(LIST, "priority")}`]).toBeDefined();
  });
});

describe("forward compatibility", () => {
  /**
   * A phone that has not been updated receiving an op from one that has.
   *
   * This is not hypothetical politeness: before the `default` branch existed the
   * switch fell through and returned `undefined`, `applyOps` threw on the next
   * op, and the client store wrote `undefined` over its cached state and retried
   * forever — the app opened to an empty list in a shop and blamed the network.
   * Every future op kind depends on this behaviour already being deployed, which
   * is why it is tested rather than assumed.
   */
  /**
   * A kind this build genuinely does not have.
   *
   * It used to be `set_priority`, which has since shipped — so this test quietly
   * stopped testing forward compatibility and started testing priority. Worth
   * knowing when picking the next placeholder: anything on the roadmap will do
   * this again. `set_colour` is not, and will not be, a thing.
   */
  const fromTheFuture = {
    ...base("maria", 3),
    kind: "set_colour",
    listId: LIST,
    catalogItemId: CREAM,
    colour: "ochre",
  } as unknown as Op;

  it("ignores an op kind it does not know, leaving state untouched", () => {
    const before = applyOp(emptyState(), {
      ...base("anders", 1),
      kind: "add_item",
      listId: LIST,
      catalogItemId: CREAM,
    });

    const after = applyOp(before, fromTheFuture);
    expect(after).toBe(before);
  });

  it("keeps applying the rest of a batch around an unknown op", () => {
    // The batch matters more than the single op: an unknown kind in the middle
    // must not take the known ops on either side of it down with it.
    const state = applyOps(emptyState(), [
      { ...base("anders", 1), kind: "add_item", listId: LIST, catalogItemId: CREAM },
      fromTheFuture,
      { ...base("anders", 4), kind: "add_item", listId: LIST, catalogItemId: MILK },
    ]);

    expect(state).toBeDefined();
    expect(state.entries[entryId(LIST, CREAM)]?.removedAt).toBeNull();
    expect(state.entries[entryId(LIST, MILK)]?.removedAt).toBeNull();
  });
});

describe("meta convergence", () => {
  /**
   * The existing convergence test compares `observable()`, which deliberately
   * excludes `meta`. That proves what the user sees agrees — but `meta` is what
   * the NEXT op resolves against, so two clients can display an identical list
   * and then diverge on the following write. This closes that gap in both
   * directions: the bookkeeping itself must converge, and convergence must
   * survive one more op landing afterwards.
   */
  const ops: Op[] = [
    { ...base("anders", 0), kind: "create_catalog_item", item: item(CREAM) },
    { ...base("anders", 1), kind: "add_item", listId: LIST, catalogItemId: CREAM },
    {
      ...base("maria", 2),
      kind: "set_amount",
      listId: LIST,
      catalogItemId: CREAM,
      amount: { value: 5, unit: "dl" },
    },
    {
      ...base("anders", 3),
      kind: "set_note",
      listId: LIST,
      catalogItemId: CREAM,
      note: "helst ekologisk",
    },
    {
      ...base("maria", 4),
      kind: "remove_item",
      listId: LIST,
      catalogItemId: CREAM,
      bought: true,
    },
  ];

  it("converges on the meta map under every ordering", () => {
    const orderings = permutations(ops);
    expect(orderings.length).toBe(120);

    const reference = applyOps(emptyState(), orderings[0]).meta;
    for (const ordering of orderings) {
      expect(applyOps(emptyState(), ordering).meta).toEqual(reference);
    }
  });

  it("still converges after one further op, whatever order preceded it", () => {
    // The probe is what catches divergence hiding in the bookkeeping: a clock
    // that ended up different resolves this next write differently.
    const probe: Op = {
      ...base("anders", 9),
      kind: "set_amount",
      listId: LIST,
      catalogItemId: CREAM,
      amount: { value: 2, unit: "dl" },
    };

    const orderings = permutations(ops);
    const reference = observable(
      applyOp(applyOps(emptyState(), orderings[0]), probe),
    );
    for (const ordering of orderings) {
      const probed = applyOp(applyOps(emptyState(), ordering), probe);
      expect(observable(probed)).toEqual(reference);
    }
  });
});

describe("priority", () => {
  const add: Op = {
    ...base("anders", 1),
    kind: "add_item",
    listId: LIST,
    catalogItemId: CREAM,
  };

  it("defaults to normal", () => {
    const state = applyOp(emptyState(), add);
    expect(state.entries[entryId(LIST, CREAM)].priority).toBe("normal");
  });

  /**
   * The `writeEntry` fresh-literal hazard.
   *
   * Every entry write rebuilds the record from scratch, so anything not carried
   * forward explicitly is silently reset. `add_item` is dispatched by far more
   * paths than anyone keeps in their head — the add bar, a scan, a suggestion,
   * undo, `set_amount`, `set_note` — and each of them would quietly clear the
   * urgency of an item already on the list.
   */
  it("survives a later add_item", () => {
    const state = applyOps(emptyState(), [
      add,
      {
        ...base("maria", 2),
        kind: "set_priority",
        listId: LIST,
        catalogItemId: CREAM,
        priority: "urgent",
      },
      { ...base("anders", 3), kind: "add_item", listId: LIST, catalogItemId: CREAM },
      {
        ...base("anders", 4),
        kind: "set_amount",
        listId: LIST,
        catalogItemId: CREAM,
        amount: { value: 2, unit: "dl" },
      },
    ]);
    expect(state.entries[entryId(LIST, CREAM)].priority).toBe("urgent");
  });

  /**
   * Removal clears it, which is what keeps urgency meaning anything. Without the
   * clear, buying the urgent milk and re-adding it next week leaves it ochre and
   * first — and once a third of the list is urgent, nothing is.
   */
  it("is cleared by removal, and stays cleared through a re-add", () => {
    const state = applyOps(emptyState(), [
      add,
      {
        ...base("maria", 2),
        kind: "set_priority",
        listId: LIST,
        catalogItemId: CREAM,
        priority: "urgent",
      },
      {
        ...base("anders", 3),
        kind: "remove_item",
        listId: LIST,
        catalogItemId: CREAM,
        bought: true,
      },
      { ...base("anders", 9), kind: "add_item", listId: LIST, catalogItemId: CREAM },
    ]);
    const entry = state.entries[entryId(LIST, CREAM)];
    expect(entry.removedAt).toBeNull();
    expect(entry.priority).toBe("normal");
  });

  /**
   * A genuinely newer "mark urgent" must survive an older removal arriving late.
   *
   * This is why priority has its own clock rather than riding the entry's: with
   * one clock, whichever op the network delivered second would win outright, and
   * the two devices would settle on different lists.
   */
  it("converges when a removal and a newer priority cross", () => {
    const remove: Op = {
      ...base("anders", 5),
      kind: "remove_item",
      listId: LIST,
      catalogItemId: CREAM,
      bought: true,
    };
    const urgent: Op = {
      ...base("maria", 9),
      kind: "set_priority",
      listId: LIST,
      catalogItemId: CREAM,
      priority: "urgent",
    };

    const a = applyOps(emptyState(), [add, remove, urgent]);
    const b = applyOps(emptyState(), [add, urgent, remove]);
    expect(observable(a)).toEqual(observable(b));
    expect(a.entries[entryId(LIST, CREAM)].priority).toBe("urgent");
  });

  it("converges under every ordering of priority, add and remove", () => {
    const ops: Op[] = [
      add,
      {
        ...base("maria", 4),
        kind: "set_priority",
        listId: LIST,
        catalogItemId: CREAM,
        priority: "convenient",
      },
      {
        ...base("anders", 6),
        kind: "remove_item",
        listId: LIST,
        catalogItemId: CREAM,
        bought: true,
      },
      { ...base("maria", 8), kind: "add_item", listId: LIST, catalogItemId: CREAM },
    ];

    const orderings = permutations(ops);
    const reference = observable(applyOps(emptyState(), orderings[0]));
    for (const ordering of orderings) {
      expect(observable(applyOps(emptyState(), ordering))).toEqual(reference);
    }
  });
});

describe("modifiers", () => {
  /**
   * A third independent fact on one record needs a third independent clock.
   *
   * Folding the modifier onto `set_amount` would reproduce the data-loss bug
   * this codebase has already paid for twice: an older write to one field
   * arriving after a newer write to another takes the first field's value with
   * it.
   */
  it("does not lose an amount to a later modifier, in either order", () => {
    const amount: Op = {
      ...base("anders", 5),
      kind: "set_amount",
      listId: LIST,
      catalogItemId: CREAM,
      amount: { value: 2, unit: "dl" },
    };
    const modifier: Op = {
      ...base("maria", 3),
      kind: "set_modifier",
      listId: LIST,
      catalogItemId: CREAM,
      modifier: "vispbar",
    };

    const a = applyOps(emptyState(), [amount, modifier]);
    const b = applyOps(emptyState(), [modifier, amount]);
    expect(observable(a)).toEqual(observable(b));

    const cid = manualContributionId(entryId(LIST, CREAM));
    expect(a.contributions[cid].amount).toEqual({ value: 2, unit: "dl" });
    expect(a.contributions[cid].modifier).toBe("vispbar");
  });

  it("drops the contribution only when all three fields are empty", () => {
    const cid = manualContributionId(entryId(LIST, CREAM));

    const withBoth = applyOps(emptyState(), [
      {
        ...base("anders", 1),
        kind: "set_amount",
        listId: LIST,
        catalogItemId: CREAM,
        amount: { value: 2, unit: "dl" },
      },
      {
        ...base("anders", 2),
        kind: "set_modifier",
        listId: LIST,
        catalogItemId: CREAM,
        modifier: "vispbar",
      },
    ]);

    // Clearing the amount leaves the modifier, so the record stays.
    const amountCleared = applyOp(withBoth, {
      ...base("anders", 3),
      kind: "set_amount",
      listId: LIST,
      catalogItemId: CREAM,
      amount: null,
    });
    expect(amountCleared.contributions[cid]).toBeDefined();
    expect(amountCleared.contributions[cid].modifier).toBe("vispbar");

    const allCleared = applyOp(amountCleared, {
      ...base("anders", 4),
      kind: "set_modifier",
      listId: LIST,
      catalogItemId: CREAM,
      modifier: null,
    });
    expect(allCleared.contributions[cid]).toBeUndefined();
    // The entry stays — "grädde, mängd ospecificerad" is a thing you want.
    expect(allCleared.entries[entryId(LIST, CREAM)].removedAt).toBeNull();
  });

  it("converges under every ordering of the three manual fields", () => {
    const ops: Op[] = [
      { ...base("anders", 1), kind: "add_item", listId: LIST, catalogItemId: CREAM },
      {
        ...base("maria", 5),
        kind: "set_amount",
        listId: LIST,
        catalogItemId: CREAM,
        amount: { value: 2, unit: "dl" },
      },
      {
        ...base("anders", 3),
        kind: "set_note",
        listId: LIST,
        catalogItemId: CREAM,
        note: "helst ekologisk",
      },
      {
        ...base("maria", 4),
        kind: "set_modifier",
        listId: LIST,
        catalogItemId: CREAM,
        modifier: "vispbar",
      },
    ];

    const orderings = permutations(ops);
    const reference = applyOps(emptyState(), orderings[0]);
    for (const ordering of orderings) {
      const state = applyOps(emptyState(), ordering);
      expect(observable(state)).toEqual(observable(reference));
      expect(state.meta).toEqual(reference.meta);
    }
  });
});

describe("catalog field clocks", () => {
  /**
   * Editing different facts about one item must converge.
   *
   * With a single clock for the whole row, a rename at T5 and a re-filing at T2
   * settle differently depending on which the server sees first: T2-then-T5
   * keeps both, T5-then-T2 drops the re-filing and the item silently walks back
   * to its old aisle. Same ops, two states.
   *
   * This is the shape the item registry makes routine — two people tidying the
   * catalog on a Sunday afternoon — so it is pinned exhaustively rather than by
   * example, the same way the amount/note split is.
   */
  const create: Op = {
    ...base("anders", 0),
    kind: "create_catalog_item",
    item: item(CREAM),
  };

  /**
   * The create is a fixture rather than part of the permutation, and that is a
   * deliberate statement about what converges.
   *
   * `update_catalog_item` DROPS an update for an item it has never seen, exactly
   * as `update_list` does — conjuring a partial record from a patch would leave
   * a half-built item with no name. So create-then-update and update-then-create
   * genuinely differ, and the guarantee rests on the transport instead: the
   * server assigns `seq` on arrival, clients replay in `seq` order, and an
   * update can only be authored on a device that already has the item. The
   * create is always first. Pinned by the last test in this block so the
   * assumption is written down rather than assumed.
   */
  const edits: Op[] = [
    {
      ...base("maria", 5),
      kind: "update_catalog_item",
      itemId: CREAM,
      patch: { name: "vispgrädde", nameNorm: "vispgradde" },
    },
    {
      ...base("anders", 2),
      kind: "update_catalog_item",
      itemId: CREAM,
      patch: { categoryId: "frukt-gront" },
    },
    {
      ...base("maria", 3),
      kind: "update_catalog_item",
      itemId: CREAM,
      patch: { iconRef: "1F34E" },
    },
    {
      ...base("anders", 4),
      kind: "update_catalog_item",
      itemId: CREAM,
      patch: { hasAtHome: true },
    },
  ];

  it("converges under every ordering of concurrent field edits", () => {
    const orderings = permutations(edits);
    expect(orderings.length).toBe(24);

    const reference = observable(applyOps(emptyState(), [create, ...orderings[0]]));
    for (const ordering of orderings) {
      expect(observable(applyOps(emptyState(), [create, ...ordering]))).toEqual(
        reference,
      );
    }
  });

  it("converges on the meta map too, so the next write resolves the same", () => {
    const orderings = permutations(edits);
    const reference = applyOps(emptyState(), [create, ...orderings[0]]).meta;
    for (const ordering of orderings) {
      expect(applyOps(emptyState(), [create, ...ordering]).meta).toEqual(reference);
    }
  });

  it("keeps every edit — none of them shadow each other", () => {
    const state = applyOps(emptyState(), [create, ...edits]);
    const cream = state.catalog[CREAM];
    expect(cream.name).toBe("vispgrädde");
    expect(cream.nameNorm).toBe("vispgradde");
    expect(cream.categoryId).toBe("frukt-gront");
    expect(cream.iconRef).toBe("1F34E");
    expect(cream.hasAtHome).toBe(true);
  });

  /**
   * An op that is silent about a field must not stamp that field's clock.
   *
   * Otherwise a rename would beat a LATER re-filing, purely because it happened
   * to be written second — the clock would be recording "someone touched this
   * row" rather than "someone set this field", which is the moving clock the
   * split exists to remove.
   */
  it("does not let a rename shadow a later re-filing", () => {
    const state = applyOps(emptyState(), [
      { ...base("anders", 0), kind: "create_catalog_item", item: item(CREAM) },
      {
        ...base("maria", 9),
        kind: "update_catalog_item",
        itemId: CREAM,
        patch: { name: "vispgrädde" },
      },
      {
        ...base("anders", 5),
        kind: "update_catalog_item",
        itemId: CREAM,
        patch: { categoryId: "frukt-gront" },
      },
    ]);
    expect(state.catalog[CREAM].name).toBe("vispgrädde");
    expect(state.catalog[CREAM].categoryId).toBe("frukt-gront");
  });

  /**
   * The counters are not household opinions.
   *
   * `useCount` and `lastUsedAt` are derived from purchase history by the server
   * with an atomic increment. A client asserting an absolute value would clobber
   * a concurrent one — a lost update, which last-write-wins cannot help with —
   * so a patch naming them is ignored rather than resolved.
   */
  it("ignores the derived counters in a patch", () => {
    const state = applyOps(emptyState(), [
      { ...base("anders", 0), kind: "create_catalog_item", item: item(CREAM) },
      {
        ...base("maria", 9),
        kind: "update_catalog_item",
        itemId: CREAM,
        patch: { useCount: 999, lastUsedAt: "2030-01-01T00:00:00.000Z" },
      },
    ]);
    expect(state.catalog[CREAM].useCount).toBe(0);
    expect(state.catalog[CREAM].lastUsedAt).toBeNull();
  });

  /**
   * The one ordering that does NOT converge, written down on purpose.
   *
   * An update for an item the reducer has never seen is dropped rather than used
   * to conjure a partial record — the same call `update_list` makes, for the
   * same reason. So this pair genuinely settles two ways, and the guarantee is
   * carried by the transport rather than by the reducer: `seq` is assigned on
   * arrival, replay follows `seq`, and an update can only be authored on a
   * device that already holds the item.
   *
   * Asserted rather than left implicit so that anyone who later makes an update
   * reachable without a create — a registry import, a merge, a repair path —
   * fails here and has to think about it, instead of shipping a silent
   * divergence.
   */
  it("drops an update that arrives before its create (known, transport-guarded)", () => {
    const rename: Op = {
      ...base("maria", 5),
      kind: "update_catalog_item",
      itemId: CREAM,
      patch: { name: "vispgrädde" },
    };

    const natural = applyOps(emptyState(), [create, rename]);
    const inverted = applyOps(emptyState(), [rename, create]);

    expect(natural.catalog[CREAM].name).toBe("vispgrädde");
    // Not a bug being enshrined — a boundary being stated. The rename is gone.
    expect(inverted.catalog[CREAM].name).toBe(CREAM);
  });
});
