"use client";

import { useState } from "react";
import type { Amount, Priority } from "@/lib/domain";
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

/**
 * Three states, labelled from the shopper's point of view.
 *
 * "Om du hinner" rather than "Låg prioritet": the whole reason this state exists
 * is the instruction "grab it if you pass it", which is a different thing from
 * "this matters less" — and phrasing it as a rank invites the list to become a
 * ranking, which is exactly how urgency stops meaning anything.
 */
const PRIORITY_CHOICES: ReadonlyArray<{ value: Priority; label: string }> = [
  { value: "urgent", label: "Bråttom" },
  { value: "normal", label: "Vanlig" },
  { value: "convenient", label: "Om du hinner" },
];

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
  onRemoveWithoutBuying,
}: EntrySheetProps) {
  const manual = view.contributions.find((c) => c.sourceKind === "manual");
  // One editor slot rather than two booleans: the amount and the sort are edited
  // in the same place, and two flags would eventually both be true.
  const [editing, setEditing] = useState<"amount" | "modifier" | null>(null);
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
    setEditing("amount");
  }

  function startModifier() {
    setDraft(view.modifier ?? "");
    setEditing("modifier");
  }

  function save() {
    if (editing === "modifier") {
      // Empty clears it. A modifier is free text, so there is nothing to fail to
      // parse and no reason to make the user delete a word twice.
      onSetModifier(trimmed === "" ? null : trimmed);
      return;
    }
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
            {editing === "modifier" ? "Sort" : "Mängd"}
          </label>
          <input
            id="entry-amount"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            placeholder={editing === "modifier" ? "mogna" : "2 dl"}
            inputMode="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            className={cn(
              "w-full rounded-control border bg-surface px-3.5 py-3 text-body text-ink outline-none placeholder:text-ink-faint",
              unparseable && editing === "amount"
                ? "border-danger"
                : "border-line",
            )}
          />

          {/* One line, always present, so the row cannot change height as you
              type — the sheet twitching under your thumb reads as a bug. */}
          <p
            className={cn(
              "mt-2 min-h-[1.25rem] text-caption",
              unparseable && editing === "amount"
                ? "text-danger"
                : "text-ink-soft",
            )}
          >
            {editing === "modifier"
              ? trimmed === ""
                ? "Lämna tomt för att ta bort sorten."
                : `Visas som "${trimmed}" på brickan.`
              : unparseable
                ? `"${trimmed}" går inte att tolka som en mängd.`
                : parsed
                  ? `Sparas som ${formatAmount(parsed)}.`
                  : "Lämna tomt för att ta bort mängden."}
          </p>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="flex-1 rounded-control bg-surface px-3 py-3 text-body font-semibold text-ink"
            >
              Avbryt
            </button>
            <button
              type="button"
              onClick={save}
              disabled={unparseable && editing === "amount"}
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

          {/* Priority sits above the actions, as a segmented control rather
              than a button, because it is a STATE with three values and not a
              thing you do. A row of three buttons would make "Normal" look like
              a command; this shows which one is in force without being asked. */}
          <div className="px-4 pt-3 pb-1">
            <p className="mb-1.5 text-overline text-ink-faint uppercase">
              Hur bråttom
            </p>
            <div
              role="group"
              aria-label="Prioritet"
              className="flex gap-1 rounded-control border border-line p-1"
            >
              {PRIORITY_CHOICES.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  aria-pressed={view.priority === choice.value}
                  onClick={() => onSetPriority(choice.value)}
                  className={cn(
                    "flex-1 rounded-[0.5rem] px-2 py-2 text-caption font-semibold",
                    "transition-colors duration-150",
                    view.priority === choice.value
                      ? "bg-ink text-surface"
                      : "text-ink-soft",
                  )}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>

          <SheetActions>
            <SheetButton
              onClick={startEditing}
              icon={<UiIcon name="edit" size={16} />}
            >
              {manual?.amount ? "Ändra mängd" : "Ange mängd"}
            </SheetButton>

            <SheetButton
              onClick={startModifier}
              icon={<UiIcon name="edit" size={16} />}
            >
              {view.modifier ? `Sort: ${view.modifier}` : "Ange sort"}
            </SheetButton>

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
