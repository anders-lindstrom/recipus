"use client";

import type { Category, Id, List } from "@/lib/domain";
import { moveCategory, orderedCategories } from "@/lib/services/entries";
import type { ListLayout } from "@/lib/client/use-list-layout";
import { cn } from "@/lib/utils";
import { ItemIcon } from "./icon";
import { Sheet } from "./sheet";
import { UiIcon } from "./ui-icon";

/**
 * How this shop is laid out, and how you want to read it.
 *
 * Two settings that look alike and are not, which is why they are labelled apart
 * rather than merged into one "view" section:
 *
 *   The ORDER is a fact about the shop. Hemköp puts fruit inside the door and
 *   Ica puts the bakery there, and the whole reason a household keeps a list per
 *   shop is that they share a vocabulary and nothing about their layout. So it
 *   lives on the list, syncs to every phone, and everyone benefits from one
 *   person getting it right.
 *
 *   The VIEW is a fact about a person. Whether you want aisle headings or one
 *   long grid is a reading preference, and syncing it would mean one member of
 *   the household silently restyling the other's screen mid-shop.
 *
 * The order is the one that repays the effort. Anything the app has not been
 * told about sorts last, and "Övrigt" is where every vara the add bar invents
 * begins — so an unedited list sends you back across the shop for exactly the
 * things you added yourself.
 */

const LAYOUTS: ReadonlyArray<{
  value: ListLayout;
  label: string;
  hint: string;
}> = [
  {
    value: "auto",
    label: "Automatiskt",
    // Names the rule rather than calling itself "smart": a setting whose
    // behaviour you cannot predict is one you cannot choose between.
    hint: "Rubriker när listan blivit lång",
  },
  { value: "grouped", label: "Avdelningar", hint: "Alltid rubriker" },
  { value: "flat", label: "En lång lista", hint: "Samma ordning, utan rubriker" },
];

export interface ListLayoutSheetProps {
  list: List;
  categories: Category[];
  layout: ListLayout;
  onLayoutChange: (layout: ListLayout) => void;
  /** Takes the WHOLE order — see `moveCategory` for why it is never partial. */
  onOrderChange: (categoryOrder: Id[]) => void;
  onClose: () => void;
}

export function ListLayoutSheet({
  list,
  categories,
  layout,
  onLayoutChange,
  onOrderChange,
  onClose,
}: ListLayoutSheetProps) {
  // Derived from the live list on every render rather than held in state: the
  // order is synced, so a partner reordering it while this sheet is open has to
  // be visible here instead of being overwritten by a stale local copy.
  const ordered = orderedCategories(categories, list.categoryOrder);
  const order = ordered.map((c) => c.id);

  function move(categoryId: Id, direction: -1 | 1) {
    const next = moveCategory(order, categoryId, direction);
    if (next !== order) onOrderChange(next);
  }

  return (
    <Sheet title={`Ordning i ${list.name}`} onClose={onClose}>
      <div className="px-4 pb-1">
        <p className="text-body text-ink-soft">
          Ordningen gäller listan och syns för alla i hushållet. Vyn gäller bara
          den här telefonen.
        </p>
      </div>

      <div className="px-4 pt-4">
        <div className="mb-1.5 text-overline text-ink-faint uppercase">Vy</div>
        <div
          role="group"
          aria-label="Vy"
          className="flex gap-1 rounded-control border border-line p-1"
        >
          {LAYOUTS.map((choice) => (
            <button
              key={choice.value}
              type="button"
              aria-pressed={layout === choice.value}
              onClick={() => onLayoutChange(choice.value)}
              className={cn(
                "min-h-11 flex-1 rounded-[0.5rem] px-1.5 py-2 text-caption font-semibold",
                "transition-colors duration-150",
                layout === choice.value
                  ? "bg-ink text-surface"
                  : "text-ink-soft",
              )}
            >
              {choice.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 min-h-[1.125rem] text-caption text-ink-faint">
          {LAYOUTS.find((c) => c.value === layout)?.hint}
        </p>
      </div>

      <div className="px-4 pt-4 pb-1">
        <div className="mb-1 text-overline text-ink-faint uppercase">
          Avdelningar i gångordning
        </div>
        <p className="text-caption text-ink-faint">
          Först i listan är det du går förbi först.
        </p>
      </div>

      {/* Buttons, not a drag handle. Dragging inside a sheet that scrolls
          vertically is a fight on a touchscreen, and it has no keyboard route at
          all — which is the same hole the long-press tier already has. */}
      <ul className="mx-2 mt-1 pb-2">
        {ordered.map((category, i) => (
          <li
            key={category.id}
            className="flex items-center gap-2 rounded-control px-2 py-1"
          >
            <span className="w-5 flex-none text-right text-caption tabular-nums text-ink-faint">
              {i + 1}
            </span>
            <ItemIcon iconRef={category.icon} className="flex-none text-xl" />
            <span className="min-w-0 flex-1 truncate text-body text-ink">
              {category.name}
            </span>
            <button
              type="button"
              disabled={i === 0}
              onClick={() => move(category.id, -1)}
              aria-label={`Flytta ${category.name} tidigare`}
              className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-ink-soft disabled:opacity-25"
            >
              <UiIcon name="chevronDown" size={18} className="rotate-180" />
            </button>
            <button
              type="button"
              disabled={i === ordered.length - 1}
              onClick={() => move(category.id, 1)}
              aria-label={`Flytta ${category.name} senare`}
              className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-ink-soft disabled:opacity-25"
            >
              <UiIcon name="chevronDown" size={18} />
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
