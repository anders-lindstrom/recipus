"use client";

import { useState } from "react";
import type { Id } from "@/lib/domain";
import { cn } from "@/lib/utils";
import { ItemIcon } from "./icon";
import { Sheet } from "./sheet";
import { UiIcon } from "./ui-icon";

/**
 * Taking a recipe off the list, and what to do with its ingredients.
 *
 * Dropping a recipe used to leave every ingredient it had asked for sitting on
 * the list with no quantity and no visible reason, one tap each to clear. So the
 * recipe offers to take them with it.
 *
 * It asks rather than acting, and that is the point rather than timidity: an item
 * you added yourself with no amount, which a recipe then also wanted, is
 * indistinguishable from one the recipe brought — see
 * `itemsOnlyWantedByRecipe`. Removing silently would sometimes take something you
 * wanted, so the ambiguity is handed to the person who can actually resolve it.
 * Everything starts checked, because that is the common case.
 */

export interface RecipeRemovalCandidate {
  id: Id;
  name: string;
  iconRef: string;
}

export interface RecipeRemovalSheetProps {
  recipeTitle: string;
  /** Items nothing else on the list wants. Never empty — the caller skips the sheet. */
  candidates: RecipeRemovalCandidate[];
  onCancel: () => void;
  /** Removes the recipe, plus exactly the items handed back here. */
  onConfirm: (itemIdsToRemove: Id[]) => void;
}

export function RecipeRemovalSheet({
  recipeTitle,
  candidates,
  onCancel,
  onConfirm,
}: RecipeRemovalSheetProps) {
  const [keep, setKeep] = useState<Set<Id>>(new Set());
  const removing = candidates.filter((c) => !keep.has(c.id));

  function toggle(id: Id) {
    setKeep((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Sheet
      title={`Ta bort ${recipeTitle}?`}
      onClose={onCancel}
      // The affirmative answer to the question in the title. Escape is the other
      // one, and it is the one that leaves the list alone.
      onPrimary={() => onConfirm(removing.map((c) => c.id))}
    >
      <div className="px-4 pb-1">
        <p className="text-body text-ink-soft">
          {candidates.length === 1
            ? "Den här varan står på listan bara för det här receptet."
            : "Dessa varor står på listan bara för det här receptet."}
        </p>
      </div>

      <ul className="mx-4 mt-3 divide-y divide-line">
        {candidates.map((c) => {
          const kept = keep.has(c.id);
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => toggle(c.id)}
                aria-pressed={!kept}
                className="flex w-full items-center gap-3 py-3 text-left"
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex h-[22px] w-[22px] flex-none items-center justify-center rounded-md transition-colors duration-150",
                    kept
                      ? "border-[1.5px] border-line-strong"
                      : "bg-brand text-on-brand",
                  )}
                >
                  {!kept && <UiIcon name="check" size={14} />}
                </span>
                <ItemIcon iconRef={c.iconRef} className="text-xl" />
                {/* The kept row stays fully legible: it is a choice you may want
                    to reverse, not a disabled control. */}
                <span
                  className={cn(
                    "flex-1 text-body",
                    kept ? "text-ink-faint" : "text-ink",
                  )}
                >
                  {c.name}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-2 flex flex-col gap-2 border-t border-line p-3">
        <button
          type="button"
          onClick={() => onConfirm(removing.map((c) => c.id))}
          className="flex w-full items-center justify-center gap-2 rounded-control bg-brand px-3 py-3 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.98]"
        >
          <UiIcon name="remove" size={16} />
          {removing.length === 0
            ? "Ta bort bara receptet"
            : removing.length === candidates.length
              ? `Ta bort receptet och ${removing.length} ${
                  removing.length === 1 ? "vara" : "varor"
                }`
              : `Ta bort receptet och ${removing.length} av ${candidates.length}`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="w-full rounded-control bg-surface px-3 py-3 text-body font-semibold text-ink"
        >
          Avbryt
        </button>
      </div>
    </Sheet>
  );
}
