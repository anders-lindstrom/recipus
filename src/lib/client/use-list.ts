"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { Id, SyncState } from "@/lib/domain";
import { activeEntries, buildEntryView, type EntryView } from "@/lib/services/entries";
import type { ListSnapshot } from "@/lib/services/list-data";
import type { Op } from "@/lib/sync";
import { createListStore, type ListStore, type StoreStatus } from "./store";

export interface UseListResult {
  state: SyncState;
  entries: EntryView[];
  status: StoreStatus;
  dispatch: (op: Op) => Promise<void>;
}

/**
 * Derive this list's tiles from raw sync state.
 *
 * Pulled out of the hook so it can be unit-tested without rendering React:
 * `useSyncExternalStore` needs a DOM to exercise properly, this computation
 * does not. `recipeAdditions` is left at buildEntryView's own default ({}) —
 * this store does not carry recipe titles (see store.ts's hydrate for why),
 * so a recipe-sourced tile's breakdown just omits the title until whatever
 * component owns recipe display supplies it.
 */
export function deriveEntryViews(state: SyncState, listId: Id): EntryView[] {
  const entries = activeEntries(
    Object.values(state.entries).filter((e) => e.listId === listId),
  );
  const contributions = Object.values(state.contributions);
  return entries.map((entry) => buildEntryView(entry, contributions));
}

/**
 * The hook the UI consumes for one list.
 *
 * Owns the store's lifecycle: creates it for (listId, actor), hydrates it
 * once from `initialSnapshot` if one was passed (typically server-fetched
 * props from `loadListSnapshot`), connects on mount and disconnects on
 * unmount. `initialSnapshot` may be omitted entirely — opening the app
 * offline must still show the real list, sourced from whatever this store
 * already persisted to IndexedDB in a previous session.
 */
export function useList(
  listId: Id,
  actor: string,
  initialSnapshot?: ListSnapshot,
): UseListResult {
  const store = useMemo<ListStore>(
    () => createListStore(listId, actor),
    [listId, actor],
  );

  const hydratedRef = useRef(false);

  useEffect(() => {
    hydratedRef.current = false;
    let cancelled = false;

    if (initialSnapshot && !hydratedRef.current) {
      hydratedRef.current = true;
      void store.hydrate(initialSnapshot).then(() => {
        if (!cancelled) store.connect();
      });
    } else {
      store.connect();
    }

    return () => {
      cancelled = true;
      store.disconnect();
    };
    // initialSnapshot is only consumed once per store instance (on the first
    // effect run for a given listId/actor); it deliberately is not a dep here
    // — a changing snapshot reference on every render must not repeatedly
    // clobber local optimistic edits with a stale re-hydrate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const status = useSyncExternalStore(store.subscribe, store.status, store.status);

  const entries = useMemo(() => deriveEntryViews(state, listId), [state, listId]);
  const dispatch = useCallback((op: Op) => store.dispatch(op), [store]);

  return { state, entries, status, dispatch };
}
