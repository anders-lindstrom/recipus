"use client";

import type { EntryView } from "@/lib/services/entries";

/**
 * The breakdown sheet.
 *
 * A total you cannot interrogate is a total you cannot trust. This answers
 * "why does it say 11 dl?" and gives you the one destructive action that
 * belongs here: pulling a single recipe back out without disturbing anything
 * else that wanted the same item.
 */

export interface EntrySheetProps {
  itemName: string;
  view: EntryView;
  onClose: () => void;
  onEditAmount: () => void;
  onRemoveRecipe: (recipeAdditionId: string) => void;
  /** Removes without recording a purchase — a change of mind, not a shop. */
  onRemoveWithoutBuying: () => void;
}

function sourceLabel(c: EntryView["contributions"][number]): string {
  if (c.sourceKind === "recipe") {
    const title = c.recipeTitle ?? "Recept";
    return c.scaleFactor ? `${title} ×${c.scaleFactor}` : title;
  }
  if (c.sourceKind === "scan") return "Skannad";
  if (c.sourceKind === "suggestion") return "Föreslagen";
  return "Tillagd";
}

export function EntrySheet({
  itemName,
  view,
  onClose,
  onEditAmount,
  onRemoveRecipe,
  onRemoveWithoutBuying,
}: EntrySheetProps) {
  const recipeSources = view.contributions.filter(
    (c) => c.sourceKind === "recipe" && c.recipeAdditionId,
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/30"
      role="dialog"
      aria-modal="true"
      aria-label={itemName}
      onClick={onClose}
    >
      <div
        className="safe-bottom w-full rounded-t-2xl border-t border-line bg-paper-raised"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline gap-3 border-b border-line px-4 pt-4 pb-3">
          <span className="flex-1 text-base font-extrabold tracking-tight text-ink">
            {itemName}
          </span>
          {view.totalLabel && (
            <span className="text-lg font-extrabold tracking-tight text-brand">
              {view.totalLabel}
            </span>
          )}
        </div>

        {view.contributions.length > 0 && (
          <div className="px-4 pt-3 pb-1">
            <div className="mb-2 text-[9.5px] font-extrabold tracking-[0.1em] text-ink-faint uppercase">
              Behövs till
            </div>
            <ul>
              {view.contributions.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center gap-2 py-1.5 text-[12.5px]"
                >
                  <span aria-hidden className="text-xs opacity-60">
                    {c.sourceKind === "recipe" ? "📖" : "✏️"}
                  </span>
                  <span className="flex-1 font-semibold text-ink">
                    {sourceLabel(c)}
                  </span>
                  <span className="font-extrabold text-ink">
                    {c.label || "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {view.notes.length > 0 && (
          <div className="px-4 pb-2">
            {view.notes.map((n, i) => (
              <p key={i} className="text-[12px] text-ink-soft italic">
                {n}
              </p>
            ))}
          </div>
        )}

        {recipeSources.length > 0 && (
          <div className="px-4 pb-2">
            {recipeSources.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onRemoveRecipe(c.recipeAdditionId!)}
                className="w-full py-2 text-left text-[12.5px] font-bold text-danger"
              >
                Ta bort {c.recipeTitle ?? "receptet"} från listan
              </button>
            ))}
          </div>
        )}

        <div className="mt-1 flex border-t border-line">
          <button
            type="button"
            onClick={onEditAmount}
            className="flex-1 px-1 py-3 text-center text-[11.5px] font-bold text-ink"
          >
            Ändra mängd
          </button>
          <button
            type="button"
            onClick={onRemoveWithoutBuying}
            className="flex-1 border-l border-line px-1 py-3 text-center text-[11.5px] font-bold text-danger"
          >
            Ta bort — köpte inte
          </button>
        </div>
      </div>
    </div>
  );
}
