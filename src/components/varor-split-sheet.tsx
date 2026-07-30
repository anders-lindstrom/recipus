"use client";

import { useMemo, useState } from "react";
import type { CatalogItem, Id } from "@/lib/domain";
import { cn, slugify } from "@/lib/utils";
import { Sheet } from "./sheet";
import { UiIcon } from "./ui-icon";
import { collidingVara, productSubtitle, type VaraView } from "./varor-model";

/**
 * Dela upp — one word becoming two.
 *
 * There is no `split_catalog_item` op and there deliberately is not one. A split
 * is a new vara plus N re-placed products, and both of those already exist as
 * ops; inventing a third would mean a reducer case that has to guess which
 * products move.
 *
 * And it cannot guess. Fourteen products under "smör" and only the household
 * knows which of them are osaltat — the name does not always say, the brand
 * never does, and a rule that got it wrong would move purchase history onto the
 * wrong word silently. So the checkbox list is not a convenience wrapped around
 * the real mechanism. **The checkbox list IS the split.**
 *
 * Nothing starts ticked, which is the opposite of the recipe-removal sheet's
 * default and for the opposite reason: there the common case is "yes, all of
 * them", here ticking everything would empty the source vara, which is a merge
 * performed backwards. The source always stays.
 */

export interface VarorSplitSheetProps {
  vara: VaraView;
  /** Every vara, so a name that would overwrite one can be refused before it does. */
  catalog: Record<Id, CatalogItem>;
  /** Creates the new vara, then moves exactly these products onto it. */
  onSplit: (name: string, productIds: Id[]) => void;
  onClose: () => void;
}

export function VarorSplitSheet({
  vara,
  catalog,
  onSplit,
  onClose,
}: VarorSplitSheetProps) {
  const [name, setName] = useState("");
  const [moving, setMoving] = useState<Set<Id>>(new Set());

  const trimmed = name.trim();
  const proposedId = slugify(trimmed);

  /**
   * A name that collides is refused rather than merged into.
   *
   * Not politeness: catalog ids are slugs of the name, so creating one that
   * already exists is a `create_catalog_item` for an existing id, and
   * last-write-wins resolves that by overwriting — renaming somebody else's vara
   * and dragging it into this one's category, with no error anywhere.
   */
  const collision = useMemo(
    () => (trimmed ? collidingVara(catalog, proposedId, trimmed) : null),
    [catalog, proposedId, trimmed],
  );

  const nameOk = trimmed.length >= 2 && proposedId.length > 0 && !collision;

  function toggle(id: Id) {
    setMoving((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const count = moving.size;
  const label = !nameOk
    ? "Skapa varan"
    : count === 0
      ? `Skapa ${trimmed}`
      : `Skapa ${trimmed} och flytta ${count} ${
          count === 1 ? "produkt" : "produkter"
        }`;

  return (
    <Sheet title={`Dela upp ${vara.item.name}`} onClose={onClose}>
      <div className="px-4 pb-3">
        <p className="text-body text-ink-soft">
          <span className="font-semibold text-ink">{vara.item.name}</span> blir
          kvar. Den nya varan får bara de produkter du bockar för.
        </p>
      </div>

      <div className="px-4">
        <label
          htmlFor="split-name"
          className="mb-1.5 block text-overline text-ink-faint uppercase"
        >
          Ny vara
        </label>
        <input
          id="split-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`osaltat ${vara.item.name}`}
          inputMode="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          className={cn(
            "w-full rounded-control border bg-surface px-3.5 py-3 text-body text-ink outline-none placeholder:text-ink-faint",
            collision ? "border-danger" : "border-line",
          )}
        />
        {/* One line, always present, so the sheet cannot change height as you
            type — a panel twitching under your thumb reads as a bug. */}
        <p
          className={cn(
            "mt-2 min-h-[1.25rem] text-caption",
            collision ? "text-danger" : "text-ink-soft",
          )}
        >
          {collision
            ? `${collision.name} finns redan. Välj ett annat namn, eller slå samman i stället.`
            : trimmed
              ? `Får samma hylla som ${vara.item.name}.`
              : "Skriv vad den nya varan ska heta."}
        </p>
      </div>

      {vara.products.length === 0 ? (
        <p className="mt-1 px-4 pb-1 text-body-sm text-ink-faint">
          {vara.item.name} har inga produkter än, så det finns inget att flytta.
          Den nya varan skapas tom.
        </p>
      ) : (
        <>
          <p className="mt-2 px-4 text-overline text-ink-faint uppercase">
            Flytta till den nya varan
          </p>
          <ul className="mx-4 mt-1 divide-y divide-line">
            {vara.products.map((product) => {
              const checked = moving.has(product.id);
              const subtitle = productSubtitle(product);
              return (
                <li key={product.id}>
                  <button
                    type="button"
                    onClick={() => toggle(product.id)}
                    aria-pressed={checked}
                    className="flex w-full items-center gap-3 py-3 text-left"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "flex h-[22px] w-[22px] flex-none items-center justify-center rounded-md transition-colors duration-150",
                        checked
                          ? "bg-brand text-on-brand"
                          : "border-[1.5px] border-line-strong",
                      )}
                    >
                      {checked && <UiIcon name="check" size={14} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-ink">
                        {product.name}
                      </span>
                      {subtitle && (
                        <span className="block truncate text-caption text-ink-faint">
                          {subtitle}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="mt-2 flex flex-col gap-2 border-t border-line p-3">
        <button
          type="button"
          disabled={!nameOk}
          onClick={() => onSplit(trimmed, [...moving])}
          className="flex w-full items-center justify-center gap-2 rounded-control bg-brand px-3 py-3 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.98] disabled:opacity-40"
        >
          <UiIcon name="plus" size={16} />
          {label}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-control bg-surface px-3 py-3 text-body font-semibold text-ink"
        >
          Avbryt
        </button>
      </div>
    </Sheet>
  );
}
