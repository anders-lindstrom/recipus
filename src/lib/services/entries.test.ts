import { describe, expect, it } from "vitest";
import { groupingFor } from "@/lib/client/use-list-layout";
import {
  entryId,
  manualContributionId,
  recipeContributionId,
  type CatalogItem,
  type Contribution,
  type ListEntry,
  type Unit,
} from "@/lib/domain";
import {
  activeEntries,
  buildEntryView,
  itemsOnlyWantedByRecipe,
  groupByCategory,
  moveCategory,
  orderedCategories,
  shouldGroupByAisle,
  tileVaror,
  walkingRank,
} from "./entries";

const LIST = "hemkop";
const CREAM = "gradde";

function makeEntry(overrides: Partial<ListEntry> = {}): ListEntry {
  return {
    id: entryId(LIST, CREAM),
    listId: LIST,
    catalogItemId: CREAM,
    createdAt: "2026-03-12T10:00:00.000Z",
    createdBy: "anders",
    removedAt: null,
    priority: "normal",
    updatedAt: "2026-03-12T10:00:00.000Z",
    updatedBy: "anders",
    ...overrides,
  };
}

function recipeContribution(
  additionId: string,
  value: number,
  unit: Unit,
): Contribution {
  return {
    id: recipeContributionId(additionId, CREAM),
    entryId: entryId(LIST, CREAM),
    sourceKind: "recipe",
    recipeAdditionId: additionId,
    amount: { value, unit },
    note: null,
    modifier: null,
  };
}

describe("buildEntryView", () => {
  it("merges two recipes into one honest total", () => {
    // The failure this whole module exists to prevent: needing 11 dl and
    // buying 4 because the tile only showed one recipe's share.
    const view = buildEntryView(
      makeEntry(),
      [
        recipeContribution("add-muffins", 8, "dl"),
        recipeContribution("add-sauce", 3, "dl"),
      ],
      {
        "add-muffins": { recipeTitle: "Blåbärsmuffins", scaleFactor: 2 },
        "add-sauce": { recipeTitle: "Pastasås", scaleFactor: 1 },
      },
    );

    expect(view.totalLabel).toBe("11 dl");
    expect(view.hasRecipeSource).toBe(true);
    expect(view.contributions).toHaveLength(2);
  });

  it("exposes the scale factor only when the recipe was actually scaled", () => {
    const view = buildEntryView(
      makeEntry(),
      [
        recipeContribution("add-muffins", 8, "dl"),
        recipeContribution("add-sauce", 3, "dl"),
      ],
      {
        "add-muffins": { recipeTitle: "Blåbärsmuffins", scaleFactor: 2 },
        "add-sauce": { recipeTitle: "Pastasås", scaleFactor: 1 },
      },
    );

    const muffins = view.contributions.find(
      (c) => c.recipeTitle === "Blåbärsmuffins",
    );
    const sauce = view.contributions.find((c) => c.recipeTitle === "Pastasås");

    expect(muffins?.scaleFactor).toBe(2);
    // ×1 next to every unscaled recipe would be pure noise.
    expect(sauce?.scaleFactor).toBeNull();
  });

  it("keeps a recipe total in the unit the recipe was written in", () => {
    // The general display ladder would render 1100 ml as "1,1 l". Correct, and
    // useless in front of the dairy cabinet when the recipe says dl.
    const view = buildEntryView(makeEntry(), [
      recipeContribution("add-muffins", 8, "dl"),
      recipeContribution("add-sauce", 3, "dl"),
    ]);
    expect(view.totalLabel).toBe("11 dl");
  });

  it("falls back to the display ladder when the units disagree", () => {
    const view = buildEntryView(makeEntry(), [
      recipeContribution("add-a", 2, "l"),
      recipeContribution("add-b", 5, "dl"),
    ]);
    expect(view.totalLabel).toBe("2,5 l");
  });

  it("refuses to merge across unit families rather than guessing", () => {
    // dl of flour to grams needs a density we do not have. Showing both is
    // honest; inventing a single number is not.
    const view = buildEntryView(makeEntry(), [
      recipeContribution("add-a", 2, "dl"),
      {
        id: manualContributionId(entryId(LIST, CREAM)),
        entryId: entryId(LIST, CREAM),
        sourceKind: "manual",
        recipeAdditionId: null,
        amount: { value: 3, unit: "st" },
        note: null,
        modifier: null,
      },
    ]);

    expect(view.totalLabel).toBe("2 dl + 3 st");
    expect(view.totals).toHaveLength(2);
  });

  it("treats an amountless entry as valid, not as zero", () => {
    // "bread, some" is the correct default for most of a shopping list.
    const view = buildEntryView(makeEntry(), [
      {
        id: manualContributionId(entryId(LIST, CREAM)),
        entryId: entryId(LIST, CREAM),
        sourceKind: "manual",
        recipeAdditionId: null,
        amount: null,
        note: null,
        modifier: null,
      },
    ]);

    expect(view.totalLabel).toBe("");
    expect(view.totals).toEqual([]);
    expect(view.hasRecipeSource).toBe(false);
  });

  it("ignores contributions belonging to a different entry", () => {
    const view = buildEntryView(makeEntry(), [
      recipeContribution("add-muffins", 8, "dl"),
      {
        id: "other#manual",
        entryId: entryId(LIST, "brod"),
        sourceKind: "manual",
        recipeAdditionId: null,
        amount: { value: 99, unit: "dl" },
        note: null,
        modifier: null,
      },
    ]);

    expect(view.totalLabel).toBe("8 dl");
  });

  it("sorts recipe sources above manual ones", () => {
    const view = buildEntryView(
      makeEntry(),
      [
        {
          id: manualContributionId(entryId(LIST, CREAM)),
          entryId: entryId(LIST, CREAM),
          sourceKind: "manual",
          recipeAdditionId: null,
          amount: { value: 1, unit: "dl" },
          note: null,
          modifier: null,
        },
        recipeContribution("add-muffins", 8, "dl"),
      ],
      { "add-muffins": { recipeTitle: "Blåbärsmuffins", scaleFactor: 2 } },
    );

    expect(view.contributions[0].sourceKind).toBe("recipe");
  });

  it("collects notes and drops empty ones", () => {
    const view = buildEntryView(makeEntry(), [
      {
        id: manualContributionId(entryId(LIST, CREAM)),
        entryId: entryId(LIST, CREAM),
        sourceKind: "manual",
        recipeAdditionId: null,
        amount: null,
        note: "helst ekologisk",
        modifier: null,
      },
      { ...recipeContribution("add-a", 2, "dl"), note: "   " },
    ]);

    expect(view.notes).toEqual(["helst ekologisk"]);
  });
});

describe("activeEntries", () => {
  it("hides tombstoned entries", () => {
    const live = makeEntry();
    const bought = makeEntry({
      id: entryId(LIST, "mjolk"),
      catalogItemId: "mjolk",
      removedAt: "2026-03-12T11:00:00.000Z",
    });

    expect(activeEntries([live, bought])).toEqual([live]);
  });
});

describe("groupByCategory", () => {
  const items = [
    { id: "a", cat: "mejeri" },
    { id: "b", cat: "frukt-gront" },
    { id: "c", cat: "mejeri" },
    { id: "d", cat: "nytt" },
  ];

  it("follows the list's own walking order", () => {
    const groups = groupByCategory(
      items,
      (i) => i.cat,
      ["frukt-gront", "mejeri"],
    );
    expect(groups.map((g) => g.categoryId)).toEqual([
      "frukt-gront",
      "mejeri",
      "nytt",
    ]);
  });

  it("puts categories missing from the order at the end rather than dropping them", () => {
    // A newly seeded category must show up somewhere sane, not vanish.
    const groups = groupByCategory(items, (i) => i.cat, ["mejeri"]);
    expect(groups[0].categoryId).toBe("mejeri");
    expect(groups.map((g) => g.categoryId)).toContain("nytt");
  });

  it("keeps every item", () => {
    const groups = groupByCategory(items, (i) => i.cat, ["mejeri"]);
    expect(groups.flatMap((g) => g.items)).toHaveLength(items.length);
  });
});

describe("shouldGroupByAisle", () => {
  it("stays flat for a short list and groups for a long one", () => {
    expect(shouldGroupByAisle(5)).toBe(false);
    expect(shouldGroupByAisle(12)).toBe(false);
    expect(shouldGroupByAisle(13)).toBe(true);
  });
});

describe("itemsOnlyWantedByRecipe", () => {
  const LIST = "hemkop";
  const ADDITION = "add-1";

  function entry(itemId: string, removed = false): ListEntry {
    return {
      id: entryId(LIST, itemId),
      listId: LIST,
      catalogItemId: itemId,
      createdAt: "2026-03-12T10:00:00.000Z",
      createdBy: "anders",
      removedAt: removed ? "2026-03-12T11:00:00.000Z" : null,
      priority: "normal",
      updatedAt: "2026-03-12T10:00:00.000Z",
      updatedBy: "anders",
    };
  }

  function recipeContribution(itemId: string, additionId: string): Contribution {
    return {
      id: `${additionId}#${itemId}`,
      entryId: entryId(LIST, itemId),
      sourceKind: "recipe",
      recipeAdditionId: additionId,
      amount: { value: 2, unit: "dl" },
      note: null,
      modifier: null,
    };
  }

  function manualContribution(itemId: string): Contribution {
    return {
      id: `${entryId(LIST, itemId)}#manual`,
      entryId: entryId(LIST, itemId),
      sourceKind: "manual",
      recipeAdditionId: null,
      amount: { value: 1, unit: "st" },
      note: null,
      modifier: null,
    };
  }

  it("offers an item nothing else wants", () => {
    expect(
      itemsOnlyWantedByRecipe(
        ADDITION,
        [entry("gradde")],
        [recipeContribution("gradde", ADDITION)],
      ),
    ).toEqual(["gradde"]);
  });

  it("leaves an item you also asked for yourself", () => {
    // The whole reason this is a suggestion and not an action.
    expect(
      itemsOnlyWantedByRecipe(
        ADDITION,
        [entry("gradde")],
        [recipeContribution("gradde", ADDITION), manualContribution("gradde")],
      ),
    ).toEqual([]);
  });

  it("leaves an item a second recipe also wants", () => {
    expect(
      itemsOnlyWantedByRecipe(
        ADDITION,
        [entry("gradde")],
        [
          recipeContribution("gradde", ADDITION),
          recipeContribution("gradde", "add-2"),
        ],
      ),
    ).toEqual([]);
  });

  it("ignores items this recipe never asked for", () => {
    expect(
      itemsOnlyWantedByRecipe(
        ADDITION,
        [entry("gradde"), entry("banan")],
        [
          recipeContribution("gradde", ADDITION),
          manualContribution("banan"),
        ],
      ),
    ).toEqual(["gradde"]);
  });

  it("ignores an entry already removed", () => {
    expect(
      itemsOnlyWantedByRecipe(
        ADDITION,
        [entry("gradde", true)],
        [recipeContribution("gradde", ADDITION)],
      ),
    ).toEqual([]);
  });

  it("offers an entry with no contributions at all left", () => {
    // A bare add_item creates an entry with no contributions, so an entry whose
    // only contribution was this recipe's is the same shape either way.
    expect(
      itemsOnlyWantedByRecipe(
        ADDITION,
        [entry("mjolk"), entry("gradde")],
        [
          recipeContribution("mjolk", ADDITION),
          recipeContribution("gradde", ADDITION),
        ],
      ),
    ).toEqual(["mjolk", "gradde"]);
  });
});

/**
 * An entry can outlive its vara — the reducer means it to, because a merge that
 * rewrote entry rows would not converge. What it must never do is outlive it
 * INVISIBLY, which is what happened in production: the screen looked the vara up,
 * missed, and dropped the tile, leaving a live row nothing could draw, no gesture
 * could reach, and pruning could not collect.
 */
describe("tileVaror", () => {
  function vara(id: string, name = id): CatalogItem {
    return {
      id,
      name,
      nameNorm: name,
      categoryId: "mejeri-agg",
      iconRef: "1F95B",
      isCustom: false,
      hasAtHome: false,
      useCount: 0,
      lastUsedAt: null,
    };
  }

  it("passes real varor through untouched", () => {
    const { byId, standIns } = tileVaror([vara(CREAM, "grädde")], [makeEntry()]);
    expect(byId.get(CREAM)!.name).toBe("grädde");
    expect(byId.size).toBe(1);
    expect(standIns.size).toBe(0);
  });

  it("stands in for an entry whose vara is gone, so the tile can be tapped off", () => {
    const stranded = makeEntry({
      id: entryId(LIST, "vitloksklyfta"),
      catalogItemId: "vitloksklyfta",
    });

    const { byId, standIns } = tileVaror(
      [vara(CREAM, "grädde")],
      [makeEntry(), stranded],
    );

    // Named, so the caller can refuse to record a purchase against a tombstoned
    // vara and can hide the dead-end link into the registry.
    expect([...standIns]).toEqual(["vitloksklyfta"]);
    const standIn = byId.get("vitloksklyfta");
    expect(standIn).toBeDefined();
    // Named from the entry's own id, because the row that knew the pretty
    // spelling is precisely what is missing. Övrigt and a box say "something odd
    // is here" rather than pretending this is an ordinary vara.
    expect(standIn).toMatchObject({
      id: "vitloksklyfta",
      name: "vitloksklyfta",
      categoryId: "ovrigt",
      iconRef: "1F4E6",
    });
  });

  it("opens a slug back out so a two-word vara does not read as one", () => {
    const stranded = makeEntry({
      id: entryId(LIST, "creme-fraiche"),
      catalogItemId: "creme-fraiche",
    });
    expect(tileVaror([], [stranded]).byId.get("creme-fraiche")!.name).toBe(
      "creme fraiche",
    );
  });

  it("stands in for nothing that is already tombstoned", () => {
    // `live` is the caller's active set. A bought item whose vara was later
    // deleted must not come back as a stand-in tile — it is off the list, and
    // resurrecting it here would undo a removal nobody asked to undo.
    const removed = makeEntry({
      id: entryId(LIST, "gone"),
      catalogItemId: "gone",
      removedAt: "2026-03-12T11:00:00.000Z",
    });
    const { byId, standIns } = tileVaror([], activeEntries([removed]));
    expect(byId.has("gone")).toBe(false);
    expect(standIns.has("gone")).toBe(false);
  });
});

/**
 * The walk round the shop.
 *
 * `lists.category_order` has been per-list since the first migration — Hemköp
 * and Bauhaus share the household's vocabulary and nothing about their layout —
 * but nothing in the app could ever edit it, so every list walked in seed order.
 * That falls hardest on exactly the varor a household invents: the add bar files
 * anything new under Övrigt, and Övrigt sorts last.
 */
describe("walkingRank", () => {
  it("ranks by the list's own order and sends the unnamed to the back", () => {
    const rank = walkingRank(["frukt-gront", "brod", "mejeri-agg"]);
    expect(rank("frukt-gront")).toBe(0);
    expect(rank("mejeri-agg")).toBe(2);
    // Not zero, not an error: a newly seeded category turns up somewhere sane
    // rather than at the front of a shop it has never been in. Same rule
    // `groupByCategory` already applied, stated once so the two cannot drift.
    expect(rank("ovrigt")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("orderedCategories", () => {
  const cats = [
    { id: "brod", name: "Bröd" },
    { id: "ovrigt", name: "Övrigt" },
    { id: "frukt-gront", name: "Frukt & grönt" },
  ];

  it("puts the ordered ones first and the rest after", () => {
    expect(
      orderedCategories(cats, ["frukt-gront", "brod"]).map((c) => c.id),
    ).toEqual(["frukt-gront", "brod", "ovrigt"]);
  });

  it("returns every category, including ones the order has never heard of", () => {
    // The editor needs the whole set: a category missing from `category_order`
    // is precisely the one you opened the editor to place, and leaving it out
    // would make it unreachable.
    expect(orderedCategories(cats, []).map((c) => c.id)).toHaveLength(3);
  });

  it("does not mutate what it is given", () => {
    const order = ["brod"];
    const input = cats.slice();
    orderedCategories(input, order);
    expect(input.map((c) => c.id)).toEqual(["brod", "ovrigt", "frukt-gront"]);
  });
});

describe("moveCategory", () => {
  const order = ["frukt-gront", "brod", "mejeri-agg"];

  it("swaps with the neighbour in the named direction", () => {
    expect(moveCategory(order, "brod", -1)).toEqual([
      "brod",
      "frukt-gront",
      "mejeri-agg",
    ]);
    expect(moveCategory(order, "brod", 1)).toEqual([
      "frukt-gront",
      "mejeri-agg",
      "brod",
    ]);
  });

  it("stops at either end rather than wrapping", () => {
    // Wrapping would send the first aisle to the back of the shop on a mis-tap,
    // and the mis-tap is likely: these are two 44px buttons side by side.
    expect(moveCategory(order, "frukt-gront", -1)).toBe(order);
    expect(moveCategory(order, "mejeri-agg", 1)).toBe(order);
  });

  it("says nothing about a category the order does not contain", () => {
    expect(moveCategory(order, "ovrigt", -1)).toBe(order);
  });

  it("leaves the input alone", () => {
    const input = order.slice();
    moveCategory(input, "brod", -1);
    expect(input).toEqual(order);
  });
});

describe("groupingFor", () => {
  it("keeps the old rule when nobody has chosen", () => {
    // A household that never opens the setting must see exactly what it saw
    // before the setting existed.
    expect(groupingFor("auto", true)).toBe(true);
    expect(groupingFor("auto", false)).toBe(false);
  });

  it("lets a choice override the count either way", () => {
    expect(groupingFor("grouped", false)).toBe(true);
    expect(groupingFor("flat", true)).toBe(false);
  });
});
