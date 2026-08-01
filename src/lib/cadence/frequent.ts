import type { CatalogItem, Id } from "@/lib/domain";
import { catalogOrderScore } from "./index";

/**
 * The "Vanligast" offer: what this household buys, most likely first.
 *
 * Extracted here rather than left inline in the add bar because it is a
 * *ranking* question and every other ranking in the app is now answered by
 * `catalogOrderScore` — the catalog well, and (since this pass) the search
 * field. Three orderings of the same 341 varor on one screen have to agree
 * about what "yours" means, and until this existed the panel was the one that
 * disagreed.
 *
 * What the disagreement cost, measured against a synthetic twelve-week history:
 * the panel offered `gurka` first — bought the previous day — and gave two of
 * its six slots to `jordgubbar`, whose season ended six weeks earlier, and
 * `kanel`, bought four times at wildly irregular intervals. Raw `useCount`
 * never forgets, so the longer a household uses the app the more of this panel
 * is taken up by things it used to buy.
 *
 * The two filters are carried over from the add bar unchanged and both matter:
 *
 * **Hidden varor are excluded outright**, unlike in `rankMatches` where they are
 * merely demoted. This panel is an offer the app makes unprompted, and offering
 * back something the household deliberately put away is the whole thing hiding
 * exists to stop. Typing the name still finds it.
 *
 * **`useCount` gates entry, `catalogOrderScore` orders what gets in.** A vara
 * with no shops behind it has no business being offered at all, however
 * recently somebody edited it — and `useCount` is incremented by a purchase and
 * nothing else, so this really is "what you buy" rather than "what you last
 * fiddled with".
 */
export function frequentVaror(
  catalog: CatalogItem[],
  opts: { now: Date; excludeItemIds?: Set<Id>; limit: number },
): CatalogItem[] {
  const exclude = opts.excludeItemIds ?? new Set<Id>();
  const score = (c: CatalogItem) =>
    catalogOrderScore(
      c.useCount,
      c.lastUsedAt ? new Date(c.lastUsedAt) : null,
      opts.now,
    );

  return catalog
    .filter((c) => c.useCount > 0 && !c.hidden && !exclude.has(c.id))
    .sort(
      (a, b) =>
        score(b) - score(a) ||
        // Every score is 0 for a vara that has never been used, which is the
        // whole seeded catalog on a fresh install; without this the panel would
        // fall straight through to alphabetical.
        b.useCount - a.useCount ||
        a.name.localeCompare(b.name, "sv"),
    )
    .slice(0, opts.limit);
}
