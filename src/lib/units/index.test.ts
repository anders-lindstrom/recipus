import { describe, expect, it } from "vitest";
import type { Amount } from "@/lib/domain";
import {
  formatAmount,
  formatAmounts,
  fromBase,
  isUnit,
  mergeAmounts,
  parseAmount,
  parseQuantityPrefix,
  scaleAmount,
  toBase,
  unitFamily,
} from "./index";

describe("unitFamily", () => {
  it("classifies volume units", () => {
    for (const unit of ["ml", "krm", "tsk", "msk", "cl", "dl", "l"] as const) {
      expect(unitFamily(unit)).toBe("volume");
    }
  });

  it("classifies mass units", () => {
    for (const unit of ["g", "hg", "kg"] as const) {
      expect(unitFamily(unit)).toBe("mass");
    }
  });

  it("classifies count units", () => {
    for (const unit of ["st", "förp", "burk", "påse", "knippe", "pkt"] as const) {
      expect(unitFamily(unit)).toBe("count");
    }
  });
});

describe("isUnit", () => {
  it("accepts every known unit", () => {
    for (const unit of ["ml", "dl", "l", "g", "kg", "st", "påse", "pkt"]) {
      expect(isUnit(unit)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    for (const s of ["", "dltr", "DL", "kilo", "styck", "msk "]) {
      expect(isUnit(s)).toBe(false);
    }
  });
});

describe("toBase", () => {
  it("converts volume units to ml", () => {
    expect(toBase({ value: 1, unit: "ml" })).toBe(1);
    expect(toBase({ value: 1, unit: "krm" })).toBe(1);
    expect(toBase({ value: 1, unit: "tsk" })).toBe(5);
    expect(toBase({ value: 1, unit: "msk" })).toBe(15);
    expect(toBase({ value: 1, unit: "cl" })).toBe(10);
    expect(toBase({ value: 1, unit: "dl" })).toBe(100);
    expect(toBase({ value: 1, unit: "l" })).toBe(1000);
    expect(toBase({ value: 2.5, unit: "dl" })).toBe(250);
  });

  it("converts mass units to g", () => {
    expect(toBase({ value: 1, unit: "g" })).toBe(1);
    expect(toBase({ value: 1, unit: "hg" })).toBe(100);
    expect(toBase({ value: 1, unit: "kg" })).toBe(1000);
    expect(toBase({ value: 1.5, unit: "kg" })).toBe(1500);
  });

  it("returns the bare value for count units (factor 1, no conversion)", () => {
    expect(toBase({ value: 3, unit: "st" })).toBe(3);
    expect(toBase({ value: 2, unit: "påse" })).toBe(2);
  });
});

describe("fromBase", () => {
  describe("volume display ladder", () => {
    it("stays in ml below 100", () => {
      expect(fromBase(45, "volume")).toEqual({ value: 45, unit: "ml" });
      expect(fromBase(99, "volume")).toEqual({ value: 99, unit: "ml" });
    });

    it("switches to dl at 100", () => {
      expect(fromBase(100, "volume")).toEqual({ value: 1, unit: "dl" });
      expect(fromBase(800, "volume")).toEqual({ value: 8, unit: "dl" });
      expect(fromBase(999, "volume")).toEqual({ value: 9.99, unit: "dl" });
    });

    it("switches to l at 1000", () => {
      expect(fromBase(1000, "volume")).toEqual({ value: 1, unit: "l" });
      expect(fromBase(1200, "volume")).toEqual({ value: 1.2, unit: "l" });
    });
  });

  describe("mass display ladder", () => {
    it("stays in g below 1000", () => {
      expect(fromBase(500, "mass")).toEqual({ value: 500, unit: "g" });
      expect(fromBase(999, "mass")).toEqual({ value: 999, unit: "g" });
    });

    it("switches to kg at 1000", () => {
      expect(fromBase(1000, "mass")).toEqual({ value: 1, unit: "kg" });
      expect(fromBase(1500, "mass")).toEqual({ value: 1.5, unit: "kg" });
    });
  });

  describe("count", () => {
    it("defaults to st", () => {
      expect(fromBase(3, "count")).toEqual({ value: 3, unit: "st" });
    });

    it("honors an explicit countUnit", () => {
      expect(fromBase(2, "count", "påse")).toEqual({ value: 2, unit: "påse" });
    });
  });
});

describe("scaleAmount", () => {
  it("scales by a whole factor", () => {
    expect(scaleAmount({ value: 2, unit: "dl" }, 3)).toEqual({ value: 6, unit: "dl" });
  });

  it("scales by a fractional factor", () => {
    expect(scaleAmount({ value: 1, unit: "dl" }, 0.5)).toEqual({ value: 0.5, unit: "dl" });
    expect(scaleAmount({ value: 2, unit: "dl" }, 1.5)).toEqual({ value: 3, unit: "dl" });
  });

  it("keeps the original unit, no auto-conversion", () => {
    expect(scaleAmount({ value: 800, unit: "ml" }, 2)).toEqual({ value: 1600, unit: "ml" });
  });
});

describe("parseAmount", () => {
  it("parses a number with a space before the unit", () => {
    expect(parseAmount("2 dl")).toEqual({ value: 2, unit: "dl" });
  });

  it("parses a number with no space before the unit", () => {
    expect(parseAmount("2dl")).toEqual({ value: 2, unit: "dl" });
  });

  it("parses decimal comma", () => {
    expect(parseAmount("1,5 dl")).toEqual({ value: 1.5, unit: "dl" });
  });

  it("parses decimal point", () => {
    expect(parseAmount("1.5 dl")).toEqual({ value: 1.5, unit: "dl" });
  });

  it("parses vulgar fractions", () => {
    expect(parseAmount("½ msk")).toEqual({ value: 0.5, unit: "msk" });
    expect(parseAmount("¼ tsk")).toEqual({ value: 0.25, unit: "tsk" });
    expect(parseAmount("¾ dl")).toEqual({ value: 0.75, unit: "dl" });
  });

  it("parses additional vulgar fractions (thirds, eighths)", () => {
    expect(parseAmount("⅓ dl")?.value).toBeCloseTo(1 / 3, 10);
    expect(parseAmount("⅔ dl")?.value).toBeCloseTo(2 / 3, 10);
    expect(parseAmount("⅛ dl")).toEqual({ value: 0.125, unit: "dl" });
  });

  it("parses integer + vulgar fraction as a mixed number", () => {
    expect(parseAmount("1 ½ dl")).toEqual({ value: 1.5, unit: "dl" });
  });

  it("parses ASCII mixed fractions", () => {
    expect(parseAmount("1 1/2 dl")).toEqual({ value: 1.5, unit: "dl" });
  });

  it("parses ASCII simple fractions", () => {
    expect(parseAmount("1/2 dl")).toEqual({ value: 0.5, unit: "dl" });
  });

  it("takes the upper bound of a hyphen range", () => {
    expect(parseAmount("2-3 dl")).toEqual({ value: 3, unit: "dl" });
  });

  it("takes the upper bound of an en-dash range", () => {
    expect(parseAmount("2–3 dl")).toEqual({ value: 3, unit: "dl" });
  });

  it("strips the 'ca' hedge", () => {
    expect(parseAmount("ca 2 dl")).toEqual({ value: 2, unit: "dl" });
  });

  it("strips the 'cirka' hedge", () => {
    expect(parseAmount("cirka 2 dl")).toEqual({ value: 2, unit: "dl" });
  });

  it("strips the 'ungefär' hedge", () => {
    expect(parseAmount("ungefär 2 dl")).toEqual({ value: 2, unit: "dl" });
  });

  it("defaults to st for a bare number", () => {
    expect(parseAmount("3")).toEqual({ value: 3, unit: "st" });
  });

  it("returns null for garbage with no number", () => {
    expect(parseAmount("salt och peppar")).toBeNull();
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("   ")).toBeNull();
  });
});

describe("parseQuantityPrefix", () => {
  it("splits amount and name, no space before unit", () => {
    expect(parseQuantityPrefix("2 dl vispgrädde")).toEqual({
      amount: { value: 2, unit: "dl" },
      rest: "vispgrädde",
    });
  });

  it("does not eat part of the ingredient name", () => {
    expect(parseQuantityPrefix("1 gul lök")).toEqual({
      amount: { value: 1, unit: "st" },
      rest: "gul lök",
    });
  });

  it("treats 'en' as 1 st when followed by more words", () => {
    expect(parseQuantityPrefix("en gul lök")).toEqual({
      amount: { value: 1, unit: "st" },
      rest: "gul lök",
    });
  });

  it("treats 'ett' as 1 st when followed by more words", () => {
    expect(parseQuantityPrefix("ett ägg")).toEqual({
      amount: { value: 1, unit: "st" },
      rest: "ägg",
    });
  });

  it("does not treat a bare 'en' with nothing following as a quantity", () => {
    expect(parseQuantityPrefix("en")).toEqual({ amount: null, rest: "en" });
  });

  it("does not misread a word starting with 'en' as the quantity word", () => {
    expect(parseQuantityPrefix("energisk sak")).toEqual({ amount: null, rest: "energisk sak" });
  });

  it("returns null amount when there is no leading quantity", () => {
    expect(parseQuantityPrefix("salt och peppar")).toEqual({
      amount: null,
      rest: "salt och peppar",
    });
  });

  it("handles a fraction prefix", () => {
    expect(parseQuantityPrefix("1/2 dl mjölk")).toEqual({
      amount: { value: 0.5, unit: "dl" },
      rest: "mjölk",
    });
  });

  it("handles a range prefix, taking the upper bound", () => {
    expect(parseQuantityPrefix("2-3 dl vatten")).toEqual({
      amount: { value: 3, unit: "dl" },
      rest: "vatten",
    });
  });
});

describe("mergeAmounts", () => {
  it("sums within the volume family and renders the cleanest unit", () => {
    expect(mergeAmounts([{ value: 6, unit: "dl" }, { value: 2, unit: "dl" }])).toEqual([
      { value: 8, unit: "dl" },
    ]);
  });

  it("sums mixed volume units via their base ml", () => {
    // 2 dl (200 ml) + 1 msk (15 ml) = 215 ml = 2.15 dl.
    expect(mergeAmounts([{ value: 2, unit: "dl" }, { value: 1, unit: "msk" }])).toEqual([
      { value: 2.15, unit: "dl" },
    ]);
  });

  it("sums within the mass family", () => {
    expect(mergeAmounts([{ value: 500, unit: "g" }, { value: 1, unit: "kg" }])).toEqual([
      { value: 1.5, unit: "kg" },
    ]);
  });

  it("merges identical count units", () => {
    expect(mergeAmounts([{ value: 3, unit: "st" }, { value: 2, unit: "st" }])).toEqual([
      { value: 5, unit: "st" },
    ]);
  });

  it("keeps different count kinds as separate entries", () => {
    const result = mergeAmounts([{ value: 3, unit: "st" }, { value: 2, unit: "påse" }]);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ value: 3, unit: "st" });
    expect(result).toContainEqual({ value: 2, unit: "påse" });
  });

  it("never merges across families (volume + count)", () => {
    const result = mergeAmounts([{ value: 2, unit: "dl" }, { value: 3, unit: "st" }]);
    expect(result).toEqual([
      { value: 2, unit: "dl" },
      { value: 3, unit: "st" },
    ]);
  });

  it("never merges volume with mass (no density assumption)", () => {
    const result = mergeAmounts([{ value: 2, unit: "dl" }, { value: 300, unit: "g" }]);
    expect(result).toEqual([
      { value: 2, unit: "dl" },
      { value: 300, unit: "g" },
    ]);
  });

  it("ignores nulls", () => {
    expect(mergeAmounts([null, { value: 2, unit: "dl" }, null])).toEqual([
      { value: 2, unit: "dl" },
    ]);
  });

  it("returns an empty array for no amounts", () => {
    expect(mergeAmounts([])).toEqual([]);
    expect(mergeAmounts([null, null])).toEqual([]);
  });
});

describe("formatAmount", () => {
  it("formats with a decimal comma", () => {
    expect(formatAmount({ value: 1.2, unit: "l" })).toBe("1,2 l");
  });

  it("strips trailing zeros", () => {
    expect(formatAmount({ value: 8, unit: "dl" })).toBe("8 dl");
    expect(formatAmount({ value: 2, unit: "st" })).toBe("2 st");
  });

  it("caps at two decimals", () => {
    expect(formatAmount({ value: 0.5, unit: "kg" })).toBe("0,5 kg");
    expect(formatAmount({ value: 2.15, unit: "dl" })).toBe("2,15 dl");
  });

  it("never renders a bare decimal point", () => {
    expect(formatAmount({ value: 1.2, unit: "l" })).not.toContain(".");
  });
});

describe("formatAmounts", () => {
  it("joins amounts in stable family order: volume, mass, count", () => {
    const amounts: Amount[] = [
      { value: 3, unit: "st" },
      { value: 500, unit: "g" },
      { value: 8, unit: "dl" },
    ];
    expect(formatAmounts(amounts)).toBe("8 dl + 500 g + 3 st");
  });

  it("formats a single amount with no separator", () => {
    expect(formatAmounts([{ value: 2, unit: "st" }])).toBe("2 st");
  });

  it("formats an empty list as an empty string", () => {
    expect(formatAmounts([])).toBe("");
  });
});
