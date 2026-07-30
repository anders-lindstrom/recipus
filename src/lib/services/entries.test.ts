import { describe, expect, it } from "vitest";
import {
  entryId,
  manualContributionId,
  recipeContributionId,
  type Contribution,
  type ListEntry,
  type Unit,
} from "@/lib/domain";
import {
  activeEntries,
  buildEntryView,
  itemsOnlyWantedByRecipe,
  groupByCategory,
  shouldGroupByAisle,
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
