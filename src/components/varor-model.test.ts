import { describe, expect, it } from "vitest";
import {
  emptyState,
  entryId,
  type Amount,
  type Contribution,
  type CatalogItem,
  type ListEntry,
  type Product,
  type SyncState,
} from "@/lib/domain";
import { tileVaror } from "@/lib/services/entries";
import { applyOps } from "@/lib/sync/reducer";
import type { Op } from "@/lib/sync/ops";
import { normalizeName } from "@/lib/utils";
import {
  buildRegistry,
  collidingVara,
  deletionBlockers,
  filterProducts,
  filterVaror,
  mergeVaraOps,
  productSubtitle,
  unplacedProducts,
} from "./varor-model";

const LIST = "hemkop";

function at(minutes: number): string {
  // Fixed clock, as everywhere else in this codebase: a test that depends on
  // wall time is a test that fails at midnight.
  return new Date(Date.UTC(2026, 6, 30, 9, minutes, 0)).toISOString();
}

function item(id: string, name = id): CatalogItem {
  return {
    id,
    name,
    // Derived, never hand-written: `nameNorm` is the folded string search and
    // matching actually compare against, and a fixture that set it to the
    // display name would quietly test a state the app cannot produce.
    nameNorm: normalizeName(name),
    categoryId: "mejeri-agg",
    iconRef: "1F95B",
    isCustom: false,
    hasAtHome: false,
    useCount: 0,
    lastUsedAt: null,
  };
}

function product(
  id: string,
  name: string,
  catalogItemId: string | null,
  minute = 0,
): Product {
  return {
    id,
    name,
    brand: null,
    catalogItemId,
    defaultSize: null,
    sourceSizeText: null,
    imageUrl: null,
    createdAt: at(minute),
    createdBy: "anders",
  };
}

function entry(catalogItemId: string, removedAt: string | null = null): ListEntry {
  return {
    id: entryId(LIST, catalogItemId),
    listId: LIST,
    catalogItemId,
    createdAt: at(0),
    createdBy: "anders",
    removedAt,
    priority: "normal",
    updatedAt: at(0),
    updatedBy: "anders",
  };
}

function stateWith(parts: Partial<SyncState>): SyncState {
  return { ...emptyState(), ...parts };
}

describe("buildRegistry", () => {
  it("hangs each product off the vara it is placed on", () => {
    const state = stateWith({
      catalog: { mjolk: item("mjolk"), gradde: item("gradde") },
      products: {
        arla: product("arla", "Arla Standardmjölk", "mjolk", 1),
        garant: product("garant", "Garant Mellanmjölk", "mjolk", 2),
        vispa: product("vispa", "Arla Vispgrädde", "gradde", 3),
      },
    });

    const registry = buildRegistry(state);
    const mjolk = registry.find((v) => v.item.id === "mjolk")!;

    expect(mjolk.products.map((p) => p.id)).toEqual(["garant", "arla"]);
    expect(registry.find((v) => v.item.id === "gradde")!.products).toHaveLength(1);
  });

  it("leaves unplaced products off every vara", () => {
    const state = stateWith({
      catalog: { mjolk: item("mjolk") },
      products: { unknown: product("unknown", "Okänd", null) },
    });

    expect(buildRegistry(state)[0].products).toEqual([]);
  });

  it("counts only live entries as being on the list", () => {
    // The whole point of the distinction: buying something last week must not
    // block its vara from ever being renamed or deleted again.
    const state = stateWith({
      catalog: { mjolk: item("mjolk"), gradde: item("gradde") },
      entries: {
        [entryId(LIST, "mjolk")]: entry("mjolk"),
        [entryId(LIST, "gradde")]: entry("gradde", at(5)),
      },
    });

    const registry = buildRegistry(state);
    expect(registry.find((v) => v.item.id === "mjolk")!.onList).toHaveLength(1);
    expect(registry.find((v) => v.item.id === "gradde")!.onList).toEqual([]);
  });

  it("attaches aliases to the vara they reach", () => {
    const state = stateWith({
      catalog: { notfars: item("notfars", "nötfärs") },
      aliases: {
        kottfars: {
          aliasNorm: "kottfars",
          catalogItemId: "notfars",
          createdAt: at(1),
          createdBy: "anders",
        },
      },
    });

    expect(buildRegistry(state)[0].aliases.map((a) => a.aliasNorm)).toEqual([
      "kottfars",
    ]);
  });

  it("sorts alphabetically in Swedish, not in codepoint order", () => {
    // ä sorts after z in Swedish and before b in ASCII. A lookup screen that got
    // this wrong would file "äpple" where nobody looks for it.
    const state = stateWith({
      catalog: {
        apple: item("apple", "äpple"),
        banan: item("banan", "banan"),
        ost: item("ost", "ost"),
      },
    });

    expect(buildRegistry(state).map((v) => v.item.name)).toEqual([
      "banan",
      "ost",
      "äpple",
    ]);
  });
});

describe("unplacedProducts", () => {
  it("returns exactly the products with no vara, newest first", () => {
    const state = stateWith({
      products: {
        placed: product("placed", "Arla Standardmjölk", "mjolk", 1),
        older: product("older", "Okänd A", null, 2),
        newer: product("newer", "Okänd B", null, 3),
      },
    });

    expect(unplacedProducts(state).map((p) => p.id)).toEqual(["newer", "older"]);
  });

  it("is empty when everything has been placed", () => {
    const state = stateWith({
      products: { placed: product("placed", "Arla", "mjolk") },
    });

    expect(unplacedProducts(state)).toEqual([]);
  });
});

describe("deletionBlockers", () => {
  const vara = (parts: Partial<Product>[] = [], onList = false) => ({
    item: item("mjolk"),
    products: parts.map((p, i) => ({
      ...product(`p${i}`, "Arla", "mjolk"),
      ...p,
    })),
    onList: onList ? [entry("mjolk")] : [],
    aliases: [],
  });

  it("finds nothing wrong with an unused vara", () => {
    expect(deletionBlockers(vara())).toEqual([]);
  });

  it("blocks while the vara is on an active list", () => {
    // Reaching into today's shopping from a taxonomy screen is the surprise
    // this exists to prevent.
    expect(deletionBlockers(vara([], true)).map((b) => b.kind)).toEqual([
      "on_list",
    ]);
  });

  it("blocks while products still point at it", () => {
    expect(deletionBlockers(vara([{}])).map((b) => b.kind)).toEqual([
      "has_products",
    ]);
  });

  it("reports both blockers rather than the first one found", () => {
    // Fixing one and being told about the next is two dead ends in a row.
    expect(deletionBlockers(vara([{}], true)).map((b) => b.kind)).toEqual([
      "on_list",
      "has_products",
    ]);
  });
});

describe("filterVaror", () => {
  const registry = buildRegistry(
    stateWith({
      catalog: {
        notfars: item("notfars", "nötfärs"),
        mjolk: item("mjolk", "mjölk"),
      },
      aliases: {
        kottfars: {
          aliasNorm: "kottfars",
          catalogItemId: "notfars",
          createdAt: at(1),
          createdBy: "anders",
        },
      },
    }),
  );

  it("returns everything for an empty query", () => {
    expect(filterVaror(registry, "  ")).toHaveLength(2);
  });

  it("folds Swedish diacritics, because nobody types ö while walking", () => {
    expect(filterVaror(registry, "mjolk").map((v) => v.item.name)).toEqual([
      "mjölk",
    ]);
  });

  it("finds a vara by a word that was merged away into it", () => {
    // The merge's entire promise. If the old word came back empty here the
    // household would reasonably re-create it — restoring the duplicate the
    // merge existed to remove.
    expect(filterVaror(registry, "köttfärs").map((v) => v.item.name)).toEqual([
      "nötfärs",
    ]);
  });
});

describe("filterProducts", () => {
  const products = [
    { ...product("a", "Standardmjölk", null), brand: "Arla" },
    { ...product("b", "Mellanmjölk", null), brand: "Garant" },
  ];

  it("matches on the brand as well as the name", () => {
    // Open Food Facts routinely puts the only distinguishing word in the brand.
    expect(filterProducts(products, "garant").map((p) => p.id)).toEqual(["b"]);
  });
});

describe("productSubtitle", () => {
  it("prefers the pack's own words over the parsed amount", () => {
    // parseAmount("6 x 33 cl") is {6, "st"}, which is not what the pack says.
    const p = {
      ...product("a", "Öl", null),
      brand: "Norrlands",
      defaultSize: { value: 6, unit: "st" as const },
      sourceSizeText: "6 x 33 cl",
    };
    expect(productSubtitle(p)).toBe("Norrlands · 6 x 33 cl");
  });

  it("says nothing rather than something empty when there is nothing to say", () => {
    expect(productSubtitle(product("a", "Okänd", null))).toBe("");
  });
});

describe("collidingVara", () => {
  const catalog = { mjolk: item("mjolk", "mjölk") };

  it("catches a name that slugs onto an existing vara", () => {
    // The dangerous case: create_catalog_item for an existing id silently
    // overwrites the vara that was there.
    expect(collidingVara(catalog, "mjolk", "Mjölk")?.id).toBe("mjolk");
  });

  it("catches a differently-slugged name that normalizes the same", () => {
    expect(collidingVara(catalog, "mjolk-", "mjölk ")?.id).toBe("mjolk");
  });

  it("passes a genuinely new name", () => {
    expect(collidingVara(catalog, "laktosfri-mjolk", "laktosfri mjölk")).toBeNull();
  });
});

/**
 * The half of a merge the reducer must not do.
 *
 * `merge_catalog_items` tombstones the losing word and records the alias, and
 * nothing else — a merge that rewrote rows would not converge. Everything
 * hanging off the word is therefore re-pointed AROUND it, and today's shopping
 * is part of that. It did not used to be, and the consequence reached
 * production: the loser's entry stayed live on a vara the catalog no longer had,
 * so the list screen could not draw it and no gesture could reach it. The item
 * you needed silently vanished, and re-adding the recipe built a second entry
 * beside the invisible one.
 */
describe("mergeVaraOps", () => {
  const KIND = (ops: ReturnType<typeof mergeVaraOps>) => ops.map((o) => o.kind);

  function contribution(
    catalogItemId: string,
    amount: Amount | null,
    sourceKind: "manual" | "recipe" = "recipe",
    modifier: string | null = null,
  ): Contribution {
    return {
      id: `c-${catalogItemId}-${sourceKind}`,
      entryId: entryId(LIST, catalogItemId),
      sourceKind,
      recipeAdditionId: sourceKind === "recipe" ? "add-1" : null,
      amount,
      note: null,
      modifier,
    };
  }

  it("carries the shopping across to the survivor and takes the loser off", () => {
    const state = stateWith({
      catalog: {
        kycklingbrostfile: item("kycklingbrostfile", "kycklingbröstfilé"),
        kycklingbrost: item("kycklingbrost", "kycklingbröst"),
      },
      entries: { [entryId(LIST, "kycklingbrostfile")]: entry("kycklingbrostfile") },
      contributions: {
        "c-1": contribution("kycklingbrostfile", { value: 600, unit: "g" }),
      },
    });

    const ops = mergeVaraOps(state, "kycklingbrostfile", "kycklingbrost", []);

    expect(KIND(ops)).toEqual([
      "add_item",
      "set_amount",
      "remove_item",
      "merge_catalog_items",
    ]);
    // The number the tile was showing survives the merge. Losing it was the
    // whole complaint: you merged two words and the meat left your list.
    expect(ops[1]).toMatchObject({
      catalogItemId: "kycklingbrost",
      amount: { value: 600, unit: "g" },
    });
    // Administration, not a shop. A purchase here would teach the cadence engine
    // that you buy this every time you tidy your vocabulary.
    expect(ops[2]).toMatchObject({
      catalogItemId: "kycklingbrostfile",
      bought: false,
    });
    // The tombstone goes LAST, after everything has been moved off the word.
    expect(ops[3]).toMatchObject({
      fromItemId: "kycklingbrostfile",
      toItemId: "kycklingbrost",
      aliasNorm: "kycklingbrostfile",
    });
  });

  it("leaves the survivor's own tile alone when it is already on the list", () => {
    // Two tiles folding into one. The survivor is a tile somebody is looking at,
    // so its amount stands: overwriting it would silently change a number on
    // screen, and `set_amount` cannot ask for "one more" instead.
    const state = stateWith({
      catalog: {
        vitloksklyfta: item("vitloksklyfta", "vitloksklyfta"),
        vitlok: item("vitlok", "vitlok"),
      },
      entries: {
        [entryId(LIST, "vitloksklyfta")]: entry("vitloksklyfta"),
        [entryId(LIST, "vitlok")]: entry("vitlok"),
      },
      contributions: {
        "c-1": contribution("vitloksklyfta", { value: 2, unit: "st" }),
        "c-2": contribution("vitlok", { value: 1, unit: "st" }),
      },
    });

    const ops = mergeVaraOps(state, "vitloksklyfta", "vitlok", []);

    expect(KIND(ops)).toEqual(["remove_item", "merge_catalog_items"]);
    expect(ops[0]).toMatchObject({ catalogItemId: "vitloksklyfta" });
  });

  it("carries sort and urgency, and stamps priority's clock only when it says something", () => {
    const urgent: ListEntry = { ...entry("kottfars"), priority: "urgent" };
    const state = stateWith({
      catalog: { kottfars: item("kottfars"), notfars: item("notfars") },
      entries: { [entryId(LIST, "kottfars")]: urgent },
      contributions: {
        "c-1": contribution("kottfars", null, "manual", "ekologisk"),
      },
    });

    const ops = mergeVaraOps(state, "kottfars", "notfars", []);

    expect(KIND(ops)).toEqual([
      "add_item",
      "set_modifier",
      "set_priority",
      "remove_item",
      "merge_catalog_items",
    ]);
    expect(ops[1]).toMatchObject({ modifier: "ekologisk" });
    expect(ops[2]).toMatchObject({ priority: "urgent" });
  });

  it("invents no quantity when the entry spans two unit families", () => {
    // "2 dl" and "3 st" cannot be summed honestly, so `buildEntryView` reports
    // two totals — and a single `set_amount` would have to pick one of them and
    // call it the answer. It carries neither instead.
    const state = stateWith({
      catalog: { gradde: item("gradde"), matlagningsgradde: item("matlagningsgradde") },
      entries: { [entryId(LIST, "gradde")]: entry("gradde") },
      contributions: {
        "c-1": contribution("gradde", { value: 2, unit: "dl" }, "recipe"),
        "c-2": contribution("gradde", { value: 3, unit: "st" }, "manual"),
      },
    });

    const ops = mergeVaraOps(state, "gradde", "matlagningsgradde", []);
    expect(KIND(ops)).toEqual(["add_item", "remove_item", "merge_catalog_items"]);
  });

  it("ignores a tombstoned entry, and moves the products it was given", () => {
    const state = stateWith({
      catalog: { a: item("a"), b: item("b") },
      entries: { [entryId(LIST, "a")]: entry("a", at(5)) },
      products: { p1: product("p1", "Något", "a") },
    });

    const ops = mergeVaraOps(state, "a", "b", ["p1"]);
    expect(KIND(ops)).toEqual(["update_product", "merge_catalog_items"]);
    expect(ops[0]).toMatchObject({ productId: "p1", patch: { catalogItemId: "b" } });
  });

  it("says nothing at all about a vara it has never heard of, or a merge into itself", () => {
    const state = stateWith({ catalog: { a: item("a") } });
    expect(mergeVaraOps(state, "gone", "a", [])).toEqual([]);
    // Merging a word into itself would tombstone the survivor and alias the word
    // to a row that no longer exists — the one input that must produce nothing.
    expect(mergeVaraOps(state, "a", "a", [])).toEqual([]);
  });
});

/**
 * The reported scenario, start to finish, through the real reducer.
 *
 * Add the ICA recipe, merge the vara it matched into the plainer word, add the
 * recipe again. Before the fix this ended with two live entries — one of them
 * unrenderable — and the meat you needed missing from the screen.
 */
describe("merging a vara that a recipe put on the list", () => {
  const RECIPE_OPS = (additionId: string, minute: number): Op[] => [
    {
      clientOpId: `add-${additionId}`,
      actor: "anders",
      at: at(minute),
      kind: "add_recipe",
      listId: LIST,
      recipeId: "ica-725395",
      recipeAdditionId: additionId,
      scaleFactor: 1,
      items: [
        {
          catalogItemId: additionId === "first" ? "kycklingbrostfile" : "kycklingbrost",
          amount: { value: 600, unit: "g" },
        },
      ],
    },
  ];

  /** Exactly what `list-screen` draws: entries joined to catalog, plus stand-ins. */
  function tiles(state: SyncState): string[] {
    const live = Object.values(state.entries).filter(
      (e) => e.listId === LIST && e.removedAt === null,
    );
    return [...tileVaror(Object.values(state.catalog), live).values()]
      .filter((c) => live.some((e) => e.catalogItemId === c.id))
      .map((c) => c.name)
      .sort();
  }

  it("keeps one tile, with the amount, across a merge and a re-add", () => {
    let state = applyOps(emptyState(), [
      {
        clientOpId: "c1",
        actor: "anders",
        at: at(1),
        kind: "create_catalog_item",
        item: item("kycklingbrostfile", "kycklingbröstfilé"),
      },
      {
        clientOpId: "c2",
        actor: "anders",
        at: at(2),
        kind: "create_catalog_item",
        item: item("kycklingbrost", "kycklingbröst"),
      },
      ...RECIPE_OPS("first", 3),
    ]);
    expect(tiles(state)).toEqual(["kycklingbröstfilé"]);

    // The merge, dispatched exactly as the screen dispatches it: one op per
    // draft, each with a strictly later clock (see `nextOpTimestamp`).
    const drafts = mergeVaraOps(state, "kycklingbrostfile", "kycklingbrost", []);
    state = applyOps(
      state,
      drafts.map(
        (d, i) =>
          ({ ...d, clientOpId: `m${i}`, actor: "anders", at: at(10 + i) }) as Op,
      ),
    );

    // It moved. It did not vanish, and it left nothing behind that cannot be
    // drawn — the two halves of the production report.
    expect(tiles(state)).toEqual(["kycklingbröst"]);
    expect(
      Object.values(state.entries).filter((e) => e.removedAt === null),
    ).toHaveLength(1);

    // The server re-points `recipe_ingredients`, so the second add resolves to
    // the survivor. One tile, not two.
    state = applyOps(state, RECIPE_OPS("second", 20));
    expect(tiles(state)).toEqual(["kycklingbröst"]);
  });
});
