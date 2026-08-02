import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { catalogItems, recipeIngredients, recipes } from "@/db/schema";
import { recipesRoutes } from "./recipes";

/**
 * The mapping write-back, against the dev database (Postgres on 5434, see .env).
 *
 * What it protects is a chain rather than a field: an ingredient line that
 * knows its vara is a line `repointMergedCatalogItem` can follow when that vara
 * is merged away, and a line that stays null is one every future add re-decides
 * from raw text — which is how a merged-away word came back to life and put
 * itself on the list a second time.
 *
 * Every row here is prefixed `test-recipes-` and removed in `afterAll`.
 */
const PREFIX = `test-recipes-${randomUUID().slice(0, 8)}`;
const app = recipesRoutes();

const madeRecipes: string[] = [];
const madeItems: string[] = [];

async function seedVara(id: string): Promise<string> {
  madeItems.push(id);
  await db.insert(catalogItems).values({
    id,
    name: id,
    nameNorm: id,
    categoryId: "ovrigt",
    iconRef: "1F4E6",
    isCustom: true,
    nameUpdatedBy: PREFIX,
    categoryUpdatedBy: PREFIX,
    iconUpdatedBy: PREFIX,
    homeUpdatedBy: PREFIX,
    hiddenUpdatedBy: PREFIX,
    updatedBy: PREFIX,
  });
  return id;
}

/** A recipe with one unresolved line, exactly as an import that matched nothing leaves it. */
async function seedRecipe(catalogItemId: string | null = null): Promise<{
  recipeId: string;
  ingredientId: string;
}> {
  const recipeId = randomUUID();
  const ingredientId = randomUUID();
  madeRecipes.push(recipeId);

  await db.insert(recipes).values({
    id: recipeId,
    title: `${PREFIX} recept`,
    servings: 4,
    createdBy: PREFIX,
    updatedBy: PREFIX,
  });
  await db.insert(recipeIngredients).values({
    id: ingredientId,
    recipeId,
    position: 0,
    rawText: "1200 g kycklingbröstfilé",
    amountValue: 1200,
    amountUnit: "g",
    catalogItemId,
  });

  return { recipeId, ingredientId };
}

function patch(recipeId: string, mappings: unknown) {
  return app.request(`/${recipeId}/ingredients`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mappings }),
  });
}

async function storedItemId(ingredientId: string): Promise<string | null> {
  const [row] = await db
    .select({ catalogItemId: recipeIngredients.catalogItemId })
    .from(recipeIngredients)
    .where(eq(recipeIngredients.id, ingredientId));
  return row?.catalogItemId ?? null;
}

afterAll(async () => {
  await db.delete(recipeIngredients).where(inArray(recipeIngredients.recipeId, madeRecipes));
  await db.delete(recipes).where(inArray(recipes.id, madeRecipes));
  if (madeItems.length) {
    await db.delete(catalogItems).where(inArray(catalogItems.id, madeItems));
  }
});

describe("PATCH /{id}/ingredients", () => {
  it("fills in a line the import could not place", async () => {
    const vara = await seedVara(`${PREFIX}-kycklingfile`);
    const { recipeId, ingredientId } = await seedRecipe();

    const res = await patch(recipeId, [{ ingredientId, catalogItemId: vara }]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 1 });
    expect(await storedItemId(ingredientId)).toBe(vara);
  });

  it("never re-aims a line that already knows its vara", async () => {
    // The mapping a merge's re-pointing wrote, or a later import's better match.
    // A client that still holds the old answer — an offline phone, a tab left
    // open — must not be able to undo it by adding the recipe again.
    const decided = await seedVara(`${PREFIX}-decided`);
    const other = await seedVara(`${PREFIX}-other`);
    const { recipeId, ingredientId } = await seedRecipe(decided);

    const res = await patch(recipeId, [{ ingredientId, catalogItemId: other }]);

    expect(await res.json()).toEqual({ updated: 0 });
    expect(await storedItemId(ingredientId)).toBe(decided);
  });

  it("skips a vara that does not exist rather than failing the whole call", async () => {
    // `recipe_ingredients` has a foreign key onto `catalog_items`, and the vara
    // a mapping names is usually one the client created moments ago. A create
    // that has not landed — or that lost to a concurrent delete — must leave the
    // line null, not 500 a call the person never asked for.
    const { recipeId, ingredientId } = await seedRecipe();

    const res = await patch(recipeId, [
      { ingredientId, catalogItemId: `${PREFIX}-never-created` },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 0 });
    expect(await storedItemId(ingredientId)).toBeNull();
  });

  it("refuses to write a line into someone else's recipe", async () => {
    const vara = await seedVara(`${PREFIX}-cross`);
    const mine = await seedRecipe();
    const theirs = await seedRecipe();

    const res = await patch(mine.recipeId, [
      { ingredientId: theirs.ingredientId, catalogItemId: vara },
    ]);

    expect(await res.json()).toEqual({ updated: 0 });
    expect(await storedItemId(theirs.ingredientId)).toBeNull();
  });

  it("404s for a recipe that is not there", async () => {
    const res = await patch(randomUUID(), []);
    expect(res.status).toBe(404);
  });
});
