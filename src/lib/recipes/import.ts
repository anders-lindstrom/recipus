/**
 * URL recipe import: fetch the page, try JSON-LD, fall back to the LLM. See
 * docs/superpowers/specs/2026-07-29-recipus-design.md §5.6.
 */

import { extractJsonLdRecipe, type ImportedRecipe } from "./jsonld";
import { extractRecipeWithLlm } from "./llm";

const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export interface ImportRecipeOptions {
  fetchImpl?: typeof fetch;
  allowLlm?: boolean;
}

/** Fetches the URL, tries JSON-LD, falls back to the LLM when configured. */
export async function importRecipeFromUrl(
  url: string,
  opts: ImportRecipeOptions = {},
): Promise<ImportedRecipe> {
  const parsedUrl = validateUrl(url);
  const fetchImpl = opts.fetchImpl ?? fetch;

  const html = await fetchHtml(parsedUrl.toString(), fetchImpl);

  const jsonLdRecipe = extractJsonLdRecipe(html, parsedUrl.toString());
  if (jsonLdRecipe) return jsonLdRecipe;

  if (opts.allowLlm !== false) {
    const llmRecipe = await extractRecipeWithLlm(html, parsedUrl.toString());
    if (llmRecipe) return llmRecipe;
  }

  throw new Error("Kunde inte läsa receptet från sidan.");
}

function validateUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Ogiltig webbadress.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Webbadressen måste vara http eller https.");
  }
  return parsed;
}

async function fetchHtml(url: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Kunde inte hämta sidan (HTTP ${response.status}).`);
  }
  return response.text();
}
