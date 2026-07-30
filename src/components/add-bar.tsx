"use client";

import { useMemo, useState } from "react";
import type { CatalogItem, Id } from "@/lib/domain";
import { rankMatches, splitQuery } from "@/lib/services/search";
import { cn, normalizeName } from "@/lib/utils";
import { ItemIcon } from "./icon";
import { UiIcon } from "./ui-icon";

/**
 * The add bar.
 *
 * Typing is the fastest way onto the list for anything not already visible, so
 * this has to behave: match on three letters, accept a quantity inline, and
 * never make creating a new item feel like filling in a form.
 *
 * It scrolls away with the page rather than pinning. The header already carries
 * the list name and the aisle rail; a third pinned bar would eat a fifth of a
 * phone screen to save one flick back to the top, and the rail's "Listan"
 * button is that flick.
 */

export interface AddBarProps {
  catalog: CatalogItem[];
  /** Items already on the current list, so they can be marked rather than re-added. */
  onListItemIds: Set<Id>;
  onPick: (itemId: Id, amountText: string) => void;
  onCreate: (name: string, amountText: string) => void;
}

export function AddBar({
  catalog,
  onListItemIds,
  onPick,
  onCreate,
}: AddBarProps) {
  const [raw, setRaw] = useState("");
  const { name, amountText } = useMemo(() => splitQuery(raw), [raw]);
  const matches = useMemo(() => rankMatches(catalog, name), [catalog, name]);

  const exact = matches.find((m) => m.nameNorm === normalizeName(name));
  const canCreate = name.length >= 2 && !exact;

  function reset() {
    setRaw("");
  }

  function pick(itemId: Id) {
    onPick(itemId, amountText);
    reset();
  }

  function create() {
    onCreate(name, amountText);
    reset();
  }

  return (
    <div className="relative my-3">
      <div className="flex items-center gap-2.5 rounded-card border border-line bg-surface-raised px-3 py-2.5">
        <UiIcon name="search" size={18} className="flex-none text-ink-faint" />
        <input
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") reset();
            if (e.key !== "Enter") return;
            // Enter takes the top match, or creates when nothing matched. The
            // whole point is never having to reach for the mouse mid-sentence.
            if (matches.length > 0) pick(matches[0].id);
            else if (canCreate) create();
          }}
          placeholder="Lägg till vara…"
          aria-label="Sök eller lägg till vara"
          enterKeyHint="done"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-faint"
        />
        {amountText && (
          <span className="flex-none rounded-full bg-brand-tint px-2 py-0.5 text-caption font-bold text-brand-ink">
            {amountText}
          </span>
        )}
        {raw && (
          <button
            type="button"
            onClick={reset}
            aria-label="Rensa"
            className="-mr-1 flex h-7 w-7 flex-none items-center justify-center rounded-full text-ink-faint"
          >
            <UiIcon name="clear" size={16} />
          </button>
        )}
      </div>

      {name.length >= 1 && (matches.length > 0 || canCreate) && (
        <ul className="absolute inset-x-0 top-full z-30 mt-1.5 overflow-hidden rounded-card border border-line bg-surface-raised shadow-xl shadow-black/10">
          {matches.map((item) => {
            const already = onListItemIds.has(item.id);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => pick(item.id)}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2.5 text-left",
                    "border-b border-line last:border-b-0 active:bg-brand-tint",
                  )}
                >
                  <ItemIcon iconRef={item.iconRef} className="text-xl" />
                  <span className="flex-1 text-body font-semibold text-ink">
                    {item.name}
                  </span>
                  {already && (
                    <span className="text-caption font-semibold text-brand">
                      på listan
                    </span>
                  )}
                </button>
              </li>
            );
          })}

          {canCreate && (
            <li>
              <button
                type="button"
                onClick={create}
                className="flex w-full items-center gap-3 border-t border-line px-3 py-2.5 text-left active:bg-brand-tint"
              >
                <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-brand text-on-brand">
                  <UiIcon name="plus" size={13} />
                </span>
                <span className="flex-1 text-body text-ink-soft">
                  Lägg till{" "}
                  <span className="font-bold text-ink">
                    &ldquo;{name}&rdquo;
                  </span>
                </span>
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
