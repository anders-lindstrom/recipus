"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether the recipe sheet may pre-exclude things you probably still have.
 *
 * A flag rather than a fixed behaviour, because the thresholds behind the guess
 * are reasoned from "getting it wrong is expensive" rather than fitted to any real
 * shopping — there is no history to fit them to yet. So there has to be a way to
 * turn it off without a deploy, and turning it off has to be a hard off: the
 * exclusions are not computed at all, not merely suppressed.
 *
 * Off is not a downgrade to nothing. The reason badge still shows ("Köpt i går"),
 * so you get the same information and make the call yourself — which is the
 * cautious version of the same feature rather than a separate code path.
 *
 * Per-device and never synced, for the same reason the shop mode is: the person
 * adding a recipe is the one looking at the sheet, and this is a preference about
 * how much the app should presume, not a fact about the household.
 *
 * localStorage rather than sessionStorage, deliberately unlike the mode: a mode
 * SHOULD reset when you close the app, and a preference should not.
 */

const KEY = "recipus:fridge-guess";

const listeners = new Set<() => void>();

function read(): boolean {
  if (typeof localStorage === "undefined") return true;
  // Default on. Safe on day one by construction: with no purchase history the
  // rule excludes nothing at all, so this only starts having an effect once there
  // is enough history for it to be right about.
  return localStorage.getItem(KEY) !== "off";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Server render and first paint match the default, so hydration cannot mismatch. */
function getServerSnapshot(): boolean {
  return true;
}

export interface UseFridgeGuessResult {
  /** True when the sheet may pre-exclude. The badge shows either way. */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export function useFridgeGuess(): UseFridgeGuessResult {
  const enabled = useSyncExternalStore(subscribe, read, getServerSnapshot);

  const setEnabled = useCallback((next: boolean) => {
    try {
      localStorage.setItem(KEY, next ? "on" : "off");
    } catch {
      // A full or disabled localStorage costs the preference, nothing more —
      // and it degrades to the default, which is the conservative direction
      // only because the rule itself is conservative.
    }
    for (const listener of listeners) listener();
  }, []);

  return { enabled, setEnabled };
}
