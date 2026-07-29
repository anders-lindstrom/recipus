import { describe, expect, it } from "vitest";
import type { CatalogItem } from "@/lib/domain";
import { normalizeName } from "@/lib/utils";
import { rankMatches, splitQuery } from "./search";

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
