"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * Planning at home versus shopping in the shop.
 *
 * The two modes exist for one reason: to make purchase history true. Tapping an
 * item off the list means "bought it" in a shop and "changed my mind" at the
 * kitchen table, and until now it always meant the former — so the cadence
 * engine, and soon the statistics, learned from every plan-time edit as though
 * it were a shop.
 *
 * The obvious objection to a global mode is that one gesture then means two
 * things depending on state you cannot see while walking. Three things answer
 * it: the mode is unmissable (a terracotta wash across the whole header), it is
 * one tap to flip, and every consequence of forgetting to switch falls in the
 * conservative direction — you under-record purchases, you never invent one. The
 * dangerous direction now requires you to be looking at a tinted screen.
 *
 * THE INVARIANT: the mode may decide *which* op the UI emits. It must never be
 * needed to *interpret* one. Ops carry the whole truth — `remove_item` says
 * `bought: true|false` outright — so a receiving device never has to know what
 * mode the sender was in. The day that stops being true, the mode belongs in the
 * op payload and storing it locally is wrong.
 */

export type ShopMode = "plan" | "buy";

const KEY = "recipus:mode";

/**
 * How long buy mode survives without a removal before falling back to plan.
 *
 * `sessionStorage` already dies with the tab, which is what makes "plan on cold
 * start" free rather than logic that can be forgotten. But iOS keeps a
 * backgrounded PWA session alive for a very long time, so tab death is not a
 * reliable end-of-shop signal. Three days left in buy mode would turn every
 * at-home "we don't need this after all" into a false purchase — exactly the
 * corruption the mode exists to prevent. A shop is under an hour.
 */
const IDLE_MS = 90 * 60 * 1000;

/** How often buy mode checks whether it has gone stale. Cheap; only while in buy. */
const IDLE_CHECK_MS = 60 * 1000;

interface Stored {
  mode: ShopMode;
  /** Epoch ms of the last removal. Idle is measured from doing, not from looking. */
  lastActivityAt: number;
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readStored(): Stored | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (parsed.mode !== "buy" && parsed.mode !== "plan") return null;
    return {
      mode: parsed.mode,
      lastActivityAt:
        typeof parsed.lastActivityAt === "number" ? parsed.lastActivityAt : 0,
    };
  } catch {
    // A corrupt value must not strand anyone in buy mode.
    return null;
  }
}

function write(stored: Stored): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Private-mode quota failures are survivable: the mode just stops persisting
    // across reloads, which degrades to plan — the safe direction.
  }
  emit();
}

/**
 * Deliberately free of any time arithmetic.
 *
 * `useSyncExternalStore` may call this during render and compares results by
 * identity, so a snapshot that recomputed expiry from `Date.now()` would change
 * underneath React at the moment it flipped. Expiry is applied by the interval in
 * the hook, which *writes* the demotion and then emits — so by the time it is
 * read here it is already a plain stored fact.
 */
function getSnapshot(): ShopMode {
  return readStored()?.mode ?? "plan";
}

/** Server render and first paint are always plan. There is no session there. */
function getServerSnapshot(): ShopMode {
  return "plan";
}

export interface UseModeResult {
  mode: ShopMode;
  setMode: (mode: ShopMode) => void;
  /** Call on every removal, so the idle clock measures shopping, not staring. */
  touch: () => void;
}

export function useMode(): UseModeResult {
  const mode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setMode = useCallback((next: ShopMode) => {
    write({ mode: next, lastActivityAt: Date.now() });
  }, []);

  const touch = useCallback(() => {
    const stored = readStored();
    if (!stored || stored.mode !== "buy") return;
    write({ ...stored, lastActivityAt: Date.now() });
  }, []);

  useEffect(() => {
    if (mode !== "buy") return;

    const check = () => {
      const stored = readStored();
      if (!stored || stored.mode !== "buy") return;
      if (Date.now() - stored.lastActivityAt <= IDLE_MS) return;
      write({ mode: "plan", lastActivityAt: Date.now() });
    };

    const timer = setInterval(check, IDLE_CHECK_MS);
    // Coming back to a phone that has been in a pocket for two hours should
    // demote immediately, not up to a minute later.
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [mode]);

  return { mode, setMode, touch };
}
