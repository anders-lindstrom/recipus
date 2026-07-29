/**
 * LLM recipe extraction: the fallback for pages that don't publish
 * schema.org/Recipe JSON-LD. Only reached when `jsonld.ts` finds nothing. See
 * docs/superpowers/specs/2026-07-29-recipus-design.md §5.6.
 *
 * Must never throw and must never require an API key to be present — a site
 * that already has JSON-LD has to keep importing with no key configured at
 * all, so every failure mode here resolves to `null` and lets the caller
 * (`import.ts`) fall through to its own error.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { decodeHtmlEntities, type ImportedRecipe } from "./jsonld";

const MODEL = "claude-opus-5";
const MAX_TOKENS = 16000;
// Keeps a bloated page from blowing up prompt cost; a recipe's text is never
// anywhere near this long.
const MAX_PAGE_TEXT_CHARS = 40_000;

const DEFAULT_SERVINGS = 4;
const DEFAULT_SERVINGS_UNIT = "portioner";

const RecipeSchema = z.object({
  title: z.string(),
  servings: z.number(),
  servingsUnit: z.string(),
  imageUrl: z.string().nullable(),
  ingredientLines: z.array(z.string()),
});

const SYSTEM_PROMPT = `Du extraherar ett matrecept från texten på en webbsida.

Regler:
- ingredientLines måste vara ordagranna rader precis som de står på sidan,
  på svenska, med mängder kvar (t.ex. "2 dl vispgrädde"). Normalisera inte,
  översätt inte och slå inte ihop rader.
- servings och servingsUnit ska spegla vad receptet anger (t.ex. 4 och
  "portioner", eller 12 och "muffins"). Om det inte går att avgöra: 4 och
  "portioner".
- imageUrl är en fullständig bild-URL om en sådan finns på sidan, annars null.
- title är receptets namn.

Om sidan inte innehåller ett recept, gör ditt bästa för att ändå fylla i
schemat med den information som faktiskt finns.`;

/** Exported separately so import.ts can be tested without network or API key. */
export async function extractRecipeWithLlm(html: string, url: string): Promise<ImportedRecipe | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const pageText = extractPageText(html);
  const client = new Anthropic();

  let response;
  try {
    response = await client.messages.parse({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Webbadress: ${url}\n\nSidans text:\n${pageText}`,
        },
      ],
      output_config: { format: zodOutputFormat(RecipeSchema) },
    });
  } catch {
    return null;
  }

  // Must be checked before reading parsed_output — a refusal can still carry
  // a (meaningless) parsed_output value.
  if (response.stop_reason === "refusal") return null;

  const parsed = response.parsed_output;
  if (!parsed) return null;

  const servings = Number.isFinite(parsed.servings) && parsed.servings > 0 ? parsed.servings : DEFAULT_SERVINGS;
  const servingsUnit = parsed.servingsUnit.trim() || DEFAULT_SERVINGS_UNIT;

  return {
    title: parsed.title,
    servings,
    servingsUnit,
    imageUrl: parsed.imageUrl,
    ingredientLines: parsed.ingredientLines,
    sourceUrl: url,
    method: "llm",
  };
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
