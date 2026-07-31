"use client";

import { useState } from "react";
import type { Id, List } from "@/lib/domain";
import { cn } from "@/lib/utils";
import { ItemIcon } from "./icon";
import { Sheet } from "./sheet";
import { UiIcon } from "./ui-icon";

/**
 * Switching between lists.
 *
 * One list per shop is the point: Hemköp and Bauhaus share the household's
 * vocabulary and nothing about their layout. Switching has to be instant, so
 * this is a plain sheet over the list rather than a route change that would
 * throw away the hydrated store.
 */

export interface ListSwitcherProps {
  lists: List[];
  currentId: Id;
  onSelect: (listId: Id) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}

export function ListSwitcher({
  lists,
  currentId,
  onSelect,
  onCreate,
  onClose,
}: ListSwitcherProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed);
    setName("");
    setCreating(false);
  }

  return (
    <Sheet title="Dina listor" onClose={onClose}>
      <ul className="px-2">
        {lists.map((list) => {
          const current = list.id === currentId;
          return (
            <li key={list.id}>
              <button
                type="button"
                onClick={() => onSelect(list.id)}
                aria-current={current}
                className={cn(
                  "flex w-full items-center gap-3 rounded-control px-2 py-3 text-left",
                  current && "bg-brand-tint",
                )}
              >
                <ItemIcon iconRef={list.icon} className="text-2xl" />
                <span className="flex-1 text-body font-semibold text-ink">
                  {list.name}
                </span>
                {current && (
                  <UiIcon name="check" size={18} className="text-brand-ink" />
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-1 border-t border-line p-3">
        {creating ? (
          <div className="flex gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                // Abandoning the new-list field is not the same act as
                // dismissing the switcher, and one Escape used to do both.
                if (e.key === "Escape") {
                  e.nativeEvent.stopPropagation();
                  setCreating(false);
                }
              }}
              placeholder="Namn på listan"
              aria-label="Namn på listan"
              className="min-w-0 flex-1 rounded-control border border-line bg-surface px-3 py-2.5 text-body text-ink outline-none placeholder:text-ink-faint"
            />
            <button
              type="button"
              onClick={submit}
              className="flex-none rounded-control bg-brand px-4 py-2.5 text-body font-semibold text-on-brand"
            >
              Skapa
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex w-full items-center gap-3 rounded-control px-2 py-2 text-left text-body font-semibold text-brand"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-on-brand">
              <UiIcon name="plus" size={15} />
            </span>
            Ny lista
          </button>
        )}
      </div>
    </Sheet>
  );
}
