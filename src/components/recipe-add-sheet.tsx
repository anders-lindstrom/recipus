"use client";

import { useMemo, useState } from "react";
import type { Amount, CatalogItem, Id, Recipe } from "@/lib/domain";
import { formatAmount, scaleAmount } from "@/lib/units";
import { cn } from "@/lib/utils";
import { UiIcon } from "./ui-icon";

/**
 * Adding a recipe to a list.
 *
 * The whole point of this screen is that you can see what changed. The recipe
 * says 4 dl, you want twice as many muffins, and the sheet shows "4 dl → 8 dl"
 * rather than quietly presenting 8 and hoping you trust it. Getting this wrong
 * is how you come home with half the cream you needed.
 */

export interface RecipeAddSheetProps {
  recipe: Recipe;
  catalog: Record<Id, CatalogItem>;
  listName: string;
  onCancel: () => void;
  onConfirm: (
    scaleFactor: number,
    items: Array<{ catalogItemId: Id; amount: Amount | null }>,
  ) => void;
}

interface Row {
  ingredientId: Id;
  catalogItemId: Id | null;
  label: string;
  baseAmount: Amount | null;
  scaledAmount: Amount | null;
  isStaple: boolean;
  isNew: boolean;
}

export function RecipeAddSheet({
  recipe,
  catalog,
  listName,
  onCancel,
  onConfirm,
}: RecipeAddSheetProps) {
  const [target, setTarget] = useState(recipe.servings);
  const factor = recipe.servings > 0 ? target / recipe.servings : 1;

  const rows: Row[] = useMemo(
    () =>
      recipe.ingredients.map((ing) => {
        const catalogItem = ing.catalogItemId
          ? catalog[ing.catalogItemId]
          : undefined;
        return {
          ingredientId: ing.id,
          catalogItemId: ing.catalogItemId,
          label: catalogItem?.name ?? ing.rawText,
          baseAmount: ing.amount,
          scaledAmount: ing.amount ? scaleAmount(ing.amount, factor) : null,
          // Salt, mjöl, bakpulver: you have them, and putting them on the list
          // every single time is how a feature becomes noise.
          isStaple: catalogItem?.hasAtHome ?? false,
          isNew: !catalogItem,
        };
      }),
    [recipe.ingredients, catalog, factor],
  );

  const [excluded, setExcluded] = useState<Set<Id>>(
    () => new Set(rows.filter((r) => r.isStaple).map((r) => r.ingredientId)),
  );

  const included = rows.filter((r) => !excluded.has(r.ingredientId));

  function toggle(id: Id) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      <div className="safe-top flex-none border-b border-line bg-surface">
        <div className="flex h-12 items-center gap-2 px-2">
          <span className="flex-1 truncate pl-2 text-title text-ink">
            Lägg till i {listName}
          </span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Stäng"
            className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-ink-soft"
          >
            <UiIcon name="close" size={20} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-4">
        <div className="px-4 pt-4 pb-1">
          <h2 className="text-display text-ink">{recipe.title}</h2>
          {recipe.sourceUrl && (
            <p className="mt-1 truncate text-caption text-ink-faint">
              {new URL(recipe.sourceUrl).hostname.replace(/^www\./, "")}
            </p>
          )}
        </div>

        <div className="mx-4 mt-4 rounded-card border border-line bg-surface-raised p-4">
          <div className="mb-3 text-overline text-ink-faint uppercase">
            Hur många vill du göra?
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              aria-label="Minska"
              onClick={() => setTarget((t) => Math.max(1, t - 1))}
              className="flex h-11 w-11 flex-none items-center justify-center rounded-full border border-line-strong text-ink transition-transform duration-100 active:scale-95"
            >
              <UiIcon name="decrease" size={20} />
            </button>
            <div className="flex-1 text-center">
              <div className="text-[2rem] leading-none font-bold tracking-tight text-ink">
                {target}
              </div>
              <div className="mt-1.5 text-caption text-ink-soft">
                {recipe.servingsUnit} · receptet ger {recipe.servings}
              </div>
            </div>
            <button
              type="button"
              aria-label="Öka"
              onClick={() => setTarget((t) => t + 1)}
              className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-brand text-on-brand transition-transform duration-100 active:scale-95"
            >
              <UiIcon name="increase" size={20} />
            </button>
          </div>
          {factor !== 1 && (
            <div className="mt-3 text-center">
              <span className="inline-block rounded-full bg-brand-tint px-2.5 py-1 text-caption font-semibold text-brand-ink">
                alla mängder ×{Number(factor.toFixed(2))}
              </span>
            </div>
          )}
        </div>

        <div className="mx-4 mt-6 mb-1 flex items-baseline justify-between text-overline text-ink-faint uppercase">
          <span>Ingredienser</span>
          <span>
            {included.length} av {rows.length} läggs till
          </span>
        </div>

        {/* Rows, not cards: excluding a staple is a toggle on a line of text,
            and the old bordered boxes made each one look like its own object
            you had to consider separately. */}
        <ul className="mx-4 divide-y divide-line">
          {rows.map((row) => {
            const off = excluded.has(row.ingredientId);
            return (
              <li key={row.ingredientId}>
                <button
                  type="button"
                  onClick={() => toggle(row.ingredientId)}
                  aria-pressed={!off}
                  className="flex w-full items-center gap-3 py-3 text-left"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex h-[22px] w-[22px] flex-none items-center justify-center rounded-md transition-colors duration-150",
                      off
                        ? "border-[1.5px] border-line-strong"
                        : "bg-brand text-on-brand",
                    )}
                  >
                    {!off && <UiIcon name="check" size={14} />}
                  </span>

                  <span
                    className={cn(
                      "flex flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-body",
                      // The excluded row stays fully legible — it is a choice
                      // you might want to reverse, not a disabled control.
                      off ? "text-ink-faint line-through" : "text-ink",
                    )}
                  >
                    {row.label}
                    {row.isNew && (
                      <span className="rounded-full bg-warn-tint px-2 py-0.5 text-badge text-warn uppercase no-underline">
                        Ny vara
                      </span>
                    )}
                    {row.isStaple && (
                      <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-badge text-ink-soft uppercase no-underline">
                        Har hemma
                      </span>
                    )}
                  </span>

                  {row.baseAmount && factor !== 1 && (
                    <span className="flex-none text-caption text-ink-faint line-through">
                      {formatAmount(row.baseAmount)}
                    </span>
                  )}
                  {/* "salt efter smak" has no amount at all. An empty column is
                      honest about that; a dash looked like a parsed value. */}
                  {row.scaledAmount && (
                    <span
                      className={cn(
                        "flex-none text-body font-bold",
                        off ? "text-ink-faint" : "text-brand-ink",
                      )}
                    >
                      {formatAmount(row.scaledAmount)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="safe-bottom flex-none border-t border-line bg-surface p-3">
        <button
          type="button"
          disabled={included.length === 0}
          onClick={() =>
            onConfirm(
              factor,
              included
                // An unmatched ingredient still needs a catalog item; the caller
                // creates one before dispatching, so a null id here would be a
                // bug rather than a state to render.
                .filter((r) => r.catalogItemId !== null)
                .map((r) => ({
                  catalogItemId: r.catalogItemId!,
                  amount: r.scaledAmount,
                })),
            )
          }
          // The list name lives in the header two lines up, so it is left out
          // here: repeating it is what pushed this label onto a second line.
          className="flex w-full items-center justify-center gap-2 rounded-card bg-brand py-3.5 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.99] disabled:opacity-40"
        >
          <UiIcon name="toList" size={17} />
          Lägg till {included.length}{" "}
          {included.length === 1 ? "vara" : "varor"}
        </button>
      </div>
    </div>
  );
}
