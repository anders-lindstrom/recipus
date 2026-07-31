"use client";

import { useEffect, useRef, useState } from "react";

/**
 * True only once `active` has held for `delayMs`, and then for at least
 * `dwellMs` afterwards.
 *
 * This exists because of one specific, measured annoyance. Every tap on a tile
 * queues an op, so `pendingCount` goes 0 → 1 → 0 as the outbox drains. Locally
 * that round trip takes about 40ms, and the sync banner it drove was appearing
 * and vanishing inside that window — growing the sticky header from 49px to
 * 78px and back, which shoved the entire list down 29px and up again on every
 * single press. Unreadable, and the core loop is *tapping tiles*, so it happened
 * constantly.
 *
 * The banner's real job is to say sync is **stuck**, not that it is happening.
 * A write that lands in 40ms is not news. So the flag waits: nothing shows for a
 * fast op, and when the network genuinely is slow the message appears and then
 * stays put long enough to be read instead of blinking.
 *
 * `dwellMs` is the other half of it — without a minimum on-screen time, an op
 * that drains just after `delayMs` elapsed would reintroduce the same flash a
 * second later.
 */
export function useSustained(
  active: boolean,
  { delayMs, dwellMs }: { delayMs: number; dwellMs: number },
): boolean {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    if (active) {
      // Already up: keep it up for as long as the condition holds.
      if (shown) return;
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, delayMs);
      return () => clearTimeout(timer);
    }

    // The condition cleared before it was ever worth mentioning.
    if (!shown) return;

    const remaining = dwellMs - (Date.now() - shownAt.current);
    if (remaining <= 0) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(false), remaining);
    return () => clearTimeout(timer);
  }, [active, shown, delayMs, dwellMs]);

  return shown;
}
