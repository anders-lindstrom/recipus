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
import { applyOp, applyOps, pruneTombstones } from "./reducer";

const LIST = "hemkop";
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
  it("moves an item between lists", () => {
    const state = applyOps(emptyState(), [
      { ...base("anders", 1), kind: "add_item", listId: LIST, catalogItemId: CREAM },
      {
        ...base("anders", 2),
        kind: "move_item",
        fromListId: LIST,
        toListId: "bauhaus",
        catalogItemId: CREAM,
      },
    ]);

    expect(state.entries[entryId(LIST, CREAM)].removedAt).not.toBeNull();
    expect(state.entries[entryId("bauhaus", CREAM)].removedAt).toBeNull();
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
});
