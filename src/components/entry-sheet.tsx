"use client";

import type { EntryView } from "@/lib/services/entries";
import { Sheet, SheetActions, SheetButton } from "./sheet";
import { UiIcon } from "./ui-icon";

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
    <Sheet
      title={itemName}
      onClose={onClose}
      trailing={
        view.totalLabel ? (
          <span className="text-display text-brand-ink">{view.totalLabel}</span>
        ) : undefined
      }
    >
      {view.contributions.length > 0 && (
        <div className="px-4 pb-1">
          <div className="mb-1 text-overline text-ink-faint uppercase">
            Behövs till
          </div>
          {/* Hairlines between rows and nowhere else — the divider is there to
              separate two things, not to draw a box around each one. */}
          <ul className="divide-y divide-line">
            {view.contributions.map((c) => (
              <li key={c.id} className="flex items-center gap-2.5 py-2.5">
                <UiIcon
                  name={c.sourceKind === "recipe" ? "recipes" : "edit"}
                  size={15}
                  className="flex-none text-ink-faint"
                />
                <span className="flex-1 text-body text-ink">
                  {sourceLabel(c)}
                </span>
                {/* A contribution with no amount ("mjölk", no quantity) renders
                    nothing rather than a dash. The dash looked like a value. */}
                {c.label && (
                  <span className="text-body font-bold text-ink">{c.label}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.notes.length > 0 && (
        <div className="px-4 pt-2 pb-1">
          {view.notes.map((n, i) => (
            <p key={i} className="text-body-sm text-ink-soft italic">
              {n}
            </p>
          ))}
        </div>
      )}

      <SheetActions>
        <SheetButton
          onClick={onEditAmount}
          icon={<UiIcon name="edit" size={16} />}
        >
          Ändra mängd
        </SheetButton>

        {recipeSources.map((c) => (
          <SheetButton
            key={c.id}
            tone="danger"
            icon={<UiIcon name="remove" size={16} />}
            onClick={() => onRemoveRecipe(c.recipeAdditionId!)}
          >
            Ta bort {c.recipeTitle ?? "receptet"}
          </SheetButton>
        ))}

        <SheetButton
          tone="danger"
          icon={<UiIcon name="remove" size={16} />}
          onClick={onRemoveWithoutBuying}
        >
          Ta bort, köpte inte
        </SheetButton>
      </SheetActions>
    </Sheet>
  );
}
