import { describe, expect, it } from "vitest";
import { parseIngredientLine } from "@/lib/ingredients";
import { cleanPastedIngredients } from "./paste";

describe("cleanPastedIngredients", () => {
  it("keeps one line per ingredient, verbatim", () => {
    expect(cleanPastedIngredients("3 dl mjöl\n6 dl mjölk\n3 ägg")).toEqual([
      "3 dl mjöl",
      "6 dl mjölk",
      "3 ägg",
    ]);
  });

  it("drops blank lines and the padding around a line", () => {
    expect(cleanPastedIngredients("\n  2 dl grädde  \n\n\n 1 krm salt\n\n")).toEqual([
      "2 dl grädde",
      "1 krm salt",
    ]);
  });

  it("strips list markers", () => {
    expect(cleanPastedIngredients("- 2 ägg\n• 1 dl socker\n* 100 g smör\n– 1 tsk salt")).toEqual([
      "2 ägg",
      "1 dl socker",
      "100 g smör",
      "1 tsk salt",
    ]);
  });

  /**
   * The rule this module exists for as much as any other.
   *
   * A copy off a web page routinely puts a non-breaking space between the
   * number and the unit, and the quantity parser looks for an ordinary one —
   * so without the collapse the amount is silently lost and "2 dl grädde"
   * arrives on the shopping list as an ingredient literally named "2 dl
   * grädde", with no quantity to scale. Asserted through the real parser
   * rather than on the string, because the string is not the point.
   */
  it("normalises the non-breaking spaces a web copy leaves behind", () => {
    const [line] = cleanPastedIngredients("2 dl vispgrädde");
    expect(line).toBe("2 dl vispgrädde");
    expect(parseIngredientLine(line!).amount).toEqual({ value: 2, unit: "dl" });
  });

  it("collapses tabs and runs of spaces inside a line", () => {
    expect(cleanPastedIngredients("400\tg pasta")).toEqual(["400 g pasta"]);
  });

  it("drops group headings, which always end in a colon", () => {
    expect(
      cleanPastedIngredients("Deg:\n3 dl mjöl\nTill servering:\n1 dl grädde"),
    ).toEqual(["3 dl mjöl", "1 dl grädde"]);
  });

  it("drops the bare headings written without one", () => {
    expect(
      cleanPastedIngredients("Ingredienser\n2 ägg\nGör så här\n1 dl mjölk"),
    ).toEqual(["2 ägg", "1 dl mjölk"]);
  });

  it("drops a line that is only a serving count", () => {
    expect(cleanPastedIngredients("4 portioner\n2 ägg")).toEqual(["2 ägg"]);
    expect(cleanPastedIngredients("ca 6-8 bitar\n2 ägg")).toEqual(["2 ägg"]);
  });

  /**
   * The serving-count rule has to be narrow. "2 dl portvin" opens the same way
   * a serving count does, and dropping it would take an ingredient off the
   * list without saying so — which is the failure this whole module is written
   * to avoid.
   */
  it("keeps an ingredient that merely starts like a serving count", () => {
    expect(cleanPastedIngredients("2 dl portvin\n6 bitar smör\n4 personer")).toEqual([
      "2 dl portvin",
      "6 bitar smör",
    ]);
  });

  it("returns nothing for text with no ingredients in it", () => {
    expect(cleanPastedIngredients("   \n\n Ingredienser: \n")).toEqual([]);
  });

  it("stops at a ceiling, so a pasted article cannot become a recipe", () => {
    const text = Array.from({ length: 500 }, (_, i) => `${i + 1} dl vatten`).join("\n");
    expect(cleanPastedIngredients(text)).toHaveLength(200);
  });

  it("leaves a line the ingredient parser can read end to end", () => {
    const lines = cleanPastedIngredients("Ingredienser:\n-  400 g  pasta\n- 2 dl grädde");
    expect(lines).toEqual(["400 g pasta", "2 dl grädde"]);
    expect(lines.map((l) => parseIngredientLine(l).name)).toEqual(["pasta", "grädde"]);
  });
});
