"use client";

import type { Id, List } from "@/lib/domain";
import type { EntryView } from "@/lib/services/entries";
import { ItemIcon } from "./icon";
import { Sheet } from "./sheet";

/**
 * Moving an item to another shop's list.
 *
 * The picker is the easy half. The hard half is that a move is not a pure
 * relocation and pretending otherwise would be a small lie told at exactly the
 * wrong moment: a recipe's share stays behind, and an ask already waiting on the
 * destination is replaced. Both are deliberate — see the `move_item` op — and
 * both are invisible afterwards, so they are said here, before the tap, in terms
 * of this item rather than in general.
 *
 * No confirmation step. The consequences are on screen while you choose, which
 * is the point of saying them; making you agree twice would be nagging rather
 * than informing, and a move is trivially reversible by moving it back.
 */

export interface MoveSheetProps {
  itemName: string;
  view: EntryView;
  /** The list being moved FROM — named in the copy, and never offered. */
  from: List;
  /** Every list in the household; the current one is filtered out here. */
  lists: List[];
  onMove: (toListId: Id) => void;
  onClose: () => void;
}

export function MoveSheet({
  itemName,
  view,
  from,
  lists,
  onMove,
  onClose,
}: MoveSheetProps) {
  const targets = lists.filter((l) => l.id !== from.id);
  const manual = view.contributions.find((c) => c.sourceKind === "manual");
  const recipeShares = view.contributions.filter(
    (c) => c.sourceKind === "recipe",
  );

  /**
   * What travels, named concretely.
   *
   * "Din mängd följer med" is worth saying only when there is one; on an item
   * with no stated quantity — the normal case for bread — it is noise about
   * nothing. The recipe line, by contrast, is the one that changes what you buy,
   * so it names the recipe and the quantity you are about to stop seeing.
   */
  const travels = [
    manual?.label,
    view.modifier ? `sorten "${view.modifier}"` : null,
  ].filter(Boolean) as string[];

  return (
    <Sheet title={`Flytta ${itemName}`} onClose={onClose}>
      <div className="px-4 pb-3">
        {travels.length > 0 && (
          <p className="text-body text-ink-soft">
            {travels.join(" och ")} följer med.
          </p>
        )}

        {recipeShares.map((c) => (
          <p key={c.id} className="mt-1.5 text-body text-ink-soft">
            {c.label ? `${c.label} till ` : ""}
            <span className="font-semibold text-ink">
              {c.recipeTitle ?? "receptet"}
            </span>{" "}
            följer <span className="font-semibold text-ink">inte</span> med —
            receptet ligger kvar på {from.name}.
          </p>
        ))}

        {/* Stated as a condition rather than a fact, because this device only
            holds the current list's entries and genuinely cannot know whether
            the destination already has this item. Saying "ersätts" outright
            would be wrong most of the time. */}
        <p className="mt-1.5 text-body text-ink-soft">
          Finns {itemName.toLowerCase()} redan på listan du väljer, ersätts
          mängden och prioriteten där.
        </p>
      </div>

      <ul className="border-t border-line px-2 pt-2">
        {targets.map((list) => (
          <li key={list.id}>
            <button
              type="button"
              onClick={() => onMove(list.id)}
              className="flex w-full items-center gap-3 rounded-control px-2 py-3 text-left transition-transform duration-100 active:scale-[0.99]"
            >
              <ItemIcon iconRef={list.icon} className="text-2xl" />
              <span className="flex-1 text-body font-semibold text-ink">
                {list.name}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-1 border-t border-line p-3">
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-control bg-surface px-3 py-3 text-body font-semibold text-ink"
        >
          Avbryt
        </button>
      </div>
    </Sheet>
  );
}
