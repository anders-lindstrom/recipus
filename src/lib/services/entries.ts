import type {
  Amount,
  Contribution,
  Id,
  ListEntry,
  SourceKind,
} from "@/lib/domain";
import { formatAmounts, mergeAmounts, toBase, unitFamily } from "@/lib/units";

/**
 * Sum amounts, preferring the unit the contributions were written in.
 *
 * `mergeAmounts` renders through a general display ladder, which is right for a
 * standalone amount — milk should read "2 l", not "20 dl". It is wrong for a
 * recipe total: 8 dl plus 3 dl becomes "1,1 l", and now you are converting
 * litres back to decilitres in front of the dairy cabinet to check it against a
 * recipe written in dl.
 *
 * So when every contribution in a unit family agrees on a unit, the total stays
 * in that unit. Mixed units (2 l plus 5 dl) fall back to the ladder, where the
 * ladder's answer — 2,5 l — is the natural one anyway.
 */
function mergePreservingUnit(amounts: Array<Amount | null>): Amount[] {
  const present = amounts.filter((a): a is Amount => a !== null);
  const ladder = mergeAmounts(present);

  return ladder.map((total) => {
    const family = unitFamily(total.unit);
    const inFamily = present.filter((a) => unitFamily(a.unit) === family);
    const units = new Set(inFamily.map((a) => a.unit));
    if (units.size !== 1) return total;

    const unit = inFamily[0].unit;
    const perUnit = toBase({ value: 1, unit });
    const base = inFamily.reduce((sum, a) => sum + toBase(a), 0);
    return { value: base / perUnit, unit };
  });
}

/**
 * Turning an entry's contributions into what the tile actually shows.
 *
 * This module exists because of one specific failure: the muffins need 8 dl of
 * cream and the pasta sauce needs 3 dl, and you come home with 4. The tile must
 * read the merged total, and it must be able to explain that total when tapped —
 * otherwise the number is just as untrustworthy as no number at all.
 */

export interface ContributionView {
  id: Id;
  sourceKind: SourceKind;
  recipeAdditionId: Id | null;
  /** Resolved for display: "Blåbärsmuffins". Null for non-recipe sources. */
  recipeTitle: string | null;
  /** The ×2 in "Blåbärsmuffins ×2". Null when the recipe was added unscaled. */
  scaleFactor: number | null;
  amount: Amount | null;
  note: string | null;
  /** Ready-to-render right-hand column: "8 dl", or "" when unspecified. */
  label: string;
}

export interface EntryView {
  entryId: Id;
  listId: Id;
  catalogItemId: Id;
  /**
   * One Amount per unit family. Usually a single entry; two when a recipe asks
   * for 2 dl and you also typed "3 st", which cannot be summed honestly.
   */
  totals: Amount[];
  /** "11 dl", "8 dl + 3 st", or "" when no contribution carries an amount. */
  totalLabel: string;
  contributions: ContributionView[];
  /** Drives the 📖 badge on the tile. */
  hasRecipeSource: boolean;
  notes: string[];
}

export interface RecipeAdditionInfo {
  recipeTitle: string;
  scaleFactor: number;
}

/**
 * Build the view for one entry.
 *
 * `recipeAdditions` maps recipeAdditionId → title and scale. It is passed in
 * rather than looked up so this stays pure and testable; the caller already has
 * the recipes loaded.
 */
export function buildEntryView(
  entry: ListEntry,
  contributions: Contribution[],
  recipeAdditions: Record<Id, RecipeAdditionInfo> = {},
): EntryView {
  const mine = contributions.filter((c) => c.entryId === entry.id);

  const views: ContributionView[] = mine.map((c) => {
    const addition = c.recipeAdditionId
      ? recipeAdditions[c.recipeAdditionId]
      : undefined;
    return {
      id: c.id,
      sourceKind: c.sourceKind,
      recipeAdditionId: c.recipeAdditionId,
      recipeTitle: addition?.recipeTitle ?? null,
      // A factor of exactly 1 is the uninteresting case — showing "×1" next to
      // every unscaled recipe is noise, so it reads as null here.
      scaleFactor:
        addition && addition.scaleFactor !== 1 ? addition.scaleFactor : null,
      amount: c.amount,
      note: c.note,
      label: c.amount ? formatAmounts([c.amount]) : "",
    };
  });

  // Recipe contributions first, then manual, then the rest: when you open the
  // breakdown you are almost always asking "what needs this?", and the recipes
  // are the answer.
  const order: Record<SourceKind, number> = {
    recipe: 0,
    manual: 1,
    scan: 2,
    suggestion: 3,
  };
  views.sort(
    (a, b) =>
      order[a.sourceKind] - order[b.sourceKind] ||
      a.label.localeCompare(b.label, "sv"),
  );

  const totals = mergePreservingUnit(mine.map((c) => c.amount));

  return {
    entryId: entry.id,
    listId: entry.listId,
    catalogItemId: entry.catalogItemId,
    totals,
    totalLabel: formatAmounts(totals),
    contributions: views,
    hasRecipeSource: mine.some((c) => c.sourceKind === "recipe"),
    notes: mine
      .map((c) => c.note)
      .filter((n): n is string => Boolean(n && n.trim())),
  };
}

/** Entries currently on a list — i.e. not tombstoned. */
export function activeEntries(entries: ListEntry[]): ListEntry[] {
  return entries.filter((e) => e.removedAt === null);
}

/**
 * Group entries by category for the aisle-ordered view.
 *
 * Categories are returned in the list's own walking order, with any category not
 * named in that order falling to the end — a newly seeded category should appear
 * somewhere sane rather than vanish.
 */
export function groupByCategory<T>(
  items: T[],
  categoryOf: (item: T) => Id,
  categoryOrder: Id[],
): Array<{ categoryId: Id; items: T[] }> {
  const buckets = new Map<Id, T[]>();
  for (const item of items) {
    const cat = categoryOf(item);
    const bucket = buckets.get(cat);
    if (bucket) bucket.push(item);
    else buckets.set(cat, [item]);
  }

  const rank = new Map(categoryOrder.map((id, i) => [id, i]));
  return [...buckets.entries()]
    .map(([categoryId, items]) => ({ categoryId, items }))
    .sort(
      (a, b) =>
        (rank.get(a.categoryId) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.categoryId) ?? Number.MAX_SAFE_INTEGER),
    );
}

/**
 * Whether the "att handla" zone should switch from a flat grid to aisle groups.
 *
 * A five-item list does not need aisle headers — they cost more vertical space
 * than they save. A twenty-item list does, because that is where you start
 * walking back across the shop. The threshold is the point where the flat grid
 * stops fitting on one screen anyway.
 */
export const AISLE_GROUPING_THRESHOLD = 12;

export function shouldGroupByAisle(entryCount: number): boolean {
  return entryCount > AISLE_GROUPING_THRESHOLD;
}

/**
 * Which items are on the list ONLY because this recipe asked for them.
 *
 * Removing a recipe drops its contributions but deliberately keeps the entries,
 * because something else may still want the cream and an entry with no
 * contributions is a valid "buy some, amount unspecified". The cost is that
 * dropping a recipe leaves its ingredients sitting on the list with no quantity
 * and no reason, and you have to tap each one off yourself.
 *
 * So the recipe offers to take them with it. This computes the candidates from
 * current state at the moment of removal, which is why `add_recipe` needs to
 * record nothing extra and no migration is involved.
 *
 * Deliberately a *suggestion*, never automatic. An item you added yourself with
 * no amount and which a recipe also wanted is indistinguishable here from one
 * the recipe brought — both end up with the recipe's contribution as their only
 * one. Guessing would sometimes take something you wanted, so the caller shows
 * this as a checklist and lets you decide.
 */
export function itemsOnlyWantedByRecipe(
  recipeAdditionId: Id,
  entries: ListEntry[],
  contributions: Contribution[],
): Id[] {
  const byEntry = new Map<Id, Contribution[]>();
  for (const c of contributions) {
    const list = byEntry.get(c.entryId);
    if (list) list.push(c);
    else byEntry.set(c.entryId, [c]);
  }

  const out: Id[] = [];
  for (const entry of activeEntries(entries)) {
    const mine = byEntry.get(entry.id) ?? [];
    const fromThisRecipe = mine.filter(
      (c) => c.recipeAdditionId === recipeAdditionId,
    );
    // Nothing from this recipe: not its business. Something else also wants it:
    // it stays whatever happens.
    if (fromThisRecipe.length === 0) continue;
    if (fromThisRecipe.length !== mine.length) continue;
    out.push(entry.catalogItemId);
  }
  return out;
}
