"use client";

import type { Amount, Priority } from "@/lib/domain";
import type { ShopMode } from "@/lib/client/use-mode";
import type { EntryView } from "@/lib/services/entries";
import { DetailFields, PriorityField } from "./detail-fields";
import { Sheet, SheetActions, SheetButton } from "./sheet";
import { UiIcon } from "./ui-icon";

/**
 * The breakdown sheet.
 *
 * A total you cannot interrogate is a total you cannot trust. This answers
 * "why does it say 11 dl?" and gives you the two things that belong here:
 * changing the amount you asked for yourself, and pulling a single recipe back
 * out without disturbing anything else that wanted the same item.
 *
 * The amount field edits the **manual** contribution only. That is the one you
 * own; the recipe rows belong to the recipes, and silently rewriting one of
 * those would make the breakdown above it a lie. Clearing the amount does not
 * remove the item — a listed item with no stated quantity is the normal case.
 *
 * The amount and the sort used to be buttons that swapped this sheet for an
 * editor with its own Avbryt/Spara. Nothing was learned at either step: opening
 * this sheet already said you wanted to change something. They are fields now,
 * and the sheet stays open while you use them — see `DetailFields`.
 */

export interface EntrySheetProps {
  itemName: string;
  view: EntryView;
  /**
   * Which mode the list is in. Each mode's sheet offers the OTHER mode's action,
   * so you are never more than a long-press from the right answer and neither
   * mode can trap you into recording the wrong thing.
   */
  mode: ShopMode;
  /** Records a purchase without the tap having been a buy. Plan mode only. */
  onMarkBought: () => void;
  onClose: () => void;
  /** Sets the manual amount. Null clears it, leaving the item on the list. */
  onSetAmount: (amount: Amount | null) => void;
  /** Sets the household's qualifier — "mogna". Null clears it. */
  onSetModifier: (modifier: string | null) => void;
  onSetPriority: (priority: Priority) => void;
  /**
   * `recipeTitle` is the label this sheet actually rendered on the button. Passed
   * along so the confirmation that follows cannot name the recipe differently
   * from the button that opened it.
   */
  onRemoveRecipe: (recipeAdditionId: string, recipeTitle: string) => void;
  /**
   * Opens the "which list?" picker. Undefined when the household has only one
   * list, in which case the action is not offered at all — a button whose only
   * possible outcome is an empty sheet is worse than no button.
   */
  onMove?: () => void;
  /**
   * Straight to this item's entry in the registry.
   *
   * The list is about *this shop, today*; the registry is about what the thing
   * IS — its aisle, its name, the products under it. There was no way across, so
   * noticing in a shop that surdegsbröd is filed under Övrigt meant remembering
   * it until you were home and then finding it again among everything else.
   * Deep-linked with `?vara=`, so it opens on the item rather than on a screen of
   * all of them.
   */
  onOpenVara?: () => void;
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
  mode,
  onMarkBought,
  onClose,
  onSetAmount,
  onSetModifier,
  onSetPriority,
  onRemoveRecipe,
  onMove,
  onOpenVara,
  onRemoveWithoutBuying,
}: EntrySheetProps) {
  const manual = view.contributions.find((c) => c.sourceKind === "manual");
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
      {/* The two things most often wanted, as fields rather than as buttons
          that lead to fields. This sheet already knows you came here to change
          something; making you say so again cost two taps and a screen. */}
      <DetailFields
        amount={manual?.amount ?? null}
        onAmountChange={onSetAmount}
        modifier={view.modifier}
        onModifierChange={onSetModifier}
      />

      <PriorityField value={view.priority} onSelect={onSetPriority} />

      {/* Below the controls, because it answers "why does it say 11 dl?" — a
          question you ask after seeing the total, not before reaching for the
          field. Keeping it above would push the fields under the keyboard. */}
      {view.contributions.length > 0 && (
        <div className="px-4 pt-3 pb-1">
          <div className="mb-1 text-overline text-ink-faint uppercase">
            Behövs till
          </div>
          {/* Hairlines between rows and nowhere else — the divider is there
              to separate two things, not to draw a box around each one. */}
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
                {/* A contribution with no amount renders nothing rather than
                    a dash. The dash looked like a value. */}
                {c.label && (
                  <span className="text-body font-bold text-ink">
                    {c.label}
                  </span>
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
        {recipeSources.map((c) => (
          <SheetButton
            key={c.id}
            tone="danger"
            icon={<UiIcon name="remove" size={16} />}
            onClick={() =>
              onRemoveRecipe(c.recipeAdditionId!, c.recipeTitle ?? "receptet")
            }
          >
            Ta bort {c.recipeTitle ?? "receptet"}
          </SheetButton>
        ))}

        {onMove && (
          <SheetButton
            onClick={onMove}
            icon={<UiIcon name="toList" size={16} />}
          >
            Flytta till annan lista
          </SheetButton>
        )}

        {onOpenVara && (
          <SheetButton
            onClick={onOpenVara}
            icon={<UiIcon name="allAisles" size={16} />}
          >
            Om {itemName.toLowerCase()} — kategori, produkter
          </SheetButton>
        )}

        {mode === "plan" && (
          <SheetButton
            onClick={onMarkBought}
            icon={<UiIcon name="check" size={16} />}
          >
            Markera som köpt
          </SheetButton>
        )}

        <SheetButton
          tone="danger"
          icon={<UiIcon name="remove" size={16} />}
          onClick={onRemoveWithoutBuying}
        >
          {mode === "buy" ? "Köpte inte" : "Ta bort"}
        </SheetButton>
      </SheetActions>
    </Sheet>
  );
}
