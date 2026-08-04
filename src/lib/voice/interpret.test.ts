import { describe, expect, it } from "vitest";
import { interpretUtterance } from "./interpret";

/**
 * Reading a sentence as a shopping list.
 *
 * The cases here are the ones that come out of a real kitchen rather than out
 * of a spec: several things in one breath, a quantity in either position, a
 * politeness the parser has to ignore, and — the one that matters most — an
 * utterance that means nothing, which must come back empty rather than as a
 * vara nobody asked for. A voice assistant that confirms an add it did not make
 * is worse than one that admits it did not understand, because the list is only
 * checked in the shop.
 */
describe("interpretUtterance", () => {
  const names = (raw: string) => interpretUtterance(raw).map((i) => i.name);

  describe("carrier phrases", () => {
    it("strips a Swedish instruction", () => {
      expect(names("lägg till mjölk")).toEqual(["mjölk"]);
    });

    it("strips an English one", () => {
      expect(names("add milk")).toEqual(["milk"]);
    });

    it("strips the list named at the end", () => {
      expect(names("add milk to the shopping list")).toEqual(["milk"]);
      expect(names("lägg till mjölk på inköpslistan")).toEqual(["mjölk"]);
    });

    it("strips politeness at both ends at once", () => {
      expect(names("kan du lägga till mjölk på inköpslistan")).toEqual(["mjölk"]);
      expect(names("could you please add milk to my shopping list")).toEqual(["milk"]);
    });

    it("strips two stacked prefixes", () => {
      expect(names("jag behöver köpa mjölk")).toEqual(["mjölk"]);
    });

    it("does not eat a word that merely starts with a carrier", () => {
      // "add" is a prefix of "addera" and, more to the point, four characters
      // from "ägg" — well inside the fuzzy budget for a query that long. A
      // carrier stripped without its trailing space would hand the matcher a
      // fragment and it would confidently resolve it.
      expect(names("addera")).toEqual(["addera"]);
      expect(names("köttfärs")).toEqual(["köttfärs"]);
    });

    it("ignores a trailing full stop from the transcriber", () => {
      // Whisper punctuates. Alexa does not. Both have to arrive at the same
      // vara, or the same sentence works on one speaker and not the other.
      expect(names("lägg till mjölk.")).toEqual(["mjölk"]);
    });
  });

  describe("several things in one breath", () => {
    it("splits on och", () => {
      expect(names("lägg till salt och peppar")).toEqual(["salt", "peppar"]);
    });

    it("splits on and", () => {
      expect(names("add milk and bread")).toEqual(["milk", "bread"]);
    });

    it("splits a comma-separated run with a conjunction at the end", () => {
      // How anyone actually dictates a list. `resolvePair` next door reads only
      // a bare PAIR, so everything past the second item used to be lost.
      expect(names("add milk, bread, butter and eggs")).toEqual([
        "milk",
        "bread",
        "butter",
        "eggs",
      ]);
    });

    it("survives a trailing conjunction", () => {
      expect(names("mjölk och")).toEqual(["mjölk"]);
    });

    it("survives doubled separators", () => {
      expect(names("milk,,bread")).toEqual(["milk", "bread"]);
    });
  });

  describe("quantities", () => {
    it("takes a leading quantity", () => {
      expect(interpretUtterance("lägg till 2 l mjölk")).toEqual([
        { name: "mjölk", amount: { value: 2, unit: "l" }, said: "2 l mjölk" },
      ]);
    });

    it("takes a trailing quantity", () => {
      // People say it both ways, and the add bar already understands both. One
      // implementation of "2 l" in the codebase.
      expect(interpretUtterance("mjölk 2 l")).toEqual([
        { name: "mjölk", amount: { value: 2, unit: "l" }, said: "mjölk 2 l" },
      ]);
    });

    it("reads en/ett as one of something", () => {
      expect(interpretUtterance("lägg till en gurka")[0]).toMatchObject({
        name: "gurka",
        amount: { value: 1, unit: "st" },
      });
    });

    it("gives each half of a pair its own quantity", () => {
      expect(interpretUtterance("add 1 kg potatis and 2 l mjölk")).toEqual([
        { name: "potatis", amount: { value: 1, unit: "kg" }, said: "1 kg potatis" },
        { name: "mjölk", amount: { value: 2, unit: "l" }, said: "2 l mjölk" },
      ]);
    });

    it("leaves an unqualified thing unqualified", () => {
      // Null is "some, unspecified", which is the right answer for bread and
      // the wrong place to invent a 1.
      expect(interpretUtterance("bröd")[0]).toMatchObject({ name: "bröd", amount: null });
    });
  });

  describe("nothing to add", () => {
    it("returns empty for silence", () => {
      expect(interpretUtterance("")).toEqual([]);
      expect(interpretUtterance("   ")).toEqual([]);
    });

    it("returns empty for pure carrier phrase", () => {
      // The caller must say "I didn't catch that" rather than confirm an add it
      // did not make. A list is only checked in the shop, so a false
      // confirmation is discovered at exactly the wrong moment.
      expect(interpretUtterance("lägg till")).toEqual([]);
      expect(interpretUtterance("add to the shopping list")).toEqual([]);
    });
  });

  describe("what was heard is kept", () => {
    it("carries the words back verbatim for repeating", () => {
      // `said` is what gets read back when nothing matches, and what a review
      // queue would show. It must not be the normalized or de-quantified form.
      const [item] = interpretUtterance("lägg till 3 st mogna bananer");
      expect(item.said).toBe("3 st mogna bananer");
      expect(item.name).toBe("mogna bananer");
    });
  });
});

/**
 * The two defects the live smoke test found, which no unit test had predicted.
 *
 * Both came from running a real sentence at a real database rather than at a
 * fixture, and both were silent: one put the wrong unit on the list, the other
 * invented an item out of the assistant's own name.
 */
describe("what the smoke test caught", () => {
  it("does not make the assistant's name a grocery", () => {
    // SEPARATORS splits on commas, so "Alexa, add ..." became two items and the
    // first was reported back as something the shop does not sell.
    expect(interpretUtterance("Alexa, add 2 litres of milk").map((i) => i.name)).toEqual([
      "milk",
    ]);
    expect(interpretUtterance("hey google, add milk").map((i) => i.name)).toEqual(["milk"]);
  });

  it("reads English units as units, not as a count", () => {
    // "2 st mjölk" is two PIECES of milk. It parsed the bare number and threw
    // the unit away, which reads as a plausible amount and is not one.
    expect(interpretUtterance("add 2 litres of milk")[0]).toMatchObject({
      name: "milk",
      amount: { value: 2, unit: "l" },
    });
    expect(interpretUtterance("add 500 grams of butter")[0]).toMatchObject({
      amount: { value: 500, unit: "g" },
    });
    expect(interpretUtterance("add 2 kilos of potatoes")[0]).toMatchObject({
      amount: { value: 2, unit: "kg" },
    });
    expect(interpretUtterance("add 3 cans of tomatoes")[0]).toMatchObject({
      amount: { value: 3, unit: "burk" },
    });
  });

  it("consumes the 'of' that follows a unit", () => {
    // Otherwise splitQuery reads "of milk" as the vara.
    expect(interpretUtterance("add 2 litres of milk")[0]!.name).toBe("milk");
  });

  it("leaves a unit word alone when no number precedes it", () => {
    // The rule that keeps this from mangling names: "canned tomatoes" and
    // "bagels" must survive untouched.
    expect(interpretUtterance("add canned tomatoes")[0]!.name).toBe("canned tomatoes");
    expect(interpretUtterance("add bagels")[0]!.name).toBe("bagels");
    expect(interpretUtterance("add a box grater")[0]!.name).toBe("a box grater");
  });

  it("still reads Swedish units the way it always did", () => {
    expect(interpretUtterance("lägg till 2 l mjölk")[0]).toMatchObject({
      amount: { value: 2, unit: "l" },
    });
  });
});
