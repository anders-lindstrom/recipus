"use client";

import { useMemo, useState } from "react";
import type { Amount, CatalogItem, Id, Recipe } from "@/lib/domain";
import { formatAmount, scaleAmount } from "@/lib/units";

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
    <div className="fixed inset-0 z-50 flex flex-col bg-paper">
      <div className="flex items-center gap-2 bg-brand px-4 py-3 text-white">
        <span className="flex-1 text-base font-bold">
          Lägg till i {listName}
        </span>
        <button type="button" onClick={onCancel} aria-label="Stäng">
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pb-4">
        <div className="px-4 pt-3 pb-1">
          <h2 className="text-[17px] font-extrabold tracking-tight text-ink">
            {recipe.title}
          </h2>
          {recipe.sourceUrl && (
            <p className="mt-0.5 truncate text-[11px] text-ink-faint">
              {new URL(recipe.sourceUrl).hostname.replace(/^www\./, "")}
            </p>
          )}
        </div>

        <div className="mx-3 mb-3 rounded-card border border-line bg-paper-raised p-3">
          <div className="mb-2 text-[10.5px] font-extrabold tracking-[0.1em] text-ink-faint uppercase">
            Hur många vill du göra?
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Minska"
              onClick={() => setTarget((t) => Math.max(1, t - 1))}
              className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-brand text-xl font-bold text-brand"
            >
              −
            </button>
            <div className="flex-1 text-center">
              <div className="text-2xl leading-none font-extrabold tracking-tight text-ink">
                {target}
              </div>
              <div className="mt-1 text-[11px] text-ink-soft">
                {recipe.servingsUnit} · receptet ger {recipe.servings}
              </div>
            </div>
            <button
              type="button"
              aria-label="Öka"
              onClick={() => setTarget((t) => t + 1)}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-xl font-bold text-white"
            >
              +
            </button>
          </div>
          {factor !== 1 && (
            <div className="mt-2 text-center">
              <span className="inline-block rounded-full bg-brand-tint px-2 py-1 text-[10.5px] font-extrabold text-brand">
                alla mängder ×{Number(factor.toFixed(2))}
              </span>
            </div>
          )}
        </div>

        <div className="mx-4 mb-2 flex justify-between text-[10.5px] font-extrabold tracking-[0.1em] text-ink-faint uppercase">
          <span>Ingredienser</span>
          <span>
            {included.length} av {rows.length} läggs till
          </span>
        </div>

        {rows.map((row) => {
          const off = excluded.has(row.ingredientId);
          return (
            <button
              key={row.ingredientId}
              type="button"
              onClick={() => toggle(row.ingredientId)}
              aria-pressed={!off}
              className={`mx-3 mb-1.5 flex w-[calc(100%-1.5rem)] items-center gap-2.5 rounded-[10px] border border-line bg-paper-raised px-3 py-2 text-left ${
                off ? "opacity-45" : ""
              }`}
            >
              <span
                aria-hidden
                className={`flex h-[19px] w-[19px] flex-none items-center justify-center rounded-md text-[11px] ${
                  off
                    ? "border-[1.5px] border-ink-faint"
                    : "bg-brand text-white"
                }`}
              >
                {off ? "" : "✓"}
              </span>

              <span className="flex-1 text-[13px] font-semibold text-ink">
                {row.label}
                {row.isNew && (
                  <span className="ml-1.5 rounded-lg bg-warn/20 px-1.5 py-0.5 text-[9px] font-extrabold text-warn">
                    NY VARA
                  </span>
                )}
                {row.isStaple && (
                  <span className="ml-1.5 rounded-lg bg-line px-1.5 py-0.5 text-[9px] font-bold text-ink-soft">
                    HAR HEMMA
                  </span>
                )}
              </span>

              {row.baseAmount && factor !== 1 && (
                <span className="mr-1 text-[10px] font-semibold text-ink-faint line-through">
                  {formatAmount(row.baseAmount)}
                </span>
              )}
              <span
                className={`text-[13px] font-extrabold tracking-tight ${
                  off ? "text-ink" : "text-brand"
                }`}
              >
                {row.scaledAmount ? formatAmount(row.scaledAmount) : "—"}
              </span>
            </button>
          );
        })}
      </div>

      <div className="safe-bottom px-3 pb-3">
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
          className="w-full rounded-card bg-brand py-3.5 text-center text-sm font-extrabold text-white disabled:opacity-40"
        >
          Lägg till {included.length} varor i {listName}
        </button>
      </div>
    </div>
  );
}
