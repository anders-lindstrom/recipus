import { describe, expect, it } from "vitest";
import type { CatalogItem } from "@/lib/domain";
import { normalizeName } from "@/lib/utils";
import {
  boundedEditDistance,
  rankMatches,
  resolveQuery,
  splitQuery,
} from "./search";

function item(name: string, useCount = 0): CatalogItem {
  return {
    id: name,
    name,
    nameNorm: normalizeName(name),
    categoryId: "test",
    iconRef: "1F4E6",
    isCustom: false,
    hasAtHome: false,
    useCount,
    lastUsedAt: null,
  };
}

const CATALOG = [
  item("mjölk", 40),
  item("havremjölk", 5),
  item("mellanmjölk", 2),
  item("gul lök", 12),
  item("rödlök", 3),
  item("räkor", 8),
  item("smör", 20),
];

describe("rankMatches", () => {
  it("puts a prefix match above a substring match", () => {
    // Typing "mj" means mjölk, not havremjölk.
    expect(rankMatches(CATALOG, "mj")[0].name).toBe("mjölk");
  });

  it("matches the start of a later word", () => {
    // "lök" has to find "gul lök" — nobody types the adjective first.
    const names = rankMatches(CATALOG, "lök").map((i) => i.name);
    expect(names).toContain("gul lök");
  });

  it("ignores Swedish diacritics in both directions", () => {
    // Reaching for ä while walking through a shop is not happening.
    expect(rankMatches(CATALOG, "rakor")[0].name).toBe("räkor");
    expect(rankMatches(CATALOG, "räkor")[0].name).toBe("räkor");
  });

  it("is case insensitive", () => {
    expect(rankMatches(CATALOG, "SMÖR")[0].name).toBe("smör");
  });

  it("breaks ties on how often you actually buy the thing", () => {
    const names = rankMatches(CATALOG, "mjölk").map((i) => i.name);
    // All three contain "mjölk"; the exact match wins, then usage decides.
    expect(names[0]).toBe("mjölk");
    expect(names.indexOf("havremjölk")).toBeLessThan(
      names.indexOf("mellanmjölk"),
    );
  });

  it("returns nothing for an empty query", () => {
    expect(rankMatches(CATALOG, "")).toEqual([]);
    expect(rankMatches(CATALOG, "   ")).toEqual([]);
  });

  it("returns nothing when there is genuinely no match", () => {
    expect(rankMatches(CATALOG, "zzzz")).toEqual([]);
  });

  it("respects the limit", () => {
    expect(rankMatches(CATALOG, "m", 2)).toHaveLength(2);
  });
});

describe("splitQuery", () => {
  it("takes a trailing amount", () => {
    expect(splitQuery("mjölk 2 l")).toEqual({
      name: "mjölk",
      amountText: "2 l",
    });
  });

  it("takes a leading amount", () => {
    expect(splitQuery("2 l mjölk")).toEqual({
      name: "mjölk",
      amountText: "2 l",
    });
  });

  it("leaves a bare name alone", () => {
    expect(splitQuery("mjölk")).toEqual({ name: "mjölk", amountText: "" });
  });

  it("keeps a multi-word name intact", () => {
    expect(splitQuery("gul lök")).toEqual({ name: "gul lök", amountText: "" });
  });

  it("handles a multi-word name with a trailing amount", () => {
    expect(splitQuery("gul lök 3 st")).toEqual({
      name: "gul lök",
      amountText: "3 st",
    });
  });

  it("does not mistake a number in the name for a quantity", () => {
    // A bare trailing number is a real quantity, so this is the boundary case
    // worth pinning: the name must survive.
    const { name } = splitQuery("mjölk 3");
    expect(name).toBe("mjölk");
  });

  it("normalises runs of whitespace", () => {
    expect(splitQuery("  mjölk   2 l  ")).toEqual({
      name: "mjölk",
      amountText: "2 l",
    });
  });

  it("returns empty for empty input", () => {
    expect(splitQuery("")).toEqual({ name: "", amountText: "" });
    expect(splitQuery("   ")).toEqual({ name: "", amountText: "" });
  });

  it("handles Swedish decimal commas", () => {
    expect(splitQuery("grädde 2,5 dl")).toEqual({
      name: "grädde",
      amountText: "2,5 dl",
    });
  });
});

// ---------------------------------------------------------------------------
// Inflection: the direction every literal tier was missing
// ---------------------------------------------------------------------------

const VEG = [
  item("tomat", 30),
  item("krossade tomater", 9),
  item("passerade tomater", 4),
  item("ost", 25),
  item("mjölk", 40),
];

describe("rankMatches, inflected queries", () => {
  it("reaches the singular from the plural people actually type", () => {
    // Every other tier asks whether the catalog name contains the query, so
    // "tomater" used to find both jars of tomatoes and never the vegetable.
    expect(rankMatches(VEG, "tomater")[0].name).toBe("tomat");
  });

  it("still offers the jars, just below the thing itself", () => {
    const names = rankMatches(VEG, "tomater").map((i) => i.name);
    expect(names).toContain("krossade tomater");
    expect(names.indexOf("tomat")).toBeLessThan(
      names.indexOf("krossade tomater"),
    );
  });

  it("does not treat a compound as an inflection of its own first half", () => {
    // "ostbågar" is a thing you are about to create, not a way of saying ost.
    expect(rankMatches(VEG, "ostbågar").map((i) => i.name)).not.toContain("ost");
    expect(rankMatches(VEG, "mjölkchoklad").map((i) => i.name)).not.toContain(
      "mjölk",
    );
  });

  it("requires a real Swedish ending, not just a short one", () => {
    // Caught in the real catalog: with a plain "at most three more characters"
    // rule, the most-bought item in the shop suggested flour SECOND, because
    // mjölk is mjöl plus a k. A k is not an inflection of anything.
    //
    // Flour is still reachable from "mjölk" — one edit apart, so the fuzzy tier
    // has it — but it now sits below a genuine substring match instead of above
    // one, which is the whole distinction being pinned here.
    const names = rankMatches(
      [item("mjöl", 3), item("mjölk", 40), item("havremjölk", 5)],
      "mjölk",
    ).map((i) => i.name);

    expect(names[0]).toBe("mjölk");
    expect(names.indexOf("havremjölk")).toBeLessThan(names.indexOf("mjöl"));
  });

  it("accepts the endings that are real", () => {
    const catalog = [item("banan"), item("ägg"), item("äpple")];
    expect(rankMatches(catalog, "bananer")[0].name).toBe("banan");
    expect(rankMatches(catalog, "ägget")[0].name).toBe("ägg");
    expect(rankMatches(catalog, "äpplen")[0].name).toBe("äpple");
  });
});

// ---------------------------------------------------------------------------
// Typo tolerance
// ---------------------------------------------------------------------------

describe("boundedEditDistance", () => {
  it("counts a transposition as one slip, not two", () => {
    // The whole reason this is not plain Levenshtein: a thumb produces "mjlök"
    // about as often as "mjök", and they are the same mistake.
    expect(boundedEditDistance("mjlök", "mjölk", 1)).toBe(1);
  });

  it("gives up rather than returning a distance it never finished", () => {
    expect(boundedEditDistance("mjölk", "knäckebröd", 2)).toBeNull();
  });

  it("is zero for identical strings", () => {
    expect(boundedEditDistance("gröt", "gröt", 1)).toBe(0);
  });
});

const BREAKFAST = [
  item("gröt", 22),
  item("gryn", 6),
  item("mjölk", 40),
  item("smör", 20),
  item("kokt skinka", 5),
  item("knäckebröd", 7),
];

describe("rankMatches, typos", () => {
  it("finds gröt from grät", () => {
    expect(rankMatches(BREAKFAST, "grät")[0].name).toBe("gröt");
  });

  it("finds mjölk from a dropped letter", () => {
    expect(rankMatches(BREAKFAST, "mjök")[0].name).toBe("mjölk");
  });

  it("finds a multi-word vara from a fumbled single word", () => {
    // Distance from the whole name is six; from its last word it is one, which
    // is the only reason the registry's multi-word varor stay reachable.
    expect(rankMatches(BREAKFAST, "sinka").map((i) => i.name)).toContain(
      "kokt skinka",
    );
  });

  it("never outranks something that matched literally", () => {
    // "gryn" is exact; "gröt" is one edit away. Exactness wins, always.
    const names = rankMatches(BREAKFAST, "gryn").map((i) => i.name);
    expect(names[0]).toBe("gryn");
  });

  it("stays out of short queries entirely", () => {
    // At three characters nearly everything is one edit from everything, and
    // the tier stops carrying information.
    expect(rankMatches(BREAKFAST, "grt")).toEqual([]);
  });

  it("still refuses a query that resembles nothing", () => {
    expect(rankMatches(BREAKFAST, "zzzzzz")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveQuery: amount + qualifier + vara
// ---------------------------------------------------------------------------

const SHOP = [
  item("mango", 11),
  item("mjölk", 40),
  item("paprika", 14),
  item("gul lök", 12),
  item("lök", 6),
  item("tomat", 30),
];

describe("resolveQuery", () => {
  it("reads a leading adjective as the sort", () => {
    const r = resolveQuery(SHOP, "mogen mango");
    expect(r.matches[0].name).toBe("mango");
    expect(r.modifier).toBe("mogen");
  });

  it("keeps a multi-word vara whole rather than inventing a sort", () => {
    // "gul lök" is a vara in its own right. Splitting it into lök + "gul" would
    // put the household's own word on the tile as a qualifier.
    const r = resolveQuery(SHOP, "gul lök");
    expect(r.matches[0].name).toBe("gul lök");
    expect(r.modifier).toBe("");
  });

  it("carries amount and sort at the same time, in either order", () => {
    for (const raw of ["2 l laktosfri mjölk", "laktosfri mjölk 2 l"]) {
      const r = resolveQuery(SHOP, raw);
      expect(r.matches[0].name).toBe("mjölk");
      expect(r.modifier).toBe("laktosfri");
      expect(r.amountText).toBe("2 l");
    }
  });

  it("leaves the sort empty when the whole query is a vara", () => {
    expect(resolveQuery(SHOP, "mjölk").modifier).toBe("");
  });

  it("refuses to read a sentence as a sort", () => {
    // Four words in front of a vara is not a qualifier, and putting it on the
    // tile under the name would be worse than offering to create what was typed.
    const r = resolveQuery(SHOP, "en riktigt fin och mogen mango");
    expect(r.matches).toEqual([]);
    expect(r.name).toBe("riktigt fin och mogen mango");
  });

  it("does not invent a sort out of a typo", () => {
    // "mangp" resolves fuzzily on its own, but only as the whole query. If a
    // fuzzy hit could decide where a name begins, one slipped letter would turn
    // the word in front of it into a qualifier nobody typed.
    expect(resolveQuery(SHOP, "mangp").matches[0].name).toBe("mango");
    expect(resolveQuery(SHOP, "stor mangp").matches).toEqual([]);
  });

  it("still reads a sort in front of a vara spelled correctly", () => {
    // The guard above must not cost the ordinary case: only the fuzzy tier is
    // barred from ending a name, not the inflected one.
    expect(resolveQuery(SHOP, "krossade tomater").modifier).toBe("krossade");
    expect(resolveQuery(SHOP, "krossade tomater").matches[0].name).toBe("tomat");
  });

  it("reports the typed name so a create still says what was typed", () => {
    const r = resolveQuery(SHOP, "3 st mogen mango");
    expect(r.name).toBe("mogen mango");
    expect(r.amountText).toBe("3 st");
  });

  it("returns nothing for an empty query", () => {
    expect(resolveQuery(SHOP, "   ")).toEqual({
      matches: [],
      modifier: "",
      amountText: "",
      name: "",
    });
  });
});
