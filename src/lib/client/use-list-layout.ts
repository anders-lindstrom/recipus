"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Aisle headings, or one long grid.
 *
 * The list used to decide this for you: more than twelve things and it grew
 * aisle headings, fewer and it did not. The threshold is a reasonable guess and
 * it is still the default, but it is a guess about a household nobody has met.
 * Some people read a shop as a sequence of departments and want the headings at
 * any length; some want the shortest possible column of tiles and read the aisle
 * from the order alone. Neither is wrong, and the app has no way to tell which
 * one you are.
 *
 * Flat is NOT unordered — that is the whole point of offering it. The tiles stay
 * in the list's own walking order; what goes away is the headings, not the
 * sequence. A flat list in arbitrary order would be a different feature and a
 * worse one, because the order is what stops you walking back across the shop.
 *
 * Per-device and never synced, unlike the walking order itself. Which aisle
 * comes first is a fact about a SHOP and belongs to the list, so it lives in
 * `lists.category_order` and syncs to everyone. Whether you like headings is a
 * fact about a PERSON, and syncing it would mean one member of the household
 * silently restyling the other's screen — the same argument that keeps the shop
 * mode device-local.
 *
 * localStorage rather than sessionStorage, for the same reason as the fridge
 * guess: a mode should reset when you close the app, a preference should not.
 */

export type ListLayout = "auto" | "grouped" | "flat";

const KEY = "recipus:list-layout";

const listeners = new Set<() => void>();

function read(): ListLayout {
  if (typeof localStorage === "undefined") return "auto";
  const stored = localStorage.getItem(KEY);
  return stored === "grouped" || stored === "flat" ? stored : "auto";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Server render and first paint agree on the default, so hydration cannot mismatch. */
function getServerSnapshot(): ListLayout {
  return "auto";
}

export interface UseListLayoutResult {
  layout: ListLayout;
  setLayout: (layout: ListLayout) => void;
}

export function useListLayout(): UseListLayoutResult {
  const layout = useSyncExternalStore(subscribe, read, getServerSnapshot);

  const setLayout = useCallback((next: ListLayout) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // A full or disabled localStorage costs the preference and nothing else —
      // it degrades to "auto", which is the behaviour that shipped before there
      // was a choice at all.
    }
    for (const listener of listeners) listener();
  }, []);

  return { layout, setLayout };
}

/**
 * The preference resolved against the list in front of you.
 *
 * "auto" keeps the old rule — headings once the list stops fitting on a screen —
 * so a household that never opens the setting sees exactly what it saw before.
 */
export function groupingFor(layout: ListLayout, autoWouldGroup: boolean): boolean {
  if (layout === "grouped") return true;
  if (layout === "flat") return false;
  return autoWouldGroup;
}
