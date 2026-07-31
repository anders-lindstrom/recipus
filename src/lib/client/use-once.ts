"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * A thing to say exactly once, ever, to this person on this device.
 *
 * There is one caller and it is the long-press hint. Half of what the list can
 * do — amounts, priority, the household's own qualifier, moving a vara to
 * another list, and taking something off WITHOUT recording a purchase — is
 * behind a 500ms hold that nothing advertises. `ItemTile` grew a press-in
 * affordance so the gesture confirms itself once you are trying it, which does
 * nothing at all for the person who never tries.
 *
 * `localStorage`, not the `sessionStorage` the shop mode uses: "once" has to
 * outlive the tab, or it becomes "every morning".
 *
 * Deliberately not synced. It is a fact about a person and a phone, not about
 * the household, and an op carrying "Anders has seen the hint" to everyone
 * else's device would be the wrong shape for a list that has to converge.
 *
 * Built on `useSyncExternalStore` for the same reason `useMode` is: storage is
 * an external store, the server has none, and reading one in an effect and
 * calling `setState` is a cascading render the linter is right to refuse.
 */

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function isPending(key: string): boolean {
  try {
    return localStorage.getItem(key) === null;
  } catch {
    // Private mode, or storage disabled. Saying nothing is the safe failure: a
    // hint that cannot record having been shown would otherwise show forever.
    return false;
  }
}

export interface UseOnceResult {
  /** True until this key has been dismissed. Always false on the server. */
  pending: boolean;
  dismiss: () => void;
}

export function useOnce(key: string): UseOnceResult {
  const pending = useSyncExternalStore(
    subscribe,
    // Recomputed rather than cached, which is safe because it returns a boolean
    // — `useSyncExternalStore` compares snapshots by identity, and two equal
    // booleans are the same value.
    useCallback(() => isPending(key), [key]),
    // The server has no storage and must not guess. Saying nothing on the
    // first paint and appearing after hydration is the only honest option;
    // guessing "pending" would flash a hint at someone who dismissed it weeks
    // ago.
    () => false,
  );

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(key, "1");
    } catch {
      // Nothing to do. Without storage the hint was never shown to begin with.
    }
    for (const listener of listeners) listener();
  }, [key]);

  return { pending, dismiss };
}
