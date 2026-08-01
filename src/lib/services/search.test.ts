import { describe, expect, it } from "vitest";
import type { CatalogItem } from "@/lib/domain";
import { normalizeName } from "@/lib/utils";
import {
  boundedEditDistance,
  rankMatches,
  resolvePair,
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
    hidden: false,
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

describe("rankMatches with hidden varor", () => {
  /**
   * Hidden means "keep it out of my way", not "pretend it does not exist".
   *
   * Demoting rather than dropping is what keeps hiding from being a one-way
   * door: filtering here would mean typing the exact name of a vara you hid last
   * month returns nothing, the add bar offers to CREATE it, and the household
   * ends up with a second vara under the same word while the first one's
   * purchase history is stranded on the one they can no longer reach.
   */
  const WITH_HIDDEN = [
    ...CATALOG,
    { ...item("mjölkchoklad", 30), hidden: true },
  ];

  it("sorts a hidden vara below every visible match", () => {
    const names = rankMatches(WITH_HIDDEN, "mjölk").map((i) => i.name);
    expect(names).toContain("mjölkchoklad");
    expect(names[names.length - 1]).toBe("mjölkchoklad");
  });

  it("demotes a hidden EXACT match below a visible partial one", () => {
    // Even the strongest possible match loses to any visible one — the point is
    // that the household never trips over a hidden vara by accident.
    const catalog = [item("mjölkchoklad", 1), { ...item("mjölk", 40), hidden: true }];
    expect(rankMatches(catalog, "mjölk")[0].name).toBe("mjölkchoklad");
  });

  it("still finds a hidden vara when nothing else matches", () => {
    const catalog = [{ ...item("saffran", 3), hidden: true }];
    // The way back. Typing the name is how you ask for it again, and the add bar
    // un-hides whatever you pick.
    expect(rankMatches(catalog, "saffran").map((i) => i.name)).toEqual(["saffran"]);
  });
});

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

  it("finds a quantity between the words", () => {
    // "banan 3 st mogen" is not how anyone speaks, but it is how a thumb
    // produces a query when the sort is an afterthought. Without this the
    // amount silently becomes part of the qualifier.
    expect(splitQuery("banan 3 st mogen")).toEqual({
      name: "banan mogen",
      amountText: "3 st",
    });
  });

  it("still prefers a leading or trailing quantity to an interior one", () => {
    // The interior pass runs last precisely so it cannot reinterpret a query
    // the other two already read correctly.
    expect(splitQuery("2 l mjölk 3")).toEqual({
      name: "mjölk 3",
      amountText: "2 l",
    });
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

  it("reads the sort behind the vara too, and lands in the same place", () => {
    // "mogen banan" and "banan mogen" are the same instruction, and only one of
    // them is grammatical. Understanding one word order would be teaching a
    // syntax rather than taking an instruction.
    const front = resolveQuery(SHOP, "mogen mango");
    const back = resolveQuery(SHOP, "mango mogen");
    expect(back.matches[0].name).toBe(front.matches[0].name);
    expect(back.modifier).toBe(front.modifier);
  });

  it("reads a trailing sort alongside an amount, in any order", () => {
    for (const raw of ["mjölk laktosfri 2 l", "2 l mjölk laktosfri"]) {
      const r = resolveQuery(SHOP, raw);
      expect(r.matches[0].name).toBe("mjölk");
      expect(r.modifier).toBe("laktosfri");
      expect(r.amountText).toBe("2 l");
    }
  });

  it("still prefers the leading reading when a query works both ways", () => {
    // Swedish puts the head noun last, so of the two available readings of
    // "gul lök mogen" the vara is lök and not gul.
    const r = resolveQuery(SHOP, "gul lök mogen");
    expect(r.matches[0].name).toBe("gul lök");
    expect(r.modifier).toBe("mogen");
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

  it("never reads a conjunction as a sort", () => {
    // Without this "salt och peppar" resolves to peppar of the sort
    // "salt och", which would print on the tile under the name.
    expect(resolveQuery(PANTRY, "salt och peppar").matches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Two varor in one breath
// ---------------------------------------------------------------------------

const PANTRY = [
  item("salt", 18),
  item("peppar", 15),
  item("mjölk", 40),
  item("gul lök", 12),
];

describe("resolvePair", () => {
  it("reads two varor out of one query", () => {
    expect(resolvePair(PANTRY, "salt och peppar")?.map((i) => i.name)).toEqual([
      "salt",
      "peppar",
    ]);
  });

  it("tolerates a typo on either side", () => {
    expect(resolvePair(PANTRY, "salt och peppr")?.map((i) => i.name)).toEqual([
      "salt",
      "peppar",
    ]);
  });

  it("refuses when an amount would have to be divided", () => {
    // "2 dl salt och peppar" has an obvious wrong answer and no obvious right
    // one, so it stays a single-vara query.
    expect(resolvePair(PANTRY, "2 dl salt och peppar")).toBeNull();
  });

  it("refuses when a sort would have to be divided", () => {
    expect(resolvePair(PANTRY, "grovmalen salt och peppar")).toBeNull();
  });

  it("refuses when either half names nothing", () => {
    expect(resolvePair(PANTRY, "salt och zzzzzz")).toBeNull();
    expect(resolvePair(PANTRY, "zzzzzz och peppar")).toBeNull();
  });

  it("refuses the same vara said twice", () => {
    expect(resolvePair(PANTRY, "salt och salt")).toBeNull();
  });

  it("leaves a vara whose own name contains och alone", () => {
    // Nothing in the seeded catalog is named this way today, but the registry
    // lets a household invent one, and splitting it would make it unreachable.
    const catalog = [...PANTRY, item("salt och peppar", 3)];
    expect(resolveQuery(catalog, "salt och peppar").matches[0].name).toBe(
      "salt och peppar",
    );
  });

  it("is null for a query with no conjunction at all", () => {
    expect(resolvePair(PANTRY, "mjölk")).toBeNull();
  });
});
