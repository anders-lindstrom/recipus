"use client";

import { useState } from "react";
import type { Amount } from "@/lib/domain";
import type { ShopMode } from "@/lib/client/use-mode";
import type { EntryView } from "@/lib/services/entries";
import { formatAmount, parseAmount } from "@/lib/units";
import { cn } from "@/lib/utils";
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
 * "Ändra mängd" edits the **manual** contribution only. That is the one you own;
 * the recipe rows belong to the recipes, and silently rewriting one of those
 * would make the breakdown above it a lie. Clearing the manual amount does not
 * remove the item — a listed item with no stated quantity is the normal case.
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
  mode,
  onMarkBought,
  onClose,
  onSetAmount,
  onRemoveRecipe,
  onRemoveWithoutBuying,
}: EntrySheetProps) {
  const manual = view.contributions.find((c) => c.sourceKind === "manual");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const recipeSources = view.contributions.filter(
    (c) => c.sourceKind === "recipe" && c.recipeAdditionId,
  );

  const trimmed = draft.trim();
  // The same parser the add bar and the recipe importer use, so "1½ msk" means
  // one thing in this app rather than three.
  const parsed = trimmed === "" ? null : parseAmount(trimmed);
  const unparseable = trimmed !== "" && parsed === null;

  function startEditing() {
    setDraft(manual?.amount ? formatAmount(manual.amount) : "");
    setEditing(true);
  }

  function save() {
    if (unparseable) return;
    onSetAmount(parsed);
  }

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
      {editing ? (
        <div className="px-4 pb-4">
          <label
            htmlFor="entry-amount"
            className="mb-1.5 block text-overline text-ink-faint uppercase"
          >
            Mängd
          </label>
          <input
            id="entry-amount"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            placeholder="2 dl"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            className={cn(
              "w-full rounded-control border bg-surface px-3.5 py-3 text-body text-ink outline-none placeholder:text-ink-faint",
              unparseable ? "border-danger" : "border-line",
            )}
          />

          {/* One line, always present, so the row cannot change height as you
              type — the sheet twitching under your thumb reads as a bug. */}
          <p
            className={cn(
              "mt-2 min-h-[1.25rem] text-caption",
              unparseable ? "text-danger" : "text-ink-soft",
            )}
          >
            {unparseable
              ? `"${trimmed}" går inte att tolka som en mängd.`
              : parsed
                ? `Sparas som ${formatAmount(parsed)}.`
                : "Lämna tomt för att ta bort mängden."}
          </p>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="flex-1 rounded-control bg-surface px-3 py-3 text-body font-semibold text-ink"
            >
              Avbryt
            </button>
            <button
              type="button"
              onClick={save}
              disabled={unparseable}
              className="flex-1 rounded-control bg-brand px-3 py-3 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.98] disabled:opacity-40"
            >
              Spara
            </button>
          </div>
        </div>
      ) : (
        <>
          {view.contributions.length > 0 && (
            <div className="px-4 pb-1">
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
            <SheetButton
              onClick={startEditing}
              icon={<UiIcon name="edit" size={16} />}
            >
              {manual?.amount ? "Ändra mängd" : "Ange mängd"}
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
        </>
      )}
    </Sheet>
  );
}
