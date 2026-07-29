import { randomUUID } from "node:crypto";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { db } from "@/db";
import { recipeIngredients, recipes } from "@/db/schema";
import { importRecipeFromUrl } from "@/lib/recipes";
import { parseQuantityPrefix } from "@/lib/units";
import type { ApiEnv } from "..";
import {
  errorSchema,
  jsonBody,
  jsonRes,
  recipeImportRequestSchema,
  recipeSchema,
} from "../schemas";

export function recipesRoutes() {
  const app = new OpenAPIHono<ApiEnv>();

  app.openapi(
    createRoute({
      method: "post",
      path: "/import",
      tags: ["recipes"],
      description:
        'Import a recipe from a URL (schema.org/Recipe JSON-LD, with an LLM fallback) and persist it. Each ingredient line is split into an amount and the rest here, via the same parser the add bar uses — matching that remaining text against the catalog is not done yet (src/lib/ingredients/ has no matcher yet), so every ingredient\'s catalogItemId comes back null. The add-to-list sheet treats null as "NY VARA".',
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

      const recipeId = randomUUID();
      const ingredientRows = imported.ingredientLines.map((line, position) => {
        const { amount } = parseQuantityPrefix(line);
        return {
          id: randomUUID(),
          position,
          rawText: line,
          amountValue: amount?.value ?? null,
          amountUnit: amount?.unit ?? null,
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
              catalogItemId: null,
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
            amount:
              r.amountValue !== null && r.amountUnit !== null
                ? { value: r.amountValue, unit: r.amountUnit }
                : null,
            catalogItemId: null,
          })),
        },
        200,
      );
    },
  );

  return app;
}
