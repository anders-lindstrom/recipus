"use client";

import { useMemo, useState } from "react";
import type { CatalogItem, Id } from "@/lib/domain";
import { rankMatches, splitQuery } from "@/lib/services/search";
import { codepointToEmoji, normalizeName } from "@/lib/utils";

/**
 * The add bar.
 *
 * Typing is the fastest way onto the list for anything not already visible, so
 * this has to behave: match on three letters, accept a quantity inline, and
 * never make creating a new item feel like filling in a form.
 */

export interface AddBarProps {
  catalog: CatalogItem[];
  /** Items already on the current list, so they can be marked rather than re-added. */
  onListItemIds: Set<Id>;
  onPick: (itemId: Id, amountText: string) => void;
  onCreate: (name: string, amountText: string) => void;
}

export function AddBar({ catalog, onListItemIds, onPick, onCreate }: AddBarProps) {
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
    <div className="relative mx-3 my-2">
      <div className="flex items-center gap-2 rounded-xl border border-line bg-paper-raised px-3 py-2.5">
        <span aria-hidden className="text-sm opacity-50">
          🔍
        </span>
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
          className="flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-faint"
        />
        {amountText && (
          <span className="rounded-full bg-brand-tint px-2 py-0.5 text-[10.5px] font-extrabold text-brand">
            {amountText}
          </span>
        )}
        {raw && (
          <button
            type="button"
            onClick={reset}
            aria-label="Rensa"
            className="text-sm text-ink-faint"
          >
            ✕
          </button>
        )}
      </div>

      {name.length >= 1 && (matches.length > 0 || canCreate) && (
        <ul className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-line bg-paper-raised shadow-lg">
          {matches.map((item) => {
            const already = onListItemIds.has(item.id);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => pick(item.id)}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left active:bg-brand-tint"
                >
                  <span aria-hidden className="text-lg">
                    {codepointToEmoji(item.iconRef)}
                  </span>
                  <span className="flex-1 text-[13.5px] font-semibold text-ink">
                    {item.name}
                  </span>
                  {already && (
                    <span className="text-[10.5px] font-bold text-brand">
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
                className="flex w-full items-center gap-2.5 border-t border-line px-3 py-2.5 text-left active:bg-brand-tint"
              >
                <span aria-hidden className="text-lg">
                  ➕
                </span>
                <span className="flex-1 text-[13.5px] text-ink">
                  Lägg till{" "}
                  <span className="font-bold">&ldquo;{name}&rdquo;</span>
                </span>
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
