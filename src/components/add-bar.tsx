"use client";

import { useMemo, useRef, useState } from "react";
import type { CatalogItem, Id } from "@/lib/domain";
import { resolveQuery } from "@/lib/services/search";
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
 *
 * It reads a query as amount + sort + vara rather than as one string to look
 * up — see `resolveQuery`. "mogen mango" used to match nothing at all, and the
 * only thing on offer was creating a second mango in Övrigt, permanently, next
 * to the one that was already there.
 */

export interface AddBarProps {
  catalog: CatalogItem[];
  /** Items already on the current list, so they can be marked rather than re-added. */
  onListItemIds: Set<Id>;
  /**
   * `modifier` is the household's qualifier read off the front of the query —
   * "mogen" from "mogen mango". Empty when nothing led the vara's name.
   */
  onPick: (itemId: Id, amountText: string, modifier: string) => void;
  onCreate: (name: string, amountText: string) => void;
}

export function AddBar({
  catalog,
  onListItemIds,
  onPick,
  onCreate,
}: AddBarProps) {
  const [raw, setRaw] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const { matches, modifier, amountText, name } = useMemo(
    () => resolveQuery(catalog, raw),
    [catalog, raw],
  );

  // Against the whole typed name, not the matched vara: typing "mogen mango"
  // resolves to mango, and creating "mogen mango" as its own vara has to stay
  // available for the household that genuinely wants it as one.
  const exact = matches.some((m) => m.nameNorm === normalizeName(name));
  const canCreate = name.length >= 2 && !exact;

  /**
   * Put the caret back in the field.
   *
   * Adding six things is one errand, not six. The suggestion row that took the
   * tap unmounts on the same frame, so without this focus falls to <body> and
   * the phone keyboard animates shut and open again between every single vara.
   * `keepFocus` on the buttons stops the blur from happening at all; this is
   * what recovers it on the platforms where preventing mousedown is not enough.
   */
  function reset() {
    setRaw("");
    input.current?.focus();
  }

  function pick(itemId: Id) {
    onPick(itemId, amountText, modifier);
    reset();
  }

  function create() {
    onCreate(name, amountText);
    reset();
  }

  // A press inside the dropdown must never take focus off the input. The click
  // still fires; only the blur is cancelled.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="relative my-3">
      <div className="flex items-center gap-2.5 rounded-card border border-line bg-surface-raised px-3 py-2.5">
        <UiIcon name="search" size={18} className="flex-none text-ink-faint" />
        <input
          ref={input}
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
            onMouseDown={keepFocus}
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
                  onMouseDown={keepFocus}
                  onClick={() => pick(item.id)}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2.5 text-left",
                    "border-b border-line last:border-b-0 active:bg-brand-tint",
                  )}
                >
                  <ItemIcon iconRef={item.iconRef} className="text-xl" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-body font-semibold text-ink">
                      {item.name}
                    </span>
                    {/* Rendered exactly as the tile will render it — italic,
                        under the name — so what you are about to get is what
                        you are looking at. */}
                    {modifier && (
                      <span className="text-caption text-ink-faint italic">
                        {modifier}
                      </span>
                    )}
                  </span>
                  {already && (
                    <span className="flex-none text-caption font-semibold text-brand">
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
                onMouseDown={keepFocus}
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
