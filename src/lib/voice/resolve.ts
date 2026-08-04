import type { Amount, Id } from "@/lib/domain";
import { type MatchCandidate, matchIngredient } from "@/lib/ingredients";
import type { SpokenItem } from "./interpret";

/**
 * What a spoken phrase turned out to be.
 *
 * "unknown" is a first-class outcome rather than an error, and that is the
 * whole design of this layer. The add bar's rule — a typo that silently
 * resolves is a recoverable annoyance, a typo that silently creates a 343rd
 * catalog item is permanent — applies with more force here, because a speaker
 * has no screen to correct and English speech recognition transcribing Swedish
 * grocery words produces genuine noise. So nothing in this path may mint a
 * vara. It matches, or it says it did not.
 */
export type SpokenResolution =
  | { status: "matched"; spoken: SpokenItem; catalogItemId: Id; score: number }
  | { status: "unknown"; spoken: SpokenItem };

/**
 * Everything the household says, against everything a name can reach.
 *
 * `matchIngredient` rather than `resolveQuery`, and the difference is the point
 * of the endpoint existing: `resolveQuery` scores `CatalogItem.nameNorm` and
 * nothing else, while `matchIngredient` takes the flat candidate list that
 * `buildMatchCandidates` expands out of items AND aliases. Aliases are how an
 * English word reaches a Swedish vara — Alexa has no Swedish locale, so
 * "milk" → mjölk is a row in `catalog_item_aliases`, exactly the same mechanism
 * that keeps a merged-away word resolving. Using the other matcher would have
 * quietly made the whole English path impossible.
 */
export function resolveSpokenItems(
  items: readonly SpokenItem[],
  candidates: MatchCandidate[],
): SpokenResolution[] {
  return items.map((spoken) => {
    const match = matchIngredient(spoken.name, candidates);
    // `matchIngredient` already applies its own 0.5 floor and returns null
    // below it, so there is deliberately no second threshold here — two floors
    // in two files is how they drift apart.
    if (!match) return { status: "unknown", spoken } as const;
    return {
      status: "matched",
      spoken,
      catalogItemId: match.id,
      score: match.score,
    } as const;
  });
}

/**
 * Fold repeats of one vara into a single result.
 *
 * "add milk and more milk" and, far more commonly, a household word that two
 * different spoken phrases both reach ("potatoes" and "potato") must not
 * produce two `add_item` ops for one entry. The list's own invariant is that a
 * vara appears at most once per list, so the second op would be a no-op the
 * caller then cheerfully reports as a second add.
 *
 * The FIRST occurrence wins its amount, because that is the one the speaker
 * said first and the one the confirmation will name back.
 */
export function dedupeResolutions(resolutions: SpokenResolution[]): SpokenResolution[] {
  const seen = new Set<Id>();
  const out: SpokenResolution[] = [];
  for (const r of resolutions) {
    if (r.status === "unknown") {
      out.push(r);
      continue;
    }
    if (seen.has(r.catalogItemId)) continue;
    seen.add(r.catalogItemId);
    out.push(r);
  }
  return out;
}

/** The amount a matched resolution asks for, or null for "some". */
export function amountOf(r: SpokenResolution): Amount | null {
  return r.spoken.amount;
}
