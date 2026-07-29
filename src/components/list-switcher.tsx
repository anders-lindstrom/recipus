"use client";

import { useState } from "react";
import type { Id, List } from "@/lib/domain";
import { ItemIcon } from "./icon";

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
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/30"
      role="dialog"
      aria-modal="true"
      aria-label="Byt lista"
      onClick={onClose}
    >
      <div
        className="safe-bottom w-full rounded-t-2xl border-t border-line bg-paper-raised"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-4 pt-4 pb-3 text-[10.5px] font-extrabold tracking-[0.11em] text-ink-faint uppercase">
          Dina listor
        </div>

        <ul>
          {lists.map((list) => (
            <li key={list.id}>
              <button
                type="button"
                onClick={() => onSelect(list.id)}
                aria-current={list.id === currentId}
                className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-brand-tint"
              >
                <ItemIcon iconRef={list.icon} className="text-xl" />
                <span className="flex-1 text-[14px] font-semibold text-ink">
                  {list.name}
                </span>
                {list.id === currentId && (
                  <span aria-hidden className="text-brand">
                    ✓
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>

        <div className="border-t border-line px-4 py-3">
          {creating ? (
            <div className="flex gap-2">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                  if (e.key === "Escape") setCreating(false);
                }}
                placeholder="Namn på listan"
                aria-label="Namn på listan"
                className="flex-1 rounded-lg border border-line bg-paper px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-faint"
              />
              <button
                type="button"
                onClick={submit}
                className="rounded-lg bg-brand px-4 py-2 text-[13px] font-bold text-white"
              >
                Skapa
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-3 py-1 text-left text-[14px] font-semibold text-brand"
            >
              <span aria-hidden className="text-xl">
                ➕
              </span>
              Ny lista
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
