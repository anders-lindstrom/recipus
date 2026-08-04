import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractJsonLdRecipe } from "./jsonld";

const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf-8");
}

/** Wraps a JSON-LD payload (defaulting @type to "Recipe") in a minimal page. */
function wrap(recipe: Record<string, unknown>, baseUrl = "https://example.com"): string {
  const payload = { "@context": "https://schema.org", "@type": "Recipe", ...recipe };
  return `<html><head><base href="${baseUrl}"><script type="application/ld+json">${JSON.stringify(
    payload,
  )}</script></head><body></body></html>`;
}

describe("extractJsonLdRecipe", () => {
  it("parses a bare Recipe object", () => {
    const html = loadFixture("plain-recipe.html");
    const recipe = extractJsonLdRecipe(html, "https://example.com/recept/kanelbullar");

    expect(recipe).not.toBeNull();
    expect(recipe?.title).toBe("Kanelbullar");
    expect(recipe?.servings).toBe(20);
    expect(recipe?.servingsUnit).toBe("bullar");
    expect(recipe?.imageUrl).toBe("https://example.com/img/kanelbullar.jpg");
    expect(recipe?.ingredientLines).toEqual([
      "5 dl mjölk",
      "50 g jäst",
      "1 dl socker",
      "1 tsk salt",
      "2 tsk kardemumma",
      "150 g smör",
      "1 1/2 kg vetemjöl",
    ]);
    expect(recipe?.sourceUrl).toBe("https://example.com/recept/kanelbullar");
    expect(recipe?.method).toBe("jsonld");
  });

  it("finds the Recipe node inside an @graph wrapper", () => {
    const html = loadFixture("graph.html");
    const recipe = extractJsonLdRecipe(html, "https://example.com/recept/pannkakor");

    expect(recipe?.title).toBe("Pannkakor");
    expect(recipe?.servings).toBe(4);
    expect(recipe?.servingsUnit).toBe("portioner");
    expect(recipe?.imageUrl).toBe("https://example.com/img/pannkakor.jpg");
    expect(recipe?.ingredientLines).toHaveLength(4);
  });

  it("finds the Recipe node inside a top-level array, and accepts a bare-string ingredient list", () => {
    const html = loadFixture("array.html");
    const recipe = extractJsonLdRecipe(html, "https://example.com/recept/kottbullar");

    expect(recipe?.title).toBe("Köttbullar");
    expect(recipe?.servings).toBe(4);
    expect(recipe?.servingsUnit).toBe("portioner");
    expect(recipe?.imageUrl).toBe("https://example.com/img/kottbullar-1.jpg");
    expect(recipe?.ingredientLines).toEqual(["500 g köttfärs"]);
  });

  it("matches when @type is an array of types, decodes entities, and resolves a relative image URL", () => {
    const html = loadFixture("array-type.html");
    const recipe = extractJsonLdRecipe(html, "https://www.koket.se/recept/artsoppa");

    expect(recipe?.title).toBe("Ärtsoppa & fläsklägg");
    expect(recipe?.servings).toBe(6);
    expect(recipe?.servingsUnit).toBe("portioner");
    expect(recipe?.imageUrl).toBe("https://www.koket.se/img/artsoppa.jpg");
  });

  it("skips a malformed JSON-LD block and parses the next one", () => {
    const html = loadFixture("malformed-then-valid.html");
    const recipe = extractJsonLdRecipe(html, "https://example.com/recept/lax");

    expect(recipe?.title).toBe("Lax i ugn");
    expect(recipe?.servings).toBe(2); // "2-3 portioner" -> lower bound
    expect(recipe?.servingsUnit).toBe("portioner");
    expect(recipe?.ingredientLines).toHaveLength(3);
  });

  it("returns null when there is no JSON-LD on the page", () => {
    const html = loadFixture("no-jsonld.html");
    expect(extractJsonLdRecipe(html, "https://example.com/recept/mormor")).toBeNull();
  });

  it("returns null when the Recipe node has no name", () => {
    const html = wrap({ recipeIngredient: ["1 st ägg"] });
    expect(extractJsonLdRecipe(html, "https://example.com")).toBeNull();
  });

  describe("recipeYield parsing", () => {
    it.each([
      ["4 portioner", 4, "portioner"],
      ["6 muffins", 6, "muffins"],
      ["4", 4, "portioner"],
      ["ca 12 bitar", 12, "bitar"],
      ["4-6 portioner", 4, "portioner"],
      ["flera", 4, "portioner"], // unparseable -> documented default
    ] as const)("parses %s -> (%d, %s)", (input, servings, unit) => {
      const html = wrap({ name: "Test", recipeYield: input, recipeIngredient: ["1 st ägg"] });
      const recipe = extractJsonLdRecipe(html, "https://example.com");
      expect(recipe?.servings).toBe(servings);
      expect(recipe?.servingsUnit).toBe(unit);
    });

    it("accepts a bare JSON number", () => {
      const html = wrap({ name: "Test", recipeYield: 8, recipeIngredient: ["1 st ägg"] });
      const recipe = extractJsonLdRecipe(html, "https://example.com");
      expect(recipe?.servings).toBe(8);
      expect(recipe?.servingsUnit).toBe("portioner");
    });

    it("takes the first usable element of an array", () => {
      const html = wrap({
        name: "Test",
        recipeYield: ["6 portioner", "6 servings"],
        recipeIngredient: ["1 st ägg"],
      });
      const recipe = extractJsonLdRecipe(html, "https://example.com");
      expect(recipe?.servings).toBe(6);
      expect(recipe?.servingsUnit).toBe("portioner");
    });

    it("falls back to the default when recipeYield is missing entirely", () => {
      const html = wrap({ name: "Test", recipeIngredient: ["1 st ägg"] });
      const recipe = extractJsonLdRecipe(html, "https://example.com");
      expect(recipe?.servings).toBe(4);
      expect(recipe?.servingsUnit).toBe("portioner");
    });
  });

  describe("image shape variants", () => {
    it("accepts a bare string", () => {
      const html = wrap({
        name: "Test",
        image: "https://example.com/a.jpg",
        recipeIngredient: ["1 st ägg"],
      });
      expect(extractJsonLdRecipe(html, "https://example.com")?.imageUrl).toBe(
        "https://example.com/a.jpg",
      );
    });

    it("accepts an array of strings, taking the first", () => {
      const html = wrap({
        name: "Test",
        image: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
        recipeIngredient: ["1 st ägg"],
      });
      expect(extractJsonLdRecipe(html, "https://example.com")?.imageUrl).toBe(
        "https://example.com/a.jpg",
      );
    });

    it("accepts an ImageObject", () => {
      const html = wrap({
        name: "Test",
        image: { "@type": "ImageObject", url: "https://example.com/a.jpg" },
        recipeIngredient: ["1 st ägg"],
      });
      expect(extractJsonLdRecipe(html, "https://example.com")?.imageUrl).toBe(
        "https://example.com/a.jpg",
      );
    });

    it("accepts an array of ImageObjects", () => {
      const html = wrap({
        name: "Test",
        image: [{ "@type": "ImageObject", url: "https://example.com/a.jpg" }],
        recipeIngredient: ["1 st ägg"],
      });
      expect(extractJsonLdRecipe(html, "https://example.com")?.imageUrl).toBe(
        "https://example.com/a.jpg",
      );
    });

    it("resolves a relative URL against the page URL", () => {
      const html = wrap({ name: "Test", image: "/img/a.jpg", recipeIngredient: ["1 st ägg"] });
      expect(extractJsonLdRecipe(html, "https://www.ica.se/recept/nagot")?.imageUrl).toBe(
        "https://www.ica.se/img/a.jpg",
      );
    });

    it("is null when there is no image", () => {
      const html = wrap({ name: "Test", recipeIngredient: ["1 st ägg"] });
      expect(extractJsonLdRecipe(html, "https://example.com")?.imageUrl).toBeNull();
    });
  });

  describe("entity decoding", () => {
    it("decodes named and numeric entities in the title and ingredient lines", () => {
      const html = wrap({
        name: "S&#228;s &amp; potatis",
        recipeIngredient: ["2 dl gr&auml;dde", "1 st &quot;stor&quot; potatis"],
      });
      const recipe = extractJsonLdRecipe(html, "https://example.com");
      expect(recipe?.title).toBe("Säs & potatis");
      expect(recipe?.ingredientLines).toEqual(['2 dl grädde', '1 st "stor" potatis']);
    });
  });

  describe("ingredient line cleanup", () => {
    it("trims, drops empties, and collapses whitespace", () => {
      const html = wrap({
        name: "Test",
        recipeIngredient: ["  2 dl mjölk  ", "", "   ", "1  st\tägg"],
      });
      const recipe = extractJsonLdRecipe(html, "https://example.com");
      expect(recipe?.ingredientLines).toEqual(["2 dl mjölk", "1 st ägg"]);
    });
  });

  /**
   * `recipeInstructions` is published in four different shapes, and Swedish
   * recipe sites use all four. Getting this wrong is not a crash — it is a
   * recipe screen with an empty method, or one whose first "step" is the word
   * "Sås".
   */
  describe("recipeInstructions shapes", () => {
    const stepsFrom = (recipeInstructions: unknown) =>
      extractJsonLdRecipe(
        wrap({ name: "Test", recipeIngredient: ["1 dl mjölk"], recipeInstructions }),
        "https://example.com",
      )?.instructions;

    it("takes a list of HowToStep objects in order", () => {
      expect(
        stepsFrom([
          { "@type": "HowToStep", text: "Smält smöret." },
          { "@type": "HowToStep", text: "Rör i mjölet." },
        ]),
      ).toEqual(["Smält smöret.", "Rör i mjölet."]);
    });

    it("takes a plain list of strings", () => {
      expect(stepsFrom(["Koka upp.", "Låt svalna."])).toEqual([
        "Koka upp.",
        "Låt svalna.",
      ]);
    });

    it("splits a single string on newlines, and not on full stops", () => {
      // The second line is one step by the author's reckoning. A sentence
      // splitter would cut it in two — and would also cut "ca 1,5 dl" and every
      // abbreviation in the language.
      expect(stepsFrom("Sätt ugnen på 225°.\nHäll i 2 dl grädde. Rör om.")).toEqual([
        "Sätt ugnen på 225°.",
        "Häll i 2 dl grädde. Rör om.",
      ]);
    });

    it("reaches into a HowToSection and drops its heading", () => {
      // "Sås" as a step reads as an instruction to do something to the sauce.
      expect(
        stepsFrom([
          {
            "@type": "HowToSection",
            name: "Sås",
            itemListElement: [
              { "@type": "HowToStep", text: "Fräs löken." },
              { "@type": "HowToStep", text: "Häll i grädden." },
            ],
          },
        ]),
      ).toEqual(["Fräs löken.", "Häll i grädden."]);
    });

    it("decodes entities, collapses whitespace and drops empty steps", () => {
      expect(
        stepsFrom(["  Vispa gr&auml;dden  ", "", "   ", "Sila\tav\nvattnet"]),
      ).toEqual(["Vispa grädden", "Sila av", "vattnet"]);
    });

    it("is empty when the page publishes no method at all", () => {
      expect(stepsFrom(undefined)).toEqual([]);
    });
  });
});
