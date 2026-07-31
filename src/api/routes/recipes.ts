import { randomUUID } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recipeIngredients, recipes } from "@/db/schema";
import { matchParsedIngredient, parseIngredientLine } from "@/lib/ingredients";
import { loadMatchCandidates } from "@/lib/services/match-candidates";
import { cleanPastedIngredients, importRecipeFromUrl } from "@/lib/recipes";
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

/**
 * A recipe that has been read out of something, ready to be stored. `sourceUrl`
 * is null for the paste path — there is no page to link back to, and inventing
 * one would put a dead link on the recipe screen forever.
 */
interface RecipeToPersist {
  title: string;
  servings: number;
  servingsUnit: string;
  imageUrl: string | null;
  ingredientLines: string[];
  sourceUrl: string | null;
}

/**
 * Parse, match, store — everything about an import that does not depend on
 * where the text came from.
 *
 * Shared by the URL path and the paste path deliberately. The design spec's
 * promise for recipe input is that all its paths "share one line parser"
 * (§5.6), and the only way to keep that true as paths are added is to have one
 * place where the parsing happens. A second copy would drift the first time
 * either side was tuned, and the symptom — a pasted "2 dl grädde" matching a
 * different vara than an imported one — is nearly impossible to notice.
 */
async function persistRecipe(recipe: RecipeToPersist, actor: string) {
  // Live varor AND every word that reaches one, so an ingredient line
  // written against a word the household has since merged away still
  // resolves — which is the entire point of keeping the merged-away word as
  // an alias. See loadMatchCandidates for why the tombstone filter lives
  // there rather than in the matcher.
  const candidates = await loadMatchCandidates();

  const recipeId = randomUUID();
  const ingredientRows = recipe.ingredientLines.map((line, position) => {
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
      title: recipe.title,
      sourceUrl: recipe.sourceUrl,
      servings: recipe.servings,
      servingsUnit: recipe.servingsUnit,
      imageUrl: recipe.imageUrl,
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

  return {
    id: recipeId,
    title: recipe.title,
    sourceUrl: recipe.sourceUrl,
    servings: recipe.servings,
    servingsUnit: recipe.servingsUnit,
    imageUrl: recipe.imageUrl,
    ingredients: ingredientRows.map((r) => ({
      id: r.id,
      recipeId,
      position: r.position,
      rawText: r.rawText,
      amount: toAmount(r.amountValue, r.amountUnit),
      catalogItemId: r.catalogItemId,
    })),
  };
}

/**
 * Defined here rather than in ../schemas alongside the import request, because
 * nothing outside this route needs it — and the bounds are the interesting
 * part. `text` is a whole pasted ingredient list, so it has to be roomy, but
 * unbounded it is a way to hand the parser an entire website.
 */
const recipePasteRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    servings: z.number().int().positive().max(999),
    text: z.string().min(1).max(20_000),
  })
  .openapi("RecipePasteRequest");

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

      return c.json(await persistRecipe(imported, actor), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/paste",
      tags: ["recipes"],
      description:
        "Store a recipe from pasted ingredient text — the path for pages that publish no JSON-LD and that the LLM fallback cannot read either, where the only thing left is the recipe on the screen the person is looking at. The text is tidied line by line (src/lib/recipes/paste.ts) and then goes through exactly the same parse-and-match as an imported one; the recipe has no sourceUrl, because there is no page to link back to.",
      request: { body: jsonBody(recipePasteRequestSchema) },
      responses: {
        200: jsonRes(recipeSchema, "Saved recipe"),
        400: jsonRes(errorSchema, "Nothing usable in the pasted text"),
      },
    }),
    async (c) => {
      const { title, servings, text } = c.req.valid("json");
      const actor = c.get("actor");

      const ingredientLines = cleanPastedIngredients(text);
      // Refused rather than stored empty. A recipe with no ingredients is
      // silently useless — it adds nothing to a list — and the person who just
      // pasted something has the text right there to correct.
      if (ingredientLines.length === 0) {
        return c.json({ error: "Hittade inga ingredienser i texten." }, 400);
      }

      return c.json(
        await persistRecipe(
          {
            title: title.trim(),
            servings,
            // Not asked for. "portioner" covers almost every recipe, and an
            // extra field between someone and the list they are trying to
            // write is a worse trade than a word they can live with.
            servingsUnit: "portioner",
            imageUrl: null,
            ingredientLines,
            sourceUrl: null,
          },
          actor,
        ),
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
