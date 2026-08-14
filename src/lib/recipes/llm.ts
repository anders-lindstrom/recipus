/**
 * LLM recipe extraction: the fallback for pages that don't publish
 * schema.org/Recipe JSON-LD. Only reached when `jsonld.ts` finds nothing. See
 * docs/superpowers/specs/2026-07-29-recipus-design.md §5.6 and
 * docs/superpowers/specs/2026-08-14-claude-shim-design.md.
 *
 * The reading happens on the home server, behind `POST /recipe` on the shim,
 * which holds the Claude Code credential. Nothing here holds a credential of
 * its own beyond the bearer token that gets it through the shim's door.
 *
 * Must never throw and must never require the shim to be configured — a site
 * that already has JSON-LD has to keep importing on a machine that has never
 * heard of the shim, so every failure mode here resolves to `null` and lets the
 * caller (`import.ts`) fall through to its own error.
 */

import { z } from "zod";
import { decodeHtmlEntities, type ImportedRecipe } from "./jsonld";

// Keeps a bloated page from blowing up the request; a recipe's text is never
// anywhere near this long. The trimming stays on this side of the wire: no
// reason to ship 2 MB of markup across the LAN for the shim to throw away.
const MAX_PAGE_TEXT_CHARS = 40_000;

/**
 * How long to wait on the home server before giving up and degrading. Same
 * value as `src/lib/ai-add/parse.ts`'s `SHIM_TIMEOUT_MS`, kept as two copies
 * rather than a shared constant (a shared module for one constant would be
 * its own over-building for two call sites) — if you tune one, tune the
 * other. Below the shim's own internal bound (`ASK_TIMEOUT_MS` in
 * agentic-os's `shim/src/claude.ts`), so this timeout is what a person sees.
 */
const SHIM_TIMEOUT_MS = 60_000;

const DEFAULT_SERVINGS = 4;
const DEFAULT_SERVINGS_UNIT = "portioner";

/**
 * What the shim answers with: the recipe under a `recipe` key, not bare.
 *
 * A copy of the shim's own schema, checked here rather than trusted, because
 * the shim's copy lives in a different repository with a different test suite
 * and nothing but a check like this one stops the two from drifting apart.
 */
const ResponseSchema = z.object({
  recipe: z.object({
    title: z.string(),
    servings: z.number(),
    servingsUnit: z.string(),
    imageUrl: z.string().nullable(),
    ingredientLines: z.array(z.string()),
    instructions: z.array(z.string()),
  }),
});

/** Exported separately so import.ts can be tested without network or shim. */
export async function extractRecipeWithLlm(html: string, url: string): Promise<ImportedRecipe | null> {
  const base = process.env.AI_SHIM_URL;
  const secret = process.env.AI_SHIM_SECRET;
  if (!base || !secret) return null;

  let payload: unknown;
  try {
    const res = await fetch(`${shimBase(base)}/recipe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ html: extractPageText(html), url }),
      signal: AbortSignal.timeout(SHIM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    payload = await res.json();
  } catch {
    return null;
  }

  const parsed = ResponseSchema.safeParse(payload);
  if (!parsed.success) return null;
  const recipe = parsed.data.recipe;

  // The schema already refuses a servings that is not a number — JSON cannot
  // carry NaN, and zod rejects it besides — so what is left to catch here is a
  // number that is a number and still not a count of anything: 0, or negative.
  const servings = Number.isFinite(recipe.servings) && recipe.servings > 0 ? recipe.servings : DEFAULT_SERVINGS;
  const servingsUnit = recipe.servingsUnit.trim() || DEFAULT_SERVINGS_UNIT;

  return {
    title: recipe.title,
    servings,
    servingsUnit,
    imageUrl: recipe.imageUrl,
    ingredientLines: recipe.ingredientLines,
    // Trimmed and emptied out here rather than trusted: a model asked for "one
    // step per element" will occasionally hand back a trailing empty string,
    // and an empty numbered step reads as a bug in the app.
    instructions: recipe.instructions
      .map((step) => step.trim())
      .filter((step) => step.length > 0),
    sourceUrl: url,
    method: "llm",
  };
}

/**
 * A trailing slash in `AI_SHIM_URL` is an ordinary thing to type. Left in, it
 * makes `//recipe`, which is a 404, which is a `null` — a config typo that
 * presents as a permanently broken importer and looks exactly like a real
 * model failure.
 */
function shimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/**
 * Strips markup noise and collapses whitespace so the model reads page text,
 * not template boilerplate. `<script>`/`<style>` content is discarded outright
 * (never real content); `<nav>`/`<footer>` are dropped whole because their
 * text is boilerplate, not part of the recipe.
 */
function extractPageText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  const textOnly = withoutNoise.replace(/<[^>]+>/g, " ");
  const collapsed = decodeHtmlEntities(textOnly).replace(/\s+/g, " ").trim();
  return collapsed.slice(0, MAX_PAGE_TEXT_CHARS);
}
