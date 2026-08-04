"use client";

import { useState } from "react";
import type { Recipe } from "@/lib/domain";
import { Sheet } from "./sheet";
import { UiIcon } from "./ui-icon";

/**
 * Editing what a household owns about a recipe.
 *
 * Four fields, and the boundary between them and everything else is the point:
 * the title, what the quantities are for, the method, and their own note. Not
 * the ingredient lines — a line points at a vara, that pointer is maintained by
 * merges and by the add-to-list flow, and letting someone retype "2 dl grädde"
 * here would silently orphan it. Correcting a bad import means re-importing;
 * correcting a bad METHOD is what this is for.
 *
 * The method is edited as ONE TEXTAREA, one step per line, rather than as a
 * list of per-step fields with add and remove buttons. That is the whole design
 * decision in this file. Steps get reordered, split and merged while you cook
 * with a recipe, and every one of those is a normal text edit in a textarea and
 * a small construction project in a list of fields — which is also, not
 * incidentally, exactly how the method arrives from a page you paste from.
 */

export interface RecipeEdit {
  title: string;
  servings: number;
  servingsUnit: string;
  instructions: string[];
  notes: string | null;
}

export interface RecipeEditSheetProps {
  recipe: Recipe;
  saving: boolean;
  onSave: (edit: RecipeEdit) => void;
  onClose: () => void;
}

/** One step per line. Blank lines are separators people type, not steps. */
function toSteps(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function RecipeEditSheet({
  recipe,
  saving,
  onSave,
  onClose,
}: RecipeEditSheetProps) {
  const [title, setTitle] = useState(recipe.title);
  const [servings, setServings] = useState(String(recipe.servings));
  const [servingsUnit, setServingsUnit] = useState(recipe.servingsUnit);
  const [method, setMethod] = useState(recipe.instructions.join("\n"));
  const [notes, setNotes] = useState(recipe.notes ?? "");

  const titleOk = title.trim().length > 0;
  // Parsed rather than trusted: `type="number"` still hands back "" and "-",
  // and a recipe that serves zero divides by zero in the scaler.
  const servingsValue = Number(servings.replace(",", "."));
  const servingsOk = Number.isFinite(servingsValue) && servingsValue > 0;
  const canSave = titleOk && servingsOk && !saving;

  function save() {
    if (!canSave) return;
    onSave({
      title: title.trim(),
      servings: servingsValue,
      servingsUnit: servingsUnit.trim() || "portioner",
      instructions: toSteps(method),
      // Empty is no note. The column is nullable so "never written" and
      // "cleared" CAN differ; nothing in the app needs them to, and storing ""
      // would put an empty heading on the screen.
      notes: notes.trim() || null,
    });
  }

  return (
    <Sheet title="Redigera recept" onClose={onClose}>
      <div className="flex flex-col gap-4 px-4 pb-4">
        <div>
          <label
            htmlFor="recipe-title"
            className="mb-1.5 block text-overline text-ink-faint uppercase"
          >
            Titel
          </label>
          <input
            id="recipe-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-control border border-line bg-surface px-3.5 py-3 text-body text-ink outline-none"
          />
        </div>

        <div className="flex gap-2">
          <div className="w-24 flex-none">
            <label
              htmlFor="recipe-servings"
              className="mb-1.5 block text-overline text-ink-faint uppercase"
            >
              Antal
            </label>
            <input
              id="recipe-servings"
              value={servings}
              onChange={(e) => setServings(e.target.value)}
              // `decimal`, not `numeric`: half a recipe is a real thing to want
              // and a Swedish keyboard writes it with a comma, which `Number`
              // does not read — hence the replace above.
              inputMode="decimal"
              className="w-full rounded-control border border-line bg-surface px-3.5 py-3 text-body text-ink outline-none"
            />
          </div>
          <div className="min-w-0 flex-1">
            <label
              htmlFor="recipe-servings-unit"
              className="mb-1.5 block text-overline text-ink-faint uppercase"
            >
              Vad då?
            </label>
            <input
              id="recipe-servings-unit"
              value={servingsUnit}
              onChange={(e) => setServingsUnit(e.target.value)}
              placeholder="portioner"
              className="w-full rounded-control border border-line bg-surface px-3.5 py-3 text-body text-ink outline-none"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="recipe-method"
            className="mb-1.5 block text-overline text-ink-faint uppercase"
          >
            Gör så här
          </label>
          <textarea
            id="recipe-method"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            rows={8}
            placeholder={"Ett steg per rad.\nSätt ugnen på 225°.\nBlanda det torra."}
            className="w-full resize-y rounded-control border border-line bg-surface px-3.5 py-3 text-body text-ink outline-none"
          />
          <p className="mt-1 text-caption text-ink-soft">
            Ett steg per rad. Numrera inte — det gör appen.
          </p>
        </div>

        <div>
          <label
            htmlFor="recipe-notes"
            className="mb-1.5 block text-overline text-ink-faint uppercase"
          >
            Er anteckning
          </label>
          <textarea
            id="recipe-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Dubbla såsen. Barnen äter inte kapris."
            className="w-full resize-y rounded-control border border-line bg-surface px-3.5 py-3 text-body text-ink outline-none"
          />
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-control bg-surface px-3 py-3 text-body font-semibold text-ink"
          >
            Avbryt
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={save}
            className="flex flex-1 items-center justify-center gap-2 rounded-control bg-brand px-3 py-3 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.98] disabled:opacity-40"
          >
            {saving && <UiIcon name="spinner" size={16} className="animate-spin" />}
            Spara
          </button>
        </div>
      </div>
    </Sheet>
  );
}
