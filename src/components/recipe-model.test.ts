import { describe, expect, it } from "vitest";
import type { CatalogItem, CatalogItemAlias, Id, RecipeIngredient } from "@/lib/domain";
import { resolveRecipeVaror } from "./recipe-model";

const RECIPE = "recept-1";

function ingredient(
  id: string,
  rawText: string,
  catalogItemId: Id | null = null,
): RecipeIngredient {
  return {
    id,
    recipeId: RECIPE,
    position: 0,
    rawText,
    amount: null,
    catalogItemId,
  };
}

function item(id: string, name = id): CatalogItem {
  return {
    id,
    name,
    nameNorm: name.toLowerCase(),
    categoryId: "ovrigt",
    iconRef: "1F4E6",
    isCustom: true,
    hasAtHome: false,
    hidden: false,
    useCount: 0,
    lastUsedAt: null,
  };
}

function catalogOf(...items: CatalogItem[]): Record<Id, CatalogItem> {
  return Object.fromEntries(items.map((i) => [i.id, i]));
}

function alias(aliasNorm: string, catalogItemId: Id): CatalogItemAlias {
  return {
    aliasNorm,
    catalogItemId,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "anders",
  };
}

/**
 * The question every add-to-list has to answer: which vara does this line mean?
 *
 * Getting it wrong is silent in both directions — a line resolved to the wrong
 * word puts the wrong thing on the list, and a line resolved to a word the
 * household retired brings that word back from the dead.
 */
describe("resolveRecipeVaror", () => {
  it("trusts the id the import already stored", () => {
    const { ingredients, pending } = resolveRecipeVaror(
      [ingredient("i1", "2 dl grädde", "gradde")],
      catalogOf(item("gradde")),
      [],
    );

    expect(ingredients[0].catalogItemId).toBe("gradde");
    expect(pending).toEqual([]);
  });

  it("follows a merged-away word to the vara that survived it", () => {
    // The reported bug, in one assertion. Without this the slug below is
    // re-created, `create_catalog_item` beats the merge's tombstone on clock,
    // and the word the household just retired is back on the list beside the
    // one they merged it into.
    const { ingredients, pending } = resolveRecipeVaror(
      [ingredient("i1", "1200 g kycklingbröstfilé")],
      catalogOf(item("kycklingfile", "Kycklingfilé")),
      [alias("kycklingbrostfile", "kycklingfile")],
    );

    expect(ingredients[0].catalogItemId).toBe("kycklingfile");
    expect(pending).toEqual([]);
  });

  it("ignores an alias whose survivor has since been deleted", () => {
    // An alias outlives a later delete. Following one onto a tombstone would
    // trade the resurrection for an entry nothing can name — the orphan tile.
    const { ingredients, pending } = resolveRecipeVaror(
      [ingredient("i1", "1200 g kycklingbröstfilé")],
      catalogOf(),
      [alias("kycklingbrostfile", "kycklingfile")],
    );

    expect(ingredients[0].catalogItemId).toBe("kycklingbrostfile");
    expect(pending).toEqual([{ id: "kycklingbrostfile", name: "kycklingbröstfilé" }]);
  });

  it("reuses a vara the name already slugs onto rather than re-creating it", () => {
    // `create_catalog_item` REPLACES the row when it wins on clock, so a
    // re-create resets an aisle, an icon and a hidden flag somebody chose.
    const filed = { ...item("purjolok", "Purjolök"), categoryId: "frukt-gront" };
    const { ingredients, pending } = resolveRecipeVaror(
      [ingredient("i1", "1 st purjolök")],
      catalogOf(filed),
      [],
    );

    expect(ingredients[0].catalogItemId).toBe("purjolok");
    expect(pending).toEqual([]);
  });

  it("invents one vara for two lines that name the same thing", () => {
    const { ingredients, pending } = resolveRecipeVaror(
      [ingredient("i1", "2 dl havregryn"), ingredient("i2", "1 dl Havregryn")],
      catalogOf(),
      [],
    );

    expect(ingredients.map((i) => i.catalogItemId)).toEqual(["havregryn", "havregryn"]);
    // One create, not two racing ones with the same id.
    expect(pending).toHaveLength(1);
  });

  it("still names something when the line slugs to nothing at all", () => {
    // A null id here is not "no vara", it is an ingredient the confirm handler
    // drops on the floor.
    const { ingredients, pending } = resolveRecipeVaror(
      [ingredient("i1", "🧂")],
      catalogOf(),
      [],
    );

    expect(ingredients[0].catalogItemId).toBe("vara-i1");
    expect(pending).toEqual([{ id: "vara-i1", name: "🧂" }]);
  });
});
