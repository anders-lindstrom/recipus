"use client";

import { useMemo, useState } from "react";
import type { Amount, CatalogItem, Id, Recipe } from "@/lib/domain";
import { probablyStillHave, type CadenceStats } from "@/lib/cadence";
import { useFridgeGuess } from "@/lib/client/use-fridge-guess";
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
  /** Household purchase cadence, for the "you probably still have this" guess. */
  purchaseStats: Record<Id, CadenceStats>;
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
  /** Set when purchase history says the cupboard probably covers this. */
  stillHave: string | null;
}

/**
 * "Köpt i går" and friends, or null when the guess does not apply.
 *
 * Returns the REASON rather than a boolean, because the reason is what makes a
 * pre-exclusion defensible: an ingredient quietly missing from the list is
 * alarming, and one labelled "Köpt i går" is obvious.
 */
function stillHaveReason(
  stats: CadenceStats | undefined,
  scaledAmount: Amount | null,
): string | null {
  if (!stats || !probablyStillHave(stats, scaledAmount)) return null;
  const days = Math.round(stats.daysSinceLast ?? 0);
  if (days <= 0) return "Köpt i dag";
  if (days === 1) return "Köpt i går";
  return `Köpt för ${days} dgr sedan`;
}

export function RecipeAddSheet({
  recipe,
  catalog,
  purchaseStats,
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
          // The perishable sibling of `hasAtHome`: not "always in the cupboard"
          // but "bought recently enough, and little enough is wanted, that it
          // almost certainly still is". Always computed so the reason can be
          // shown; whether it pre-excludes is the flag's business.
          stillHave: stillHaveReason(
            ing.catalogItemId ? purchaseStats[ing.catalogItemId] : undefined,
            ing.amount ? scaleAmount(ing.amount, factor) : null,
          ),
        };
      }),
    [recipe.ingredients, catalog, factor, purchaseStats],
  );

  const { enabled: guessEnabled, setEnabled: setGuessEnabled } = useFridgeGuess();

  // Computed once, from the rows as they were on open. Deliberately not derived
  // state: after this you are editing YOUR choices, and a guess that reasserted
  // itself when you changed the serving count would fight you.
  const [excluded, setExcluded] = useState<Set<Id>>(
    () =>
      new Set(
        rows
          .filter((r) => r.isStaple || (guessEnabled && r.stillHave))
          .map((r) => r.ingredientId),
      ),
  );

  const included = rows.filter((r) => !excluded.has(r.ingredientId));
  const autoExcluded = rows.filter(
    (r) => excluded.has(r.ingredientId) && (r.isStaple || r.stillHave),
  ).length;

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

        {/* One tap back to "everything", so a wrong guess costs nothing. The
            counter above already says how many were dropped; this is the undo. */}
        {autoExcluded > 0 && (
          <div className="mx-4 mb-1">
            <button
              type="button"
              onClick={() => setExcluded(new Set())}
              className="text-caption font-semibold text-brand"
            >
              Lägg till allt ändå
            </button>
          </div>
        )}

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
                    {/* The reason, not just the fact. An ingredient silently
                        missing from the list is alarming; one labelled "Köpt i
                        går" explains itself. Shown whether or not the flag let
                        it pre-exclude, so turning the guess off downgrades to
                        information rather than to nothing. */}
                    {row.stillHave && (
                      <span className="rounded-full bg-brand-tint px-2 py-0.5 text-badge text-brand-ink uppercase no-underline">
                        {row.stillHave}
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

      {/* The flag lives here rather than in a settings screen: this sheet is the
          only place the guess has any effect, so it is the only place the
          question makes sense. Off keeps the badges and drops the presumption. */}
      <div className="mx-4 mt-5 mb-2 flex items-center gap-3 border-t border-line pt-4">
        <div className="flex-1">
          <div className="text-body-sm font-semibold text-ink">
            Hoppa över sånt vi nyligen köpt
          </div>
          <div className="mt-0.5 text-caption text-ink-soft">
            Gäller bara små mängder av varor med köphistorik.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={guessEnabled}
          aria-label="Hoppa över sånt vi nyligen köpt"
          onClick={() => setGuessEnabled(!guessEnabled)}
          className={cn(
            "relative h-7 w-12 flex-none rounded-full transition-colors duration-150",
            guessEnabled ? "bg-brand" : "bg-line-strong",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "absolute top-1 h-5 w-5 rounded-full bg-white transition-[left] duration-150",
              guessEnabled ? "left-6" : "left-1",
            )}
          />
        </button>
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
