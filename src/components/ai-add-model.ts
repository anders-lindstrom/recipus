/**
 * What the AI dialog decides, with no React attached.
 *
 * Same split as `list-model.ts` and `recipe-model.ts`: the judgement lives here
 * where a test can argue with it, and the component only draws. Everything in
 * this file is pure.
 */

import type { AiRow } from "@/lib/ai-add";
import type { Amount, CatalogItem, Id } from "@/lib/domain";
import { slugify } from "@/lib/utils";
import { newVaraLike } from "./list-model";

/**
 * Which rows arrive ticked.
 *
 * Rows from the list itself, and rows naming a vara this household has never
 * had a word for — you photographed a list, so you meant it, and a NY VARA
 * badge on a ticked row is a decision you can see rather than one you must make
 * twelve times.
 *
 * Two exceptions, for opposite reasons. The suggestion grid ("other") was never
 * on anybody's list. And a vara ALREADY on the list must not be re-added: the
 * server retracts a purchase of the same vara from the last half hour when one
 * comes back, so ticking it would erase köphistorik from a shop that happened
 * twenty minutes ago.
 */
export function initialTicked(
  rows: readonly AiRow[],
  onList: ReadonlySet<Id>,
): Set<string> {
  const ticked = new Set<string>();
  for (const r of rows) {
    if (r.group !== "list") continue;
    if (r.catalogItemId && onList.has(r.catalogItemId)) continue;
    ticked.add(r.id);
  }
  return ticked;
}

export interface AiAddPlan {
  /** Varor to mint first — the adds below reference them. */
  creates: CatalogItem[];
  adds: Array<{ catalogItemId: Id; amount: Amount | null }>;
}

/**
 * The ticked rows, as the ops they imply.
 *
 * An unmatched row becomes a vara named exactly what was read, filed in Övrigt
 * — the same answer `newVaraLike` gives with nothing to inherit from, because
 * guessing an aisle sends you to the wrong end of the shop permanently.
 *
 * The id is `slugify(name)`, which is what makes the reuse guard work: a word
 * that already exists resolves to the vara that already exists instead of
 * replacing it, exactly as `ensureVara` does for the add bar.
 */
export function planAdditions(
  rows: readonly AiRow[],
  ticked: ReadonlySet<string>,
  catalog: Record<Id, CatalogItem>,
): AiAddPlan {
  const creates: CatalogItem[] = [];
  const adds: AiAddPlan["adds"] = [];
  const seen = new Set<Id>();

  for (const row of rows) {
    if (!ticked.has(row.id)) continue;

    let id = row.catalogItemId;
    if (!id) {
      const name = row.name.trim();
      if (!name) continue;
      id = slugify(name);
      if (!catalog[id] && !seen.has(id)) creates.push(newVaraLike(id, name));
    }

    // One vara, one tile: the list's own invariant. A second add would be a
    // no-op the confirmation would then cheerfully count.
    if (seen.has(id)) continue;
    seen.add(id);
    adds.push({ catalogItemId: id, amount: row.amount });
  }

  return { creates, adds };
}
