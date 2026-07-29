import { randomUUID } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { catalogItems, recipeIngredients, recipes } from "@/db/schema";
import { matchParsedIngredient, parseIngredientLine, type MatchCandidate } from "@/lib/ingredients";
import { importRecipeFromUrl } from "@/lib/recipes";
import type { Unit } from "@/lib/domain";
import type { ApiEnv } from "..";
import {
  errorSchema,
  jsonBody,
  jsonRes,
  recipeImportRequestSchema,
  recipeSchema,
  recipeSummarySchema,
} from "../schemas";

const idParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

function toAmount(value: number | null, unit: string | null) {
  return value !== null && unit !== null ? { value, unit: unit as Unit } : null;
}

export function recipesRoutes() {
  const app = new OpenAPIHono<ApiEnv>();

  app.openapi(
    createRoute({
      method: "post",
      path: "/import",
      tags: ["recipes"],
      description:
        "Import a recipe from a URL (schema.org/Recipe JSON-LD, with an LLM fallback) and persist it. Each ingredient line is parsed (amount + cleaned name, with and without preparation words) via src/lib/ingredients, then fuzzy-matched against the household catalog; a confident match (score >= 0.5) sets catalogItemId, otherwise it comes back null and the add-to-list sheet shows it as NY VARA.",
      request: { body: jsonBody(recipeImportRequestSchema) },
      responses: {
        200: jsonRes(recipeSchema, "Imported recipe"),
        400: jsonRes(errorSchema, "Import failed"),
      },
    }),
    async (c) => {
      const { url } = c.req.valid("json");
      const actor = c.get("actor");

      let imported: Awaited<ReturnType<typeof importRecipeFromUrl>>;
      try {
        imported = await importRecipeFromUrl(url);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Import failed" },
          400,
        );
      }

      // The matcher assumes pre-normalized candidate names — it reads
      // name_norm straight off the row rather than re-normalizing `name`
      // itself, since that is exactly the column search already relies on.
      const candidates: MatchCandidate[] = (
        await db.select({ id: catalogItems.id, nameNorm: catalogItems.nameNorm }).from(catalogItems)
      ).map((c) => ({ id: c.id, nameNorm: c.nameNorm }));

      const recipeId = randomUUID();
      const ingredientRows = imported.ingredientLines.map((line, position) => {
        const parsed = parseIngredientLine(line);
        const match = matchParsedIngredient(parsed, candidates);
        return {
          id: randomUUID(),
          position,
          rawText: line,
          amountValue: parsed.amount?.value ?? null,
          amountUnit: parsed.amount?.unit ?? null,
          catalogItemId: match?.id ?? null,
        };
      });

      await db.transaction(async (tx) => {
        await tx.insert(recipes).values({
          id: recipeId,
          title: imported.title,
          sourceUrl: imported.sourceUrl,
          servings: imported.servings,
          servingsUnit: imported.servingsUnit,
          imageUrl: imported.imageUrl,
          createdBy: actor,
          updatedBy: actor,
        });
        if (ingredientRows.length > 0) {
          await tx.insert(recipeIngredients).values(
            ingredientRows.map((r) => ({
              id: r.id,
              recipeId,
              position: r.position,
              rawText: r.rawText,
              amountValue: r.amountValue,
              amountUnit: r.amountUnit,
              catalogItemId: r.catalogItemId,
            })),
          );
        }
      });

      return c.json(
        {
          id: recipeId,
          title: imported.title,
          sourceUrl: imported.sourceUrl,
          servings: imported.servings,
          servingsUnit: imported.servingsUnit,
          imageUrl: imported.imageUrl,
          ingredients: ingredientRows.map((r) => ({
            id: r.id,
            recipeId,
            position: r.position,
            rawText: r.rawText,
            amount: toAmount(r.amountValue, r.amountUnit),
            catalogItemId: r.catalogItemId,
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["recipes"],
      description: "All recipes, newest first, for the recipe browse screen.",
      responses: { 200: jsonRes(recipeSummarySchema.array(), "Recipes") },
    }),
    async (c) => {
      const [rows, countRows] = await Promise.all([
        db
          .select({
            id: recipes.id,
            title: recipes.title,
            imageUrl: recipes.imageUrl,
            servings: recipes.servings,
            servingsUnit: recipes.servingsUnit,
            sourceUrl: recipes.sourceUrl,
          })
          .from(recipes)
          .where(isNull(recipes.deletedAt))
          .orderBy(desc(recipes.createdAt)),
        db
          .select({ recipeId: recipeIngredients.recipeId, count: count(recipeIngredients.id) })
          .from(recipeIngredients)
          .groupBy(recipeIngredients.recipeId),
      ]);

      const counts = new Map(countRows.map((r) => [r.recipeId, r.count]));
      return c.json(
        rows.map((r) => ({ ...r, ingredientCount: counts.get(r.id) ?? 0 })),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags: ["recipes"],
      description: "One recipe with its ingredients, in position order.",
      request: { params: idParam },
      responses: {
        200: jsonRes(recipeSchema, "Recipe"),
        404: jsonRes(errorSchema, "Not found"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");

      const [recipeRow] = await db
        .select()
        .from(recipes)
        .where(and(eq(recipes.id, id), isNull(recipes.deletedAt)))
        .limit(1);
      if (!recipeRow) return c.json({ error: "Not found" }, 404);

      const ingredientRows = await db
        .select()
        .from(recipeIngredients)
        .where(eq(recipeIngredients.recipeId, id))
        .orderBy(asc(recipeIngredients.position));

      return c.json(
        {
          id: recipeRow.id,
          title: recipeRow.title,
          sourceUrl: recipeRow.sourceUrl,
          servings: recipeRow.servings,
          servingsUnit: recipeRow.servingsUnit,
          imageUrl: recipeRow.imageUrl,
          ingredients: ingredientRows.map((r) => ({
            id: r.id,
            recipeId: r.recipeId,
            position: r.position,
            rawText: r.rawText,
            amount: toAmount(r.amountValue, r.amountUnit),
            catalogItemId: r.catalogItemId,
          })),
        },
        200,
      );
    },
  );

  return app;
}
