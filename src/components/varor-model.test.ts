import { describe, expect, it } from "vitest";
import {
  emptyState,
  entryId,
  type CatalogItem,
  type ListEntry,
  type Product,
  type SyncState,
} from "@/lib/domain";
import { normalizeName } from "@/lib/utils";
import {
  buildRegistry,
  collidingVara,
  deletionBlockers,
  filterProducts,
  filterVaror,
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
