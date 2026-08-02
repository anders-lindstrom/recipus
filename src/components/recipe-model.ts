import type { CatalogItem, CatalogItemAlias, Id, RecipeIngredient } from "@/lib/domain";
import { parseIngredientLine } from "@/lib/ingredients";
import { normalizeName, slugify } from "@/lib/utils";

/**
 * A vara the add is about to create, held until the sheet is confirmed.
 *
 * Nothing is created for an ingredient the person then unticks: the sheet is
 * where "we do not need the salt" is said, and a vara invented for a line
 * nobody kept is a word in the household's vocabulary that no human ever chose.
 */
export interface PendingVara {
  id: Id;
  name: Id;
}

export interface ResolvedIngredients {
  ingredients: RecipeIngredient[];
  pending: PendingVara[];
}

/**
 * Which vara each ingredient line means, decided against the catalog as it is
 * NOW.
 *
 * The stored `catalogItemId` is the import's answer and is trusted first —
 * matched then, re-pointed since by any merge that moved it (see
 * `repointMergedCatalogItem`), so it is the household's most considered answer
 * to this question.
 *
 * A line the import could not place is stored NULL, and that is where this
 * function earns its existence. Null is not "no vara" but "nobody has decided
 * yet", and the deciding used to be one line long: slugify the raw name and
 * create it. That re-decided from scratch on every add, against a catalog that
 * had moved on, and the failure was not subtle. Merge the invented vara into
 * one that means the same thing, add the recipe again, and the same slug came
 * straight back — `create_catalog_item` beats the merge's tombstone on clock —
 * so the word the household had just retired was alive again, the merge was
 * undone, and the list showed 1200 g of it beside 1200 g of the survivor.
 *
 * Hence the order below: the merged-away words FIRST, since an alias is
 * precisely the household saying "that word means this one now", then a vara
 * the slug already names, and only then something new. It is the same order
 * `ensureVara` follows on the list screen, for the same reason.
 *
 * Pure so the cases can be asserted in a test rather than in a browser — the
 * interesting ones (an alias onto a since-deleted vara, two lines naming one
 * thing) are all silent when they go wrong.
 */
export function resolveRecipeVaror(
  ingredients: RecipeIngredient[],
  catalog: Record<Id, CatalogItem>,
  aliasList: CatalogItemAlias[],
): ResolvedIngredients {
  // Aliases whose survivor is still in the catalog, and no others. An alias
  // outlives a later `delete_catalog_item`, and resolving onto a tombstone
  // would trade the resurrection bug for the orphan tile it causes.
  const aliases = new Map(
    aliasList
      .filter((a) => catalog[a.catalogItemId])
      .map((a) => [a.aliasNorm, a.catalogItemId] as const),
  );

  const pending = new Map<string, PendingVara>();
  const resolved = ingredients.map((ing) => {
    if (ing.catalogItemId) return ing;

    const parsed = parseIngredientLine(ing.rawText);
    const name = parsed.name.trim() || ing.rawText.trim();
    const key = normalizeName(name);

    const merged = aliases.get(key);
    if (merged) return { ...ing, catalogItemId: merged };

    // A vara this word already names. Reused rather than re-created, for the
    // reason `ensureVara` gives: `create_catalog_item` REPLACES the row when it
    // wins on clock, so re-creating a vara someone has since re-filed resets its
    // aisle, its icon and its hidden flag to whatever this line happens to
    // infer.
    const slug = slugify(name);
    if (slug && catalog[slug]) return { ...ing, catalogItemId: slug };

    // Keyed by the normalized name rather than by the slug, so two lines
    // spelling one ingredient differently still land on one vara — and one
    // create, not two racing ones with the same id.
    let entry = pending.get(key);
    if (!entry) {
      entry = { id: slug || `vara-${ing.id}`, name };
      pending.set(key, entry);
    }
    return { ...ing, catalogItemId: entry.id };
  });

  return { ingredients: resolved, pending: [...pending.values()] };
}
