import { isNull } from "drizzle-orm";
import { db } from "@/db";
import { catalogItems, catalogItemAliases } from "@/db/schema";
import { buildMatchCandidates, type MatchCandidate } from "@/lib/ingredients";

/**
 * Everything a name can currently resolve to: every live vara, plus every word
 * that reaches one.
 *
 * One loader rather than a query at each call site, because two of them will
 * exist — the recipe importer matching ingredient lines, and the scan path
 * matching an Open Food Facts product name against the household's vocabulary.
 * Two hand-written versions of "what can this match?" drift, and the way they
 * drift is that one of them forgets the aliases and quietly stops resolving
 * words the household merged away months ago.
 *
 * Two rules live here and nowhere else:
 *
 * **Tombstoned varor are excluded.** The matcher scores a list and knows nothing
 * about deletion, deliberately — so this is the only place the rule can be
 * applied, and the only place it can be got wrong. Without it a recipe import
 * keeps attaching ingredients to a vara the household explicitly merged away,
 * and they reappear on lists afterwards.
 *
 * **Aliases are not filtered by their target's state**, because an alias only
 * ever points at a survivor: `merge_catalog_items` tombstones the source and
 * aliases the source's word to the destination. An alias whose target was later
 * deleted resolves to a vara that is not in the candidate list, which the
 * matcher simply never returns — wrong-looking but harmless, and cheaper than a
 * join that would have to be kept in step with the tombstone rule above.
 */
export async function loadMatchCandidates(): Promise<MatchCandidate[]> {
  const [items, aliases] = await Promise.all([
    db
      .select({ id: catalogItems.id, nameNorm: catalogItems.nameNorm })
      .from(catalogItems)
      .where(isNull(catalogItems.deletedAt)),
    db
      .select({
        itemId: catalogItemAliases.catalogItemId,
        aliasNorm: catalogItemAliases.aliasNorm,
      })
      .from(catalogItemAliases)
      .where(isNull(catalogItemAliases.deletedAt)),
  ]);

  // Both sides arrive pre-normalized, read straight off `name_norm` and
  // `alias_norm` — the same contract the matcher already has with its callers,
  // and the reason neither is re-normalized here.
  return buildMatchCandidates(items, aliases);
}
