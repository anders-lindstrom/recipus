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

/**
 * `localStorage`, so buy mode survives being killed and relaunched.
 *
 * This was `sessionStorage`, which made "plan on cold start" free rather than
 * logic that can be forgotten. What that missed is which feature causes cold
 * starts: the scanner holds a camera open on a phone, so the part of the app
 * most likely to be killed for memory is the part you use *in the shop*. Coming
 * back as "Planerar" mid-shop is silent — you carry on ticking things off and
 * none of them are recorded as bought — and the terracotta wash going away is
 * easy to miss when you are looking at a shelf rather than at the screen.
 *
 * Giving up the free guarantee costs less than it looks, because it stops being
 * free the moment a relaunch is allowed to restore anything at all: whichever
 * store holds the mode, a wrong restore rule strands you in buy mode either way.
 * So there is one store, and one rule — `modeAfterIdle` — that answers both what
 * an open app decays to and what a relaunched one comes back as.
 */
const KEY = "recipus:mode";

/**
 * How long buy mode survives without a removal before falling back to plan.
 *
 * Now the only thing that ends buy mode, which is why it answers two questions
 * at once: when an app that is open demotes itself, and how recently you must
 * have been shopping for a relaunch to pick buy mode back up. Closing is not an
 * end-of-shop signal in either direction — iOS keeps a backgrounded PWA alive
 * for a very long time and kills a camera-holding one without warning — so the
 * clock has to measure the shopping instead. Three days left in buy mode would
 * turn every at-home "we don't need this after all" into a false purchase,
 * exactly the corruption the mode exists to prevent. A shop is under an hour.
 */
const IDLE_MS = 90 * 60 * 1000;

/** How often buy mode checks whether it has gone stale. Cheap; only while in buy. */
const IDLE_CHECK_MS = 60 * 1000;

interface Stored {
  mode: ShopMode;
  /** Epoch ms of the last removal. Idle is measured from doing, not from looking. */
  lastActivityAt: number;
}

/**
 * What a stored mode has decayed into by `now` — the whole idle rule, stated
 * once.
 *
 * Two callers ask it at two different moments: the timer inside a running app,
 * and the launch that has just read a mode left behind by a previous one. They
 * have to agree. A separate "restore window" constant would be a second timer
 * competing with this one, and the way it fails is not symmetrical — a restore
 * window longer than the idle window puts you back in buy mode at breakfast for
 * a shop that ended last night, and every tap after that invents a purchase.
 *
 * Pure, and exported, because that disagreement is the kind of thing that is
 * invisible in a running app and obvious in a test.
 */
export function modeAfterIdle(stored: Stored | null, now: number): ShopMode {
  if (!stored || stored.mode !== "buy") return "plan";
  return now - stored.lastActivityAt > IDLE_MS ? "plan" : "buy";
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  /*
   * One shared fact now, so this tab has to hear about the other one.
   *
   * `sessionStorage` gave every tab its own copy and no way to disagree.
   * `localStorage` is shared, and the disagreement that matters is a second tab
   * still rendering buy mode after the shop ended in the first — that one
   * records purchases nobody made, which is the direction the mode exists to
   * make impossible.
   *
   * Deliberately unfiltered by key: the snapshot is a string, so a `storage`
   * event for some other key costs one read that React then bails out on.
   */
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readStored(): Stored | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
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
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Private-mode quota failures are survivable: the mode just stops persisting
    // past this render, which degrades to plan — the safe direction.
  }
  emit();
}

/**
 * Write the demotion that time has already made.
 *
 * The applier for `modeAfterIdle`, shared by the launch and by the running
 * timer, so the rule has exactly one implementation as well as one statement.
 * Note that it only ever writes plan: buy mode is something a person asks for,
 * never something the clock hands back.
 */
function demoteIfStale(): void {
  const stored = readStored();
  if (!stored || stored.mode !== "buy") return;
  if (modeAfterIdle(stored, Date.now()) === "buy") return;
  write({ mode: "plan", lastActivityAt: Date.now() });
}

/*
 * Settle the launch here, at module load, before React has rendered anything.
 *
 * An effect would be late in the one direction that matters. A stale buy mode
 * would paint the terracotta wash first and demote afterwards, and a tap inside
 * that window records a purchase nobody made — the failure the whole mode exists
 * to prevent, arriving through the mechanism meant to prevent it. Deciding it
 * before first paint means the first thing anyone can see or touch is already
 * true.
 *
 * Safe on the server, where `readStored` finds no `localStorage` and returns
 * null, and safe to re-run on a Fast Refresh: it writes at most one demotion.
 */
demoteIfStale();

/**
 * Deliberately free of any time arithmetic.
 *
 * `useSyncExternalStore` may call this during render and compares results by
 * identity, so a snapshot that recomputed expiry from `Date.now()` would change
 * underneath React at the moment it flipped. Expiry is *written* instead — once
 * at module load, and then by the interval in the hook — so by the time it is
 * read here it is already a plain stored fact.
 */
function getSnapshot(): ShopMode {
  return readStored()?.mode ?? "plan";
}

/**
 * Server render and first paint are always plan. There is no storage there.
 *
 * So a relaunch that restores buy mode shows "Planerar" for the one frame
 * between hydrating and reading storage. That is unavoidable with a mode the
 * server cannot know, and it is the right direction to be wrong in for that
 * frame: the header understating the mode makes nobody tap faster, while
 * overstating it is how a purchase gets invented.
 */
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

    const timer = setInterval(demoteIfStale, IDLE_CHECK_MS);
    // Coming back to a phone that has been in a pocket for two hours should
    // demote immediately, not up to a minute later.
    document.addEventListener("visibilitychange", demoteIfStale);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", demoteIfStale);
    };
  }, [mode]);

  useScreenAwakeWhile(mode === "buy");

  return { mode, setMode, touch };
}

/**
 * Keep the screen on while the household is actually shopping.
 *
 * Buy mode is already the app's answer to "am I in a shop right now", and it
 * demotes itself after 90 minutes idle — so the lock has a natural end and
 * cannot quietly hold the screen on overnight. That existing signal is the
 * whole reason this is cheap: nothing new has to decide when shopping stops.
 *
 * Without it the phone sleeps between every aisle, and the list is a thing you
 * unlock your phone to see rather than a thing you glance at. It is the
 * smallest change in this pass and the one most visible on a Saturday.
 *
 * Released on demote, on unmount, and by the browser itself whenever the page
 * is hidden — which is why it is re-acquired on `visibilitychange`: coming back
 * to the app from the camera or a message must restore the lock, not silently
 * lose it. Every step is optional-chained past: Safari on iOS gained
 * `wakeLock` late, and an unsupported browser must degrade to today's
 * behaviour rather than throw on a shopping trip.
 */
function useScreenAwakeWhile(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) {
      return;
    }

    let sentinel: WakeLockSentinel | null = null;
    let released = false;

    async function acquire(): Promise<void> {
      if (released || document.visibilityState !== "visible") return;
      try {
        sentinel = (await navigator.wakeLock?.request("screen")) ?? null;
      } catch {
        // Denied, or the tab lost focus mid-request. A phone that sleeps is
        // the behaviour we already shipped; nothing here is worth an error.
      }
    }

    function onVisibility(): void {
      if (document.visibilityState === "visible") void acquire();
    }

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release().catch(() => {});
    };
  }, [active]);
}
