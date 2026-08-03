import {
  entryId,
  manualContributionId,
  type CatalogItem,
  type Id,
  type SyncState,
} from "@/lib/domain";
import { parseAmount } from "@/lib/units";
import { normalizeName, slugify } from "@/lib/utils";
import type { OpDraft } from "./varor-model";

/**
 * The list screen's one genuinely delicate plan, kept pure so it can be argued
 * about in a test.
 *
 * Same reasoning as `mergeVaraOps` next door: the interesting cases here — a
 * recipe still wanting the plain kind, a name that is already a vara, a hidden
 * vara being reused — are ones nobody will reliably reproduce in a browser, and
 * getting the ORDER wrong fails silently rather than loudly.
 */

/**
 * What "Föreslås" still has to offer, given everything that should silence a
 * suggestion.
 *
 * Pure and here rather than inline in the screen because the three exclusions
 * answer three different questions and only one of them is obvious. The row is
 * rendered from a SERVER snapshot, so nothing about it reacts to the household
 * on its own:
 *
 * - `onList` is the tap answering for itself. Without it a tapped tile stayed
 *   put and un-dimmed, which is indistinguishable from a tap that did not
 *   register — so you tap again and fire a second `add_item`. It is also what
 *   makes a partner's add, arriving over SSE, stop being offered here.
 * - `accepted` is the same tap surviving buy mode. Ticking a vara off is
 *   precisely what removes it from `onList`, so without this the milk already
 *   in the trolley is offered back the moment it is bought.
 * - `dismissed` is "inte den här gången", held locally until the next snapshot
 *   carries the server's own copy of it.
 *
 * The server excludes on-list varor too (`list-data.ts`), at query time and
 * with the same blind spot from the other side: it cannot know what has
 * happened since it answered.
 */
export function visibleSuggestions<T extends { catalogItemId: Id }>(
  suggestions: readonly T[],
  silenced: { onList: ReadonlySet<Id>; accepted: ReadonlySet<Id>; dismissed: ReadonlySet<Id> },
): T[] {
  return suggestions.filter(
    (s) =>
      !silenced.onList.has(s.catalogItemId) &&
      !silenced.accepted.has(s.catalogItemId) &&
      !silenced.dismissed.has(s.catalogItemId),
  );
}

/**
 * Two kinds of one thing, made into two varor.
 *
 * The problem this solves is structural rather than cosmetic. A list entry's id
 * is `(listId, catalogItemId)`, so one vara appears at most once per list, and a
 * sort ("mogna") lives on that entry's manual contribution. There is therefore
 * no way to hold "blåbär" and "mogna blåbär" at the same time — and the app's
 * answer, before this, was to overwrite one with the other and say nothing.
 *
 * So the sort becomes a vara. It inherits the original's aisle and icon, because
 * a split is a refinement of one word rather than an unrelated new one and
 * anything created without an aisle lands in Övrigt, which sorts LAST — the
 * penalty that used to fall on exactly the household that knew what it wanted.
 *
 * **What travels is the MANUAL ask**: its amount and its urgency. A recipe's
 * share stays behind, and has to — the recipe asked for blåbär, not for the ripe
 * ones, and moving its contribution would make its own breakdown a lie. This is
 * the same line `move_item` draws, for the same reason.
 *
 * **The original is cleared before it is removed**, and that ordering is the one
 * thing here that cannot be reordered. `remove_item` tombstones the entry and
 * leaves contributions exactly where they are, so a later `add_item` for plain
 * blåbär un-tombstones an entry still carrying "2 kg mogna" — the ghost this
 * whole change exists to remove, resurrected by the fix for it.
 */
export function splitSortOps(
  state: SyncState,
  listId: Id,
  baseItemId: Id,
  newName: string,
  options: {
    /**
     * Does anybody want the plain kind?
     *
     * True from the add bar, where somebody has literally just asked for it, so
     * the original entry stays and becomes that ask. False from the entry sheet,
     * where the gesture means "this was always the ripe ones" and nobody has
     * asked for the plain one at all.
     */
    keepPlain: boolean;
    /** What the add bar had typed for the plain kind — "1 st". Empty otherwise. */
    plainAmountText?: string;
  },
): OpDraft[] {
  const base = state.catalog[baseItemId];
  const name = newName.trim();
  if (!base || name.length < 2) return [];

  const newId = slugify(name);
  // Splitting a thing onto itself is not a split. Reachable by clearing the
  // prefilled name back down to the base's own word, and it would otherwise emit
  // a create that overwrites the vara it was meant to refine.
  if (newId === baseItemId) return [];

  const ops: OpDraft[] = [];

  /*
   * Reuse an existing vara rather than re-creating it.
   *
   * Ids are `slugify(name)`, and `create_catalog_item` REPLACES the row wholesale
   * when it wins on clock — so splitting "mogna" off blåbär twice, or splitting
   * onto a name somebody has already made, would reset that vara's aisle, icon
   * and hidden flag to whatever this call inferred. Un-hiding is the right move
   * for a name being deliberately typed: reaching for a vara is the household
   * asking for it back.
   */
  const existing = state.catalog[newId];
  if (existing) {
    if (existing.hidden) {
      ops.push({
        kind: "update_catalog_item",
        itemId: newId,
        patch: { hidden: false },
      });
    }
  } else {
    ops.push({
      kind: "create_catalog_item",
      item: newVaraLike(newId, name, base),
    });
  }

  const eid = entryId(listId, baseItemId);
  const entry = state.entries[eid];
  const manual = state.contributions[manualContributionId(eid)];
  // Only a live entry has an ask to move. Splitting from the add bar always has
  // one; splitting a stand-in never does.
  const live = entry && entry.removedAt === null;
  const priority = live ? entry.priority : "normal";

  ops.push({ kind: "add_item", listId, catalogItemId: newId });
  if (live && manual?.amount) {
    ops.push({
      kind: "set_amount",
      listId,
      catalogItemId: newId,
      amount: manual.amount,
    });
  }
  // Only when it says something. "normal" is what an entry is born with, and
  // stamping priority's clock anyway would let this split outrank a genuine
  // "bråttom" set on another phone a moment earlier.
  if (priority !== "normal") {
    ops.push({ kind: "set_priority", listId, catalogItemId: newId, priority });
  }

  if (!live) return ops;

  // The original stops being the qualified ask, whichever route got here — and
  // this has to happen BEFORE any removal below. See the note above.
  ops.push({ kind: "set_modifier", listId, catalogItemId: baseItemId, modifier: null });

  const plain = options.keepPlain
    ? parseAmount((options.plainAmountText ?? "").trim())
    : null;
  ops.push({
    kind: "set_amount",
    listId,
    catalogItemId: baseItemId,
    amount: plain,
  });

  if (options.keepPlain) {
    // Already on the list, so this is a no-op on the entry — but it is what
    // makes the intent legible, and it is what puts the plain kind back if a
    // partner removed it in the seconds this sheet was open.
    ops.push({ kind: "add_item", listId, catalogItemId: baseItemId });
    // The urgency belonged to the ask that has just moved out.
    if (priority !== "normal") {
      ops.push({
        kind: "set_priority",
        listId,
        catalogItemId: baseItemId,
        priority: "normal",
      });
    }
    return ops;
  }

  // A recipe still wants the plain thing, so the entry stays — stripped of a
  // manual ask that has moved.
  if (hasRecipeContribution(state, eid)) return ops;

  // Nobody wants it. `bought: false` — this is a change of mind about what the
  // thing IS, and recording it as a shop would teach the cadence engine that
  // this household buys blueberries every time it tidies its own vocabulary.
  ops.push({ kind: "remove_item", listId, catalogItemId: baseItemId, bought: false });
  return ops;
}

/**
 * A vara created beside another one, inheriting what makes it findable in a
 * shop.
 *
 * Exported because the add-details sheet builds one from a draft rather than
 * from an existing ask, and the two must not drift on what "beside" means.
 */
export function newVaraLike(
  id: Id,
  name: string,
  like?: CatalogItem,
): CatalogItem {
  return {
    id,
    name,
    nameNorm: normalizeName(name),
    // With nothing to inherit from, Övrigt is the honest answer for a word the
    // app has never seen — guessing an aisle sends you to the wrong end of the
    // shop, permanently.
    categoryId: like?.categoryId ?? "ovrigt",
    iconRef: like?.iconRef ?? "1F4E6",
    isCustom: true,
    // Neither is inherited, deliberately. "Har alltid hemma" is a claim about
    // the pantry that a new kind cannot have earned, and inheriting `hidden`
    // would create a vara nobody can find at the moment they asked for it.
    hasAtHome: false,
    hidden: false,
    useCount: 0,
    lastUsedAt: null,
  };
}

function hasRecipeContribution(state: SyncState, eid: Id): boolean {
  return Object.values(state.contributions).some(
    (c) => c.entryId === eid && c.sourceKind === "recipe",
  );
}
