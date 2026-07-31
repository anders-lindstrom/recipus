import { describe, expect, it } from "vitest";
import { CATALOG_ITEMS } from "@/db/seed-data";
import { normalizeName, slugify } from "@/lib/utils";
import {
  AUTO_MAP_MIN_SCORE,
  autoMapProductName,
  buildMatchCandidates,
  matchIngredient,
  matchParsedIngredient,
  parseIngredientLine,
  type MatchCandidate,
} from "./index";

// ---------------------------------------------------------------------------
// The real seeded catalog, built the same way src/db/seed.ts does: id is
// slugify(name), nameNorm is normalizeName(name). Testing against the actual
// 336 items catches real mismatches a toy fixture would hide.
// ---------------------------------------------------------------------------

const catalog: MatchCandidate[] = CATALOG_ITEMS.map((item) => ({
  id: slugify(item.name),
  nameNorm: normalizeName(item.name),
}));

/** The id a real catalog item would have, for readable assertions. */
function idFor(name: string): string {
  return slugify(name);
}

describe("parseIngredientLine", () => {
  describe("quantity forms (delegated to parseQuantityPrefix)", () => {
    it("parses a plain decimal-comma amount", () => {
      const result = parseIngredientLine("1,5 dl mjölk");
      expect(result.amount).toEqual({ value: 1.5, unit: "dl" });
      expect(result.name).toBe("mjölk");
      expect(result.rawText).toBe("1,5 dl mjölk");
    });

    it("parses a vulgar fraction", () => {
      const result = parseIngredientLine("½ msk salt");
      expect(result.amount).toEqual({ value: 0.5, unit: "msk" });
      expect(result.name).toBe("salt");
    });

    it("parses an ASCII mixed fraction", () => {
      const result = parseIngredientLine("1 1/2 dl havregryn");
      expect(result.amount).toEqual({ value: 1.5, unit: "dl" });
      expect(result.name).toBe("havregryn");
    });

    it("parses a range, taking the upper bound", () => {
      const result = parseIngredientLine("2-3 dl mjölk");
      expect(result.amount).toEqual({ value: 3, unit: "dl" });
      expect(result.name).toBe("mjölk");
    });

    it("parses a hedge word before the number", () => {
      const result = parseIngredientLine("ca 2 dl grädde");
      expect(result.amount).toEqual({ value: 2, unit: "dl" });
      expect(result.name).toBe("grädde");
    });

    it("parses 'en'/'ett' as a bare count of one", () => {
      expect(parseIngredientLine("en gul lök").amount).toEqual({ value: 1, unit: "st" });
      expect(parseIngredientLine("en gul lök").name).toBe("gul lök");
      expect(parseIngredientLine("ett ägg").amount).toEqual({ value: 1, unit: "st" });
      expect(parseIngredientLine("ett ägg").name).toBe("ägg");
    });

    it("returns a null amount when there is no quantity at all", () => {
      const result = parseIngredientLine("salt och peppar");
      expect(result.amount).toBeNull();
    });
  });

  describe("preparation-word stripping", () => {
    const PREP_WORDS = [
      "finhackad",
      "hackad",
      "riven",
      "skivad",
      "tärnad",
      "strimlad",
      "pressad",
      "krossad",
      "malen",
      "smält",
      "kokt",
      "rostad",
      "färsk",
      "torkad",
      "fryst",
      "ekologisk",
      "valfri",
      "grovhackad",
      "finriven",
      "urkärnad",
      "skalad",
      "delad",
    ];

    it.each(PREP_WORDS)("strips leading '%s'", (word) => {
      expect(parseIngredientLine(`${word} morot`).name).toBe("morot");
    });

    it.each(PREP_WORDS)("strips trailing, comma-separated '%s'", (word) => {
      expect(parseIngredientLine(`morot, ${word}`).name).toBe("morot");
    });

    it("strips a chain of two prep words joined by 'och'", () => {
      expect(parseIngredientLine("1 gul lök, skalad och finhackad").name).toBe("gul lök");
    });

    it("does not strip a prep word that is only a substring of another word", () => {
      // "malen" must not match inside an unrelated longer word.
      expect(parseIngredientLine("smalensk korv").name).toBe("smalensk korv");
    });
  });

  describe("trailing qualifiers", () => {
    it("strips 'efter smak'", () => {
      expect(parseIngredientLine("salt efter smak").name).toBe("salt");
    });

    it("strips 'till garnering'", () => {
      expect(parseIngredientLine("persilja till garnering").name).toBe("persilja");
    });

    it("strips 'att servera till'", () => {
      expect(parseIngredientLine("gräddfil, att servera till").name).toBe("gräddfil");
    });

    it("strips 'ca' as a trailing hedge", () => {
      expect(parseIngredientLine("smör, ca").name).toBe("smör");
    });

    it("strips 'gärna'", () => {
      expect(parseIngredientLine("basilika, gärna").name).toBe("basilika");
    });

    it("strips 'helst'", () => {
      expect(parseIngredientLine("citron, helst").name).toBe("citron");
    });

    it("strips 'eller mer'", () => {
      expect(parseIngredientLine("socker, eller mer").name).toBe("socker");
    });

    it("strips 'vid behov'", () => {
      expect(parseIngredientLine("vatten, vid behov").name).toBe("vatten");
    });

    it("does not strip 'ca' from inside an unrelated word", () => {
      expect(parseIngredientLine("arnica").name).toBe("arnica");
    });
  });

  describe("trailing parenthetical", () => {
    it("strips a trailing parenthetical", () => {
      expect(parseIngredientLine("2 msk smör (ca 200 g)").name).toBe("smör");
    });

    it("strips a parenthetical followed by a qualifier", () => {
      expect(parseIngredientLine("smör (ca 200 g), efter smak").name).toBe("smör");
    });
  });

  describe("multi-ingredient lines", () => {
    it("takes the first ingredient from 'X och Y' and keeps the full rawText", () => {
      const result = parseIngredientLine("salt och peppar efter smak");
      expect(result.name).toBe("salt");
      expect(result.rawText).toBe("salt och peppar efter smak");
    });

    it("does not split when there is no 'och'", () => {
      expect(parseIngredientLine("2 dl vispgrädde").name).toBe("vispgrädde");
    });
  });
});

describe("matchIngredient", () => {
  it("scores an exact normalized match as 1.0", () => {
    // Query casing/diacritics differ from the candidate; normalizeName on
    // both sides is what makes this an exact match.
    const c: MatchCandidate[] = [{ id: "a", nameNorm: normalizeName("grädde") }];
    expect(matchIngredient("Grädde", c)).toEqual({ id: "a", score: 1.0 });
  });

  it("scores a prefix match (either direction) as 0.8", () => {
    const c: MatchCandidate[] = [{ id: "a", nameNorm: "morot" }];
    expect(matchIngredient("morötter", c)).toEqual({ id: "a", score: 0.8 });

    const c2: MatchCandidate[] = [{ id: "b", nameNorm: "morotstärning" }];
    expect(matchIngredient("morot", c2)).toEqual({ id: "b", score: 0.8 });
  });

  it("scores a compound-head match (query's last word suffix) as 0.7", () => {
    // The documented example: vispgrädde -> grädde. nameNorm must already be
    // normalized, as the real caller (matching against a seeded catalog)
    // always provides it.
    const c: MatchCandidate[] = [{ id: "cream", nameNorm: normalizeName("grädde") }];
    expect(matchIngredient("vispgrädde", c)).toEqual({ id: "cream", score: 0.7 });
  });

  it("scores 'kycklingfilé -> filé' as a compound-head match", () => {
    const c: MatchCandidate[] = [{ id: "fillet", nameNorm: normalizeName("filé") }];
    expect(matchIngredient("kycklingfilé", c)).toEqual({ id: "fillet", score: 0.7 });
  });

  it("scores containing a catalog name as a whole word as 0.6", () => {
    const c: MatchCandidate[] = [{ id: "a", nameNorm: "curry" }];
    expect(matchIngredient("kycklinggryta med curry", c)).toEqual({ id: "a", score: 0.6 });
  });

  it("does not score a substring that isn't a whole word as 'contains'", () => {
    const c: MatchCandidate[] = [{ id: "a", nameNorm: "ost" }];
    // "prästost" contains "ost" but not as a separate whole word — this must
    // fall through to the compound-head suffix check instead of "contains".
    expect(matchIngredient("prästost", c)).toEqual({ id: "a", score: 0.7 });
  });

  it("returns null below the 0.5 threshold", () => {
    const c: MatchCandidate[] = [{ id: "a", nameNorm: "kanel" }];
    expect(matchIngredient("saffran", c)).toBeNull();
  });

  it("returns null for an empty catalog", () => {
    expect(matchIngredient("mjölk", [])).toBeNull();
  });

  it("breaks ties on equal score by preferring the shorter catalog name", () => {
    const c: MatchCandidate[] = [
      { id: "long", nameNorm: "mjolkchokladdryck" },
      { id: "short", nameNorm: "mjolk" },
    ];
    // "mjolkchoklad" is a prefix-relation to both: it starts with "mjolk",
    // and "mjolkchokladdryck" starts with it. Both score 0.8; "mjolk" (5
    // chars) is shorter than "mjolkchokladdryck" (18) and should win as the
    // safer, more generic default.
    expect(matchIngredient("mjolkchoklad", c)).toEqual({ id: "short", score: 0.8 });
  });

  it("exact match beats compound-head: potatismjöl vs. mjöl", () => {
    // "mjöl" does not exist as a standalone item in the real seeded catalog
    // (only compounds like "vetemjöl", "potatismjöl"), so this specific
    // invariant is tested with a synthetic catalog that includes it.
    const c: MatchCandidate[] = [
      { id: "potato-flour", nameNorm: normalizeName("potatismjöl") },
      { id: "flour", nameNorm: normalizeName("mjöl") },
    ];
    expect(matchIngredient("potatismjöl", c)).toEqual({ id: "potato-flour", score: 1.0 });
  });

  it("exact match beats compound-head: jordnötssmör vs. smör (real catalog)", () => {
    // Both "jordnötssmör" and "smör" are real catalog items, so this uses
    // the actual seeded data rather than a synthetic fixture.
    expect(matchIngredient("jordnötssmör", catalog)).toEqual({
      id: idFor("jordnötssmör"),
      score: 1.0,
    });
  });

  describe("against the real seeded catalog", () => {
    it("matches 'vispgrädde' exactly", () => {
      expect(matchIngredient("vispgrädde", catalog)).toEqual({
        id: idFor("vispgrädde"),
        score: 1.0,
      });
    });

    it("prefers a prefix match over a compound-head match: 'sojamjölk' -> 'soja'", () => {
      // "sojamjölk" (soy milk) ends in "mjölk", a real catalog item, so
      // compound-head would find it — but "sojamjölk" also starts with
      // "soja" (soy sauce), which scores higher (0.8 prefix > 0.7 compound
      // head). Prefix wins, even though "mjölk" is the semantically better
      // fallback here — a real limitation, see the module report.
      expect(matchIngredient("sojamjölk", catalog)).toEqual({
        id: idFor("soja"),
        score: 0.8,
      });
    });

    it("matches the compound-head fallback 'prästost' -> 'ost'", () => {
      expect(matchIngredient("prästost", catalog)).toEqual({
        id: idFor("ost"),
        score: 0.7,
      });
    });

    it("matches a bare generic term now that the catalog carries it ('grädde')", () => {
      // The catalog used to have only compounds ("vispgrädde",
      // "matlagningsgrädde") and no plain "grädde" — fixed in seed data
      // rather than in the matcher, since a bare "grädde" is a real,
      // distinct purchase and shouldn't fall back to picking one compound
      // over the other.
      expect(matchIngredient("grädde", catalog)).toEqual({ id: idFor("grädde"), score: 1.0 });
    });

    it("returns null for a wildly different ingredient (saffran vs. kanel)", () => {
      expect(matchIngredient("saffran", [{ id: idFor("kanel"), nameNorm: normalizeName("kanel") }])).toBeNull();
    });
  });
});

describe("buildMatchCandidates: aliases", () => {
  // A merge tombstones the merged-away vara and keeps its word as an alias, so
  // recipe lines written before the merge keep resolving. The matcher needs no
  // say in this: it already takes a candidate *list*, so one candidate per
  // name-or-alias is all the expansion there is.
  const MERGED_AWAY = "köttfärs";
  const SURVIVOR = "nötfärs";

  /** The catalog as it looks after `merge_catalog_items(köttfärs → nötfärs)`. */
  const afterMerge: MatchCandidate[] = catalog.filter((c) => c.id !== idFor(MERGED_AWAY));
  const aliasRow = { itemId: idFor(SURVIVOR), aliasNorm: normalizeName(MERGED_AWAY) };

  it("returns the items unchanged when there are no aliases", () => {
    expect(buildMatchCandidates(afterMerge)).toEqual(afterMerge);
  });

  it("contributes one candidate per alias, pointing at the surviving item", () => {
    const candidates = buildMatchCandidates(afterMerge, [aliasRow]);
    expect(candidates).toHaveLength(afterMerge.length + 1);
    expect(candidates).toContainEqual({ id: idFor(SURVIVOR), nameNorm: normalizeName(MERGED_AWAY) });
  });

  it("the merged-away word stops resolving on its own — this is what the alias repairs", () => {
    // Not a hypothetical: "köttfärs" shares no prefix, compound head or whole
    // word with any surviving catalog name, so the old recipe line goes from a
    // 1.0 match to nothing the moment the merge lands.
    expect(matchIngredient(MERGED_AWAY, catalog)).toEqual({ id: idFor(MERGED_AWAY), score: 1.0 });
    expect(matchIngredient(MERGED_AWAY, afterMerge)).toBeNull();
  });

  it("an old recipe line naming the merged-away vara resolves to the survivor", () => {
    const candidates = buildMatchCandidates(afterMerge, [aliasRow]);
    const parsed = parseIngredientLine(`500 g ${MERGED_AWAY}`);
    expect(matchParsedIngredient(parsed, candidates)).toEqual({
      id: idFor(SURVIVOR),
      score: 1.0,
    });
  });

  it("resolves the alias identically whichever order the rows arrive in", () => {
    const candidates = buildMatchCandidates(afterMerge, [aliasRow]);
    expect(matchIngredient(MERGED_AWAY, [...candidates].reverse())).toEqual({
      id: idFor(SURVIVOR),
      score: 1.0,
    });
  });

  it("does not let an alias outrank a better match on another item", () => {
    // An alias adds a way to reach its own item, it does not promote it: a
    // household that merged "mjölkchoklad" into "chokladkaka" must not find
    // "mjölk" resolving to chocolate on the strength of a prefix.
    const candidates = buildMatchCandidates(catalog, [
      { itemId: idFor("chokladkaka"), aliasNorm: normalizeName("mjölkchoklad") },
    ]);
    expect(matchIngredient("mjölk", candidates)).toEqual({ id: idFor("mjölk"), score: 1.0 });
  });
});

describe("matchIngredient: deterministic tie-break", () => {
  // The candidate list comes from a `select` with no ORDER BY, so its order is
  // Postgres' business — it can differ between two devices holding identical
  // rows, and after a VACUUM it can differ between two calls on one device. A
  // tie broken by array position is therefore a match that depends on
  // something no device can observe or agree on, which is exactly what this
  // codebase exists to rule out. These queries tie on the real seeded catalog.
  const ORDERS: Array<{ label: string; of: (c: MatchCandidate[]) => MatchCandidate[] }> = [
    { label: "as seeded", of: (c) => c },
    { label: "reversed", of: (c) => [...c].reverse() },
    {
      label: "sorted by name",
      of: (c) => [...c].sort((a, b) => a.nameNorm.localeCompare(b.nameNorm)),
    },
    {
      label: "sorted by name, descending",
      of: (c) => [...c].sort((a, b) => b.nameNorm.localeCompare(a.nameNorm)),
    },
  ];

  // Each query prefix-matches two real items of *identical* name length, so
  // neither the score nor the shorter-name rule can separate them.
  const TIED_QUERIES: Array<{ query: string; winner: string; loser: string }> = [
    { query: "havre", winner: "havregryn", loser: "havremjöl" },
    { query: "wiener", winner: "wienerbröd", loser: "wienerkorv" },
    { query: "disk", winner: "diskmedel", loser: "disksvamp" },
  ];

  it.each(TIED_QUERIES)("'$query' really is a tie: $winner vs $loser", ({ query, winner, loser }) => {
    const both = [winner, loser].map((n) =>
      matchIngredient(query, [{ id: idFor(n), nameNorm: normalizeName(n) }]),
    );
    expect(both[0]?.score).toBe(both[1]?.score);
    expect(normalizeName(winner).length).toBe(normalizeName(loser).length);
  });

  it.each(TIED_QUERIES)("'$query' resolves to $winner in every order", ({ query, winner }) => {
    for (const order of ORDERS) {
      expect(matchIngredient(query, order.of(catalog)), order.label).toEqual({
        id: idFor(winner),
        score: 0.8,
      });
    }
  });

  it("is stable across every permutation of a three-way tie", () => {
    // Three names of equal length, all prefixed by the query: score and length
    // are exhausted, so only the id can decide. All six orderings must agree.
    const tied: MatchCandidate[] = [
      { id: "c-item", nameNorm: "sockerlag" },
      { id: "a-item", nameNorm: "sockerbit" },
      { id: "b-item", nameNorm: "sockerark" },
    ];
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const p of permutations) {
      expect(matchIngredient("socker", p.map((i) => tied[i]!)), p.join("")).toEqual({
        id: "a-item",
        score: 0.8,
      });
    }
  });

  it("still prefers the shorter catalog name before falling back to the id", () => {
    // The id rule is a last resort, not a replacement: a shorter (more
    // generic) name still wins even when its id sorts later.
    const c: MatchCandidate[] = [
      { id: "aaa", nameNorm: "mjolkchokladdryck" },
      { id: "zzz", nameNorm: "mjolk" },
    ];
    expect(matchIngredient("mjolkchoklad", c)).toEqual({ id: "zzz", score: 0.8 });
  });
});

describe("parseIngredientLine: nameWithPreparation", () => {
  it("equals name when there is no preparation word", () => {
    const parsed = parseIngredientLine("2 dl vispgrädde");
    expect(parsed.nameWithPreparation).toBe("vispgrädde");
    expect(parsed.nameWithPreparation).toBe(parsed.name);
  });

  it("keeps the preparation word that `name` strips", () => {
    const parsed = parseIngredientLine("1 msk finhackad persilja");
    expect(parsed.nameWithPreparation).toBe("finhackad persilja");
    expect(parsed.name).toBe("persilja");
  });
});

describe("matchParsedIngredient", () => {
  // Some catalog names genuinely ARE preparation-word + noun. matchIngredient
  // on the fully-stripped `name` alone would miss these, since "dill" and
  // "basilika" and "skinka" (plain) either don't exist or point to the wrong
  // item. Trying `nameWithPreparation` first catches the real entry.
  it("matches 'torkad dill' via the pre-strip name ('dill' alone isn't in the catalog)", () => {
    const parsed = parseIngredientLine("1 tsk torkad dill");
    expect(parsed.name).toBe("dill");
    expect(parsed.nameWithPreparation).toBe("torkad dill");
    expect(matchIngredient(parsed.name, catalog)).toBeNull();
    expect(matchParsedIngredient(parsed, catalog)).toEqual({
      id: idFor("torkad dill"),
      score: 1.0,
    });
  });

  it("matches 'torkad basilika' via the pre-strip name", () => {
    const parsed = parseIngredientLine("1 tsk torkad basilika");
    expect(parsed.name).toBe("basilika");
    expect(parsed.nameWithPreparation).toBe("torkad basilika");
    expect(matchParsedIngredient(parsed, catalog)).toEqual({
      id: idFor("torkad basilika"),
      score: 1.0,
    });
  });

  it("matches 'kokt skinka' via the pre-strip name, not the plain 'skinka' entry", () => {
    const parsed = parseIngredientLine("100 g kokt skinka");
    expect(parsed.name).toBe("skinka");
    expect(parsed.nameWithPreparation).toBe("kokt skinka");
    // The stripped name alone would match the *different*, plainer "skinka"
    // item — a real product but not the one the recipe asked for.
    expect(matchIngredient(parsed.name, catalog)).toEqual({ id: idFor("skinka"), score: 1.0 });
    expect(matchParsedIngredient(parsed, catalog)).toEqual({
      id: idFor("kokt skinka"),
      score: 1.0,
    });
  });

  it("still prefers the fully-stripped, higher-confidence match in the common case", () => {
    // "finhackad persilja" alone scores only 0.6 (contains "persilja" as a
    // whole word). A naive `match(unstripped) ?? match(stripped)` would stop
    // at that non-null 0.6 result; matchParsedIngredient keeps the better
    // (stripped, exact 1.0) match instead.
    const parsed = parseIngredientLine("1 msk finhackad persilja");
    expect(matchIngredient(parsed.nameWithPreparation, catalog)).toEqual({
      id: idFor("persilja"),
      score: 0.6,
    });
    expect(matchParsedIngredient(parsed, catalog)).toEqual({ id: idFor("persilja"), score: 1.0 });
  });

  it("returns null when neither the raw nor the stripped name matches anything", () => {
    const parsed = parseIngredientLine("2 dl xyzingrediens");
    expect(matchParsedIngredient(parsed, catalog)).toBeNull();
  });
});

describe("autoMapProductName: the 0.8 threshold", () => {
  // Twelve product names of the shape a Swedish scan actually returns, matched
  // against the real seeded catalog. What auto-commits and what queues is the
  // whole decision, so it is spelled out rather than summarised: in buy mode an
  // auto-map writes a purchase, and a wrong one writes it against the wrong
  // vara with nothing on screen to notice.
  const PRODUCTS: Array<{ name: string; autoMapsTo: string | null; queuedBecause?: string }> = [
    { name: "Krossade tomater Garant", autoMapsTo: "krossade tomater" },
    { name: "Vispgrädde 36% Arla", autoMapsTo: "vispgrädde" },
    { name: "Kaffe Gevalia Mellanrost", autoMapsTo: null, queuedBecause: "0.7 -> ost" },
    { name: "Zoégas Skånerost", autoMapsTo: null, queuedBecause: "0.7 -> ost" },
    { name: "Kelda Tomatsoppa", autoMapsTo: null, queuedBecause: "0.7 -> soppa" },
    { name: "Wasa Husman Knäckebröd", autoMapsTo: null, queuedBecause: "0.6 -> knäckebröd" },
    { name: "Felix Ketchup", autoMapsTo: null, queuedBecause: "0.6 -> ketchup" },
    { name: "Scan Falukorv Original", autoMapsTo: null, queuedBecause: "0.6 -> falukorv" },
    { name: "Arla Ko Mellanmjölk 1,5%", autoMapsTo: null, queuedBecause: "0.6 -> mellanmjölk" },
    { name: "Kronägg Frigående ägg", autoMapsTo: null, queuedBecause: "0.6 -> ägg" },
    { name: "Bregott Normalsaltat", autoMapsTo: null, queuedBecause: "no match at all" },
    { name: "Marabou Mjölkchoklad", autoMapsTo: null, queuedBecause: "no match at all" },
  ];

  it.each(PRODUCTS)("$name", ({ name, autoMapsTo }) => {
    const mapped = autoMapProductName(name, catalog);
    expect(mapped?.id ?? null).toBe(autoMapsTo === null ? null : idFor(autoMapsTo));
  });

  it("auto-commits two of twelve and queues ten — the ratio is the design", () => {
    // Ten trips to a review queue is not the threshold failing. A queued
    // product costs one tap later; an auto-mapped wrong one costs a purchase
    // recorded against a vara nobody bought, which then feeds cadence and
    // statistics as if it were true.
    const auto = PRODUCTS.filter((p) => autoMapProductName(p.name, catalog) !== null);
    expect(auto).toHaveLength(2);
  });

  it("never auto-maps on the compound-head tier — this is what 0.8 buys", () => {
    // The named failure: Swedish compounding makes "-rost" end in "ost", so the
    // 0.7 tier confidently maps two different coffees to cheese.
    expect(matchIngredient("Kaffe Gevalia Mellanrost", catalog)).toEqual({
      id: idFor("ost"),
      score: 0.7,
    });
    expect(matchIngredient("Zoégas Skånerost", catalog)).toEqual({ id: idFor("ost"), score: 0.7 });
    expect(autoMapProductName("Kaffe Gevalia Mellanrost", catalog)).toBeNull();
    expect(autoMapProductName("Zoégas Skånerost", catalog)).toBeNull();
    expect(AUTO_MAP_MIN_SCORE).toBe(0.8);
  });
});

describe("end-to-end: real recipe lines", () => {
  const cases: Array<{ line: string; expectedName: string; expectedItem: string; score: number }> = [
    { line: "2 dl vispgrädde", expectedName: "vispgrädde", expectedItem: "vispgrädde", score: 1.0 },
    { line: "1 msk finhackad persilja", expectedName: "persilja", expectedItem: "persilja", score: 1.0 },
    { line: "salt och peppar efter smak", expectedName: "salt", expectedItem: "salt", score: 1.0 },
    {
      line: "1 gul lök, skalad och finhackad",
      expectedName: "gul lök",
      expectedItem: "gul lök",
      score: 1.0,
    },
    {
      line: "1 potatis, skalad och delad",
      expectedName: "potatis",
      expectedItem: "potatis",
      score: 1.0,
    },
    { line: "500 g kycklingfilé", expectedName: "kycklingfilé", expectedItem: "kycklingfilé", score: 1.0 },
    {
      line: "1 burk crème fraiche",
      expectedName: "crème fraiche",
      expectedItem: "crème fraiche",
      score: 1.0,
    },
    { line: "2-3 dl mjölk", expectedName: "mjölk", expectedItem: "mjölk", score: 1.0 },
    { line: "1 msk pressad citron", expectedName: "citron", expectedItem: "citron", score: 1.0 },
    {
      line: "ca 2 dl matlagningsgrädde",
      expectedName: "matlagningsgrädde",
      expectedItem: "matlagningsgrädde",
      score: 1.0,
    },
    { line: "1 1/2 dl havregryn", expectedName: "havregryn", expectedItem: "havregryn", score: 1.0 },
    { line: "½ msk salt", expectedName: "salt", expectedItem: "salt", score: 1.0 },
    {
      line: "2 msk smör (ca 200 g)",
      expectedName: "smör",
      expectedItem: "smör",
      score: 1.0,
    },
  ];

  it.each(cases)("$line -> $expectedItem", ({ line, expectedName, expectedItem, score }) => {
    const parsed = parseIngredientLine(line);
    expect(parsed.name).toBe(expectedName);

    const match = matchIngredient(parsed.name, catalog);
    expect(match).toEqual({ id: idFor(expectedItem), score });
  });

  it("50 g riven prästost -> matches 'ost' via compound-head fallback", () => {
    const parsed = parseIngredientLine("50 g riven prästost");
    expect(parsed.name).toBe("prästost");
    expect(matchIngredient(parsed.name, catalog)).toEqual({ id: idFor("ost"), score: 0.7 });
  });

  it("3 dl grädde -> matches the now-seeded generic 'grädde' item", () => {
    const parsed = parseIngredientLine("3 dl grädde");
    expect(parsed.name).toBe("grädde");
    expect(matchIngredient(parsed.name, catalog)).toEqual({ id: idFor("grädde"), score: 1.0 });
  });
});
