import type { CatalogItem } from "@/lib/domain";
import { parseQuantityPrefix } from "@/lib/units";
import { normalizeName } from "@/lib/utils";

/**
 * Catalog search and inline quantity parsing for the add bar.
 *
 * Pure on purpose — this is the fast path onto the list, and its behaviour is
 * far easier to pin down in tests than in a browser.
 */

const MAX_SUGGESTIONS = 6;

/**
 * Rank catalog matches for a query.
 *
 * Prefix beats substring, because someone typing "mj" wants "mjölk" long before
 * "havremjölk". Beyond that it is the catalog's own recency/frequency ordering,
 * which is what makes the list feel like yours after a few shops.
 */
export function rankMatches(
  catalog: CatalogItem[],
  query: string,
  limit = MAX_SUGGESTIONS,
): CatalogItem[] {
  const q = normalizeName(query);
  if (!q) return [];

  const scored: Array<{ item: CatalogItem; score: number }> = [];
  for (const item of catalog) {
    const name = item.nameNorm;
    let score: number;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    // Start of any later word, so "lök" finds "gul lök".
    else if (name.split(" ").some((w) => w.startsWith(q))) score = 2;
    else if (name.includes(q)) score = 3;
    else continue;
    scored.push({ item, score });
  }

  return scored
    .sort(
      (a, b) =>
        a.score - b.score ||
        b.item.useCount - a.item.useCount ||
        a.item.name.localeCompare(b.item.name, "sv"),
    )
    .slice(0, limit)
    .map((s) => s.item);
}

/**
 * Split "mjölk 2 l" into a name and a trailing amount.
 *
 * The quantity may lead ("2 l mjölk") or trail ("mjölk 2 l") — people type both
 * — and whatever comes out goes through the same parser the recipe importer
 * uses, so there is exactly one implementation of "2 l" in the codebase.
 */
export function splitQuery(raw: string): { name: string; amountText: string } {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return { name: "", amountText: "" };

  // Leading quantity: "2 l mjölk".
  const lead = parseQuantityPrefix(trimmed);
  if (lead.amount && lead.rest && lead.rest !== trimmed) {
    return {
      name: lead.rest,
      amountText: trimmed.slice(0, trimmed.length - lead.rest.length).trim(),
    };
  }

  // Trailing quantity: "mjölk 2 l". Walk back from the end for the longest
  // suffix that is entirely an amount.
  const words = trimmed.split(" ");
  for (let i = words.length - 1; i >= 1; i--) {
    const tail = words.slice(i).join(" ");
    const parsed = parseQuantityPrefix(tail);
    if (parsed.amount && !parsed.rest) {
      return { name: words.slice(0, i).join(" "), amountText: tail };
    }
  }

  return { name: trimmed, amountText: "" };
}
