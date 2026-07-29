import { describe, expect, it } from "vitest";
import { CATALOG_ITEMS } from "@/db/seed-data";
import { normalizeName, slugify } from "@/lib/utils";
import {
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
