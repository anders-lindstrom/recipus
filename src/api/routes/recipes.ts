import { randomUUID } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { catalogItems, recipeIngredients, recipeSources, recipes } from "@/db/schema";
import { matchParsedIngredient, parseIngredientLine } from "@/lib/ingredients";
import { loadMatchCandidates } from "@/lib/services/match-candidates";
import { cleanPastedIngredients, extractRecipeFromFile, importRecipeFromUrl } from "@/lib/recipes";
import {
  attachSource,
  decodeBase64,
  loadSourceFor,
  saveFileSource,
  SourceGoneError,
  SourceRejectedError,
  SourceStorageError,
  SourceTakenError,
  sourceSummaryFor,
  storeTextSource,
  type SourceSummary,
} from "@/lib/services/recipe-sources";
import type { Unit } from "@/lib/domain";
import type { ApiEnv } from "..";
import {
  errorSchema,
  jsonBody,
  jsonRes,
  recipeImportRequestSchema,
  recipeEditSchema,
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
  /** The method as the source published it. Empty when it published none. */
  instructions: string[];
  sourceUrl: string | null;
}

/**
 * One recipe with its ingredients, or null if it is gone.
 *
 * Lifted out of the GET handler so the import path can answer a duplicate with
 * the recipe that already exists rather than assembling a second, subtly
 * different, copy of the same shape.
 */
async function loadRecipe(id: string) {
  const [recipeRow] = await db
    .select()
    .from(recipes)
    .where(and(eq(recipes.id, id), isNull(recipes.deletedAt)))
    .limit(1);
  if (!recipeRow) return null;

  const ingredientRows = await db
    .select()
    .from(recipeIngredients)
    .where(eq(recipeIngredients.recipeId, id))
    .orderBy(asc(recipeIngredients.position));

  return {
    id: recipeRow.id,
    title: recipeRow.title,
    sourceUrl: recipeRow.sourceUrl,
    servings: recipeRow.servings,
    servingsUnit: recipeRow.servingsUnit,
    imageUrl: recipeRow.imageUrl,
    instructions: recipeRow.instructions,
    notes: recipeRow.notes,
    source: await sourceSummaryFor(id),
    ingredients: ingredientRows.map((r) => ({
      id: r.id,
      recipeId: r.recipeId,
      position: r.position,
      rawText: r.rawText,
      amount: toAmount(r.amountValue, r.amountUnit),
      catalogItemId: r.catalogItemId,
    })),
  };
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
/**
 * What a recipe was read from, when it was not a web page: a draft's file
 * already on disk and recorded (`sourceId`), or pasted text still to be kept.
 */
type PersistSource = { sourceId: string } | { pastedText: string };

/**
 * The pasted text as an original — or, if the disk will not take it, no
 * original. Paste worked before originals existed, and a storage folder left
 * unwritable by a deploy must not take it down with the file import.
 */
async function keepPastedText(text: string, actor: string) {
  try {
    return await storeTextSource(text, actor);
  } catch (err) {
    if (err instanceof SourceStorageError) return null;
    throw err;
  }
}

async function persistRecipe(recipe: RecipeToPersist, actor: string, from?: PersistSource) {
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

  // Disk cannot roll back, so pasted text is written before the transaction;
  // if the transaction then fails, the file is a stray the prune job sweeps.
  const textSource = from && "pastedText" in from ? await keepPastedText(from.pastedText, actor) : null;
  let source: SourceSummary | null = textSource
    ? { kind: textSource.kind, mediaType: textSource.mediaType }
    : null;

  await db.transaction(async (tx) => {
    await tx.insert(recipes).values({
      id: recipeId,
      title: recipe.title,
      sourceUrl: recipe.sourceUrl,
      servings: recipe.servings,
      servingsUnit: recipe.servingsUnit,
      imageUrl: recipe.imageUrl,
      instructions: recipe.instructions,
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
    if (textSource) {
      await tx.insert(recipeSources).values({ ...textSource, recipeId });
    }
    if (from && "sourceId" in from) {
      // Throwing rolls the recipe back with it: a double-tapped "Spara" must
      // not leave a second recipe behind the first.
      const attached = await attachSource(tx, from.sourceId, recipeId, actor);
      if (attached === "gone") throw new SourceGoneError();
      if (attached === "taken") throw new SourceTakenError();
      const [row] = await tx
        .select({ kind: recipeSources.kind, mediaType: recipeSources.mediaType })
        .from(recipeSources)
        .where(eq(recipeSources.id, from.sourceId));
      source = row ?? null;
    }
  });

  return {
    id: recipeId,
    title: recipe.title,
    sourceUrl: recipe.sourceUrl,
    servings: recipe.servings,
    servingsUnit: recipe.servingsUnit,
    imageUrl: recipe.imageUrl,
    instructions: recipe.instructions,
    // A brand-new recipe has no household note by construction: this is the
    // response to the request that created it.
    notes: null,
    source,
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
 * What an add-to-list learned about a recipe's unresolved lines.
 *
 * Kept here rather than in ../schemas for the same reason the paste body below
 * is: it is this route's business and nothing else's. Bounded because a recipe
 * has ingredients, not a database of them.
 */
const ingredientMappingsSchema = z
  .object({
    mappings: z
      .array(
        z.object({
          ingredientId: z.string().min(1),
          catalogItemId: z.string().min(1),
        }),
      )
      .max(200),
  })
  .openapi("RecipeIngredientMappings");

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

/**
 * A file for POST /read-file, base64 like /api/ai/parse's images. The bound on
 * `data` is only there to stop an absurd body early; the real 10 MB check is on
 * the decoded bytes, where it can answer 413 rather than a validation error.
 */
const recipeReadFileRequestSchema = z
  .object({
    data: z.string().min(1).max(20_000_000),
    mediaType: z.string().min(1).max(100),
    fileName: z.string().max(255).optional(),
  })
  .openapi("RecipeReadFileRequest");

const recipeDraftSchema = z
  .object({
    title: z.string(),
    servings: z.number(),
    servingsUnit: z.string(),
    ingredientLines: z.array(z.string()),
    instructions: z.array(z.string()),
  })
  .openapi("RecipeDraft");

const recipeReadFileResponseSchema = z
  .object({ sourceId: z.string(), draft: recipeDraftSchema.nullable() })
  .openapi("RecipeReadFileResponse");

/** The paste path's bounds, plus what a reviewed draft carries besides. */
const recipeFromFileRequestSchema = z
  .object({
    sourceId: z.string().min(1).max(64),
    title: z.string().trim().min(1).max(200),
    servings: z.number().positive().max(999),
    servingsUnit: z.string().trim().min(1).max(40),
    ingredientText: z.string().min(1).max(20_000),
    instructions: z.array(z.string().max(2000)).max(60),
  })
  .openapi("RecipeFromFileRequest");

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

      /*
       * The same URL twice is the same recipe, not two.
       *
       * The share target fires an import the moment the page arrives, so
       * tapping back and re-sharing — which is what anyone does when they are
       * not sure the first one worked — silently stored a second copy. With no
       * delete wired anywhere, both then sit at the top of the only browse
       * surface forever.
       *
       * Answered with the existing recipe rather than an error: the household
       * asked for this recipe and this recipe is what they get. Tombstoned ones
       * are excluded, so re-importing something deliberately deleted works.
       */
      const [existing] = await db
        .select({ id: recipes.id })
        .from(recipes)
        .where(and(eq(recipes.sourceUrl, url), isNull(recipes.deletedAt)))
        .limit(1);
      if (existing) {
        const already = await loadRecipe(existing.id);
        if (already) return c.json(already, 200);
      }

      let imported: Awaited<ReturnType<typeof importRecipeFromUrl>>;
      try {
        imported = await importRecipeFromUrl(url);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Import failed" },
          400,
        );
      }

      /*
       * The same tidying the paste path gets, on the lines a page gave us.
       *
       * `cleanPastedIngredients` was written for pasted text and called from
       * exactly one route, but nothing in it is about pasting: it collapses the
       * non-breaking spaces that hide an amount from `parseQuantityPrefix`,
       * drops bullets, and skips group headings like "Till servering:" and
       * "Deg:". JSON-LD carries all three — plenty of sites put their headings
       * in `recipeIngredient` — so those became ingredient lines, matched
       * nothing, and were offered as NY VARA. Accepting one mints a catalog
       * item called "Till servering" that never goes away.
       *
       * Idempotent, so the paste route keeping its own call costs nothing.
       */
      const ingredientLines = cleanPastedIngredients(
        imported.ingredientLines.join("\n"),
      );

      /*
       * An import that found no ingredients is refused, exactly as the paste
       * path already refuses one — same wording, same status.
       *
       * `buildImportedRecipe` returns on a title alone, so a paywalled or
       * JS-rendered page produced a 200 and a recipe row with nothing in it.
       * That is worse than an error: it looks like it worked, it adds nothing
       * to any list, and until a delete exists it cannot be cleared away.
       *
       * Checked AFTER the tidying above, so a page whose every "ingredient" was
       * a heading is refused too rather than stored as an empty recipe.
       */
      if (ingredientLines.length === 0) {
        return c.json({ error: "Hittade inga ingredienser i texten." }, 400);
      }

      return c.json(
        await persistRecipe({ ...imported, ingredientLines }, actor),
        200,
      );
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
            // Not asked for either, and for a stronger reason than servingsUnit:
            // this path exists because someone selected an INGREDIENT LIST and
            // copied it. Asking them to go back for the method as well would
            // put a second errand in front of the one they came to do, and the
            // editor on the recipe screen is where a method gets typed.
            instructions: [],
            sourceUrl: null,
          },
          actor,
          // Kept as the recipe's original, so "what did I actually paste" has
          // an answer after the tidying has thrown the headings away.
          { pastedText: text },
        ),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/read-file",
      tags: ["recipes"],
      description:
        "Read a recipe out of one photo, screenshot or PDF (image/jpeg, image/png, image/webp, application/pdf; at most 10 MB). The file is stored FIRST and kept whatever happens next, then the shim is asked to read it. Answers the stored file's sourceId and the draft the shim read, or draft null when it could not — the review screen opens either way, beside the original, and nothing is saved as a recipe until POST /from-file.",
      request: { body: jsonBody(recipeReadFileRequestSchema) },
      responses: {
        200: jsonRes(recipeReadFileResponseSchema, "The stored file and what could be read from it"),
        400: jsonRes(errorSchema, "Not a file we keep"),
        413: jsonRes(errorSchema, "Over 10 MB"),
        500: jsonRes(errorSchema, "The file could not be stored"),
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const actor = c.get("actor");

      let saved: { id: string };
      try {
        const bytes = decodeBase64(body.data);
        saved = await saveFileSource({
          bytes,
          mediaType: body.mediaType,
          fileName: body.fileName?.trim() || null,
          actor,
        });
      } catch (err) {
        if (err instanceof SourceRejectedError) return c.json({ error: err.message }, err.status);
        if (err instanceof SourceStorageError) return c.json({ error: err.message }, 500);
        throw err;
      }

      const read = await extractRecipeFromFile({ data: body.data, mediaType: body.mediaType });
      const draft = read
        ? {
            ...read,
            // The same tidying a page import gets: headings like "Deg:" are not
            // ingredients, and the review screen should not offer them as such.
            ingredientLines: cleanPastedIngredients(read.ingredientLines.join("\n")),
          }
        : null;
      return c.json({ sourceId: saved.id, draft }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/from-file",
      tags: ["recipes"],
      description:
        "Save a reviewed draft as a recipe and attach the file it was read from. Ingredients arrive as text, one per line, and go through exactly the same tidy-parse-match as a paste. The source is attached only if it is still unattached and was stored by this actor — a second save of the same draft is a 409 and creates nothing.",
      request: { body: jsonBody(recipeFromFileRequestSchema) },
      responses: {
        200: jsonRes(recipeSchema, "Saved recipe"),
        400: jsonRes(errorSchema, "No ingredients"),
        404: jsonRes(errorSchema, "The draft expired"),
        409: jsonRes(errorSchema, "Saved already"),
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const actor = c.get("actor");

      const ingredientLines = cleanPastedIngredients(body.ingredientText);
      if (ingredientLines.length === 0) {
        return c.json({ error: "Hittade inga ingredienser i texten." }, 400);
      }

      try {
        return c.json(
          await persistRecipe(
            {
              title: body.title,
              servings: body.servings,
              servingsUnit: body.servingsUnit,
              imageUrl: null,
              ingredientLines,
              instructions: body.instructions.map((step) => step.trim()).filter((step) => step.length > 0),
              sourceUrl: null,
            },
            actor,
            { sourceId: body.sourceId },
          ),
          200,
        );
      } catch (err) {
        if (err instanceof SourceTakenError) return c.json({ error: "Receptet är redan sparat." }, 409);
        if (err instanceof SourceGoneError) {
          return c.json({ error: "Utkastet finns inte längre. Välj filen igen." }, 404);
        }
        throw err;
      }
    },
  );

  /*
   * The original, as bytes. A plain route rather than an OpenAPI one because
   * the body is a file, not JSON. Private caching: the file never changes, but
   * it is the household's and must not sit in a shared cache.
   */
  app.get("/:id/source", async (c) => {
    const found = await loadSourceFor(c.req.param("id"));
    if (found === null || found === "missing") return c.json({ error: "Originalet finns inte." }, 404);
    return c.body(new Uint8Array(found.bytes), 200, {
      "Content-Type": found.mediaType,
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=86400",
    });
  });

  app.openapi(
    createRoute({
      method: "patch",
      path: "/{id}/ingredients",
      tags: ["recipes"],
      description:
        "Record which vara each ingredient line ended up meaning, for lines the import could not resolve. Only rows whose catalogItemId is still NULL are filled: a line the household has already mapped — by a later import, by a merge's re-pointing, or by a previous add — is never re-aimed by this, so replaying it is a no-op and a stale client cannot undo a correction.",
      request: { params: idParam, body: jsonBody(ingredientMappingsSchema) },
      responses: {
        200: jsonRes(z.object({ updated: z.number().int() }), "Rows filled in"),
        404: jsonRes(errorSchema, "Not found"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { mappings } = c.req.valid("json");

      const [recipeRow] = await db
        .select({ id: recipes.id })
        .from(recipes)
        .where(and(eq(recipes.id, id), isNull(recipes.deletedAt)))
        .limit(1);
      if (!recipeRow) return c.json({ error: "Not found" }, 404);

      // Varor this row is allowed to point at. `recipe_ingredients` has a
      // foreign key onto `catalog_items`, and the vara a mapping names is
      // usually one the client created moments ago with a `create_catalog_item`
      // op — so a caller that has not flushed its outbox yet, or whose create
      // lost to a concurrent delete, would otherwise turn bookkeeping into a
      // 500. Unknown ids are skipped and counted out instead: the line stays
      // null, which is exactly where it was.
      const known = new Set(
        (
          await db
            .select({ id: catalogItems.id })
            .from(catalogItems)
            .where(
              inArray(
                catalogItems.id,
                mappings.map((m) => m.catalogItemId),
              ),
            )
        ).map((r) => r.id),
      );

      let updated = 0;
      for (const m of mappings) {
        if (!known.has(m.catalogItemId)) continue;
        const rows = await db
          .update(recipeIngredients)
          .set({ catalogItemId: m.catalogItemId })
          .where(
            and(
              eq(recipeIngredients.id, m.ingredientId),
              eq(recipeIngredients.recipeId, id),
              isNull(recipeIngredients.catalogItemId),
            ),
          )
          .returning({ id: recipeIngredients.id });
        updated += rows.length;
      }

      return c.json({ updated }, 200);
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
      method: "patch",
      path: "/{id}",
      tags: ["recipes"],
      description:
        "Edit what a household owns about a recipe: its title, what its quantities are for, the method, and their own note. Every field is optional and an absent one is left alone, so two people editing different halves cannot overwrite each other. `notes: null` clears the note; omitting it does not. Ingredient lines are not editable here — a line points at a vara and that pointer is maintained elsewhere; see PATCH /{id}/ingredients.",
      request: { params: idParam, body: jsonBody(recipeEditSchema) },
      responses: {
        200: jsonRes(recipeSchema, "The recipe as it now stands"),
        404: jsonRes(errorSchema, "Not found"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const edit = c.req.valid("json");
      const actor = c.get("actor");

      /*
       * Straight to the table rather than through the op log, and that is the
       * same boundary every other recipe write already sits on.
       *
       * The op log exists for the SHOPPING LIST: two phones, offline, in
       * different shops, editing the same entry — which is why entries carry
       * per-field clocks and last-write-wins. A recipe is not that. It is
       * imported once, edited rarely, and never while walking round a shop; the
       * whole library is fetched from the server whenever the screen opens, and
       * there is no offline copy of it to reconcile. Import, delete and the
       * ingredient mapping all work this way already, and a recipe edit that
       * went through the log would be the only one that did.
       *
       * The cost is honest and bounded: two people editing the same recipe in
       * the same minute, the second write wins whole fields. Nobody edits a
       * recipe in a shop.
       */
      const [updated] = await db
        .update(recipes)
        .set({
          // Spread rather than assigned, so "not mentioned" and "set to null"
          // stay different things all the way down to the SQL. Drizzle omits an
          // undefined key from the UPDATE; writing `title: edit.title` would
          // send NULL for a request that never mentioned the title.
          ...(edit.title !== undefined ? { title: edit.title } : {}),
          ...(edit.servings !== undefined ? { servings: edit.servings } : {}),
          ...(edit.servingsUnit !== undefined
            ? { servingsUnit: edit.servingsUnit }
            : {}),
          ...(edit.instructions !== undefined
            ? { instructions: edit.instructions }
            : {}),
          // An empty note is no note. The column is nullable so that "nobody
          // wrote one" and "someone cleared one" can differ, but nothing in the
          // app needs to tell them apart, and storing "" would put an empty
          // heading on the screen.
          ...(edit.notes !== undefined
            ? { notes: edit.notes === null || edit.notes === "" ? null : edit.notes }
            : {}),
          updatedAt: new Date(),
          updatedBy: actor,
        })
        .where(and(eq(recipes.id, id), isNull(recipes.deletedAt)))
        .returning({ id: recipes.id });

      if (!updated) return c.json({ error: "Not found" }, 404);

      // Re-read rather than assembled from the patch: the response is what the
      // recipe now IS, including the fields this request said nothing about,
      // and the screen replaces its whole copy with it.
      const recipe = await loadRecipe(id);
      if (!recipe) return c.json({ error: "Not found" }, 404);
      return c.json(recipe, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: ["recipes"],
      description:
        "Retire a recipe. Soft, like every other deletion in this app: recipe_additions on live lists reference it, and the prune job clears tombstones at 30 days.",
      request: { params: idParam },
      responses: {
        204: { description: "Deleted" },
        404: jsonRes(errorSchema, "Not found"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const actor = c.get("actor");

      /*
       * Soft, and not merely by convention.
       *
       * `deletedAt` and the prune job were both built for a delete that was
       * never wired, so the column has been sitting there unwritten while a
       * paywalled half-import stayed at the top of the only browse surface
       * forever. A hard delete is not available even in principle: recipe
       * additions on live lists carry `recipe_id`, and the breakdown sheet
       * resolves a tile's "från recept" badge through it — removing the row
       * would leave contributions pointing at nothing.
       *
       * What this deliberately does NOT do is take the recipe off any list.
       * Its ingredients were added because the household wanted them; retiring
       * the recipe is a statement about the library, not about tonight's
       * shopping. `remove_recipe` is the op that means the other thing, and it
       * goes through the log because it changes a list.
       */
      const [updated] = await db
        .update(recipes)
        .set({ deletedAt: new Date(), updatedAt: new Date(), updatedBy: actor })
        .where(and(eq(recipes.id, id), isNull(recipes.deletedAt)))
        .returning({ id: recipes.id });

      // Already gone reads as 404 rather than 204: deleting twice is a
      // question about a recipe that is not there, and answering "done" would
      // hide a stale link the caller is still following.
      if (!updated) return c.json({ error: "Not found" }, 404);
      return c.body(null, 204);
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
      const recipe = await loadRecipe(id);
      if (!recipe) return c.json({ error: "Not found" }, 404);
      return c.json(recipe, 200);
    },
  );

  return app;
}
