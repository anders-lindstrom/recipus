/**
 * Recipe import: URL → structured recipe via schema.org/Recipe JSON-LD, with
 * an LLM fallback for pages that don't publish it. See
 * docs/superpowers/specs/2026-07-29-recipus-design.md §5.6.
 */

export type { ImportedRecipe } from "./jsonld";
export { extractJsonLdRecipe } from "./jsonld";
export { extractRecipeWithLlm } from "./llm";
export { importRecipeFromUrl, type ImportRecipeOptions } from "./import";
