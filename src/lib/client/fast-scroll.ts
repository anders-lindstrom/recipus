"use client";

/**
 * Programmatic scrolling with a duration we actually control.
 *
 * `scrollIntoView({ behavior: "smooth" })` was the obvious thing and it is the
 * wrong thing here: the browser owns the duration and scales it with distance,
 * so jumping from the top of the list to "Skafferi" — thousands of pixels down a
 * 341-tile catalog — took most of a second. This is a tap-tap-tap control. You
 * are standing in a shop deciding where to walk next, and waiting out an
 * animation to find out where you landed is worse than not animating at all.
 *
 * So: a fixed 180ms regardless of distance. Long enough to see which way the
 * page went, which is the entire reason not to jump instantly — an instant jump
 * gives no sense of whether "Bröd" was above or below you, and you lose your
 * bearings in a list this long. Short enough that four taps in a row feel like
 * four taps rather than a queue.
 *
 * Two cancellation paths matter as much as the duration:
 *
 *   - A second tap supersedes the first mid-flight. Tapping along the rail must
 *     not animate through every chip you passed through on the way.
 *   - Real input from the user wins instantly. An animation that fights a thumb
 *     already dragging the page is the worst possible feel.
 */

const DURATION_MS = 180;

let frame: number | null = null;
let detachInput: (() => void) | null = null;
let resolvePending: (() => void) | null = null;

/** Ends whatever is in flight and resolves its promise, so callers never hang. */
function settle(): void {
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  detachInput?.();
  detachInput = null;
  const resolve = resolvePending;
  resolvePending = null;
  resolve?.();
}

// Decelerating: fastest at the start, so the page commits to a direction
// immediately rather than easing in and feeling laggy on the first frames.
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/**
 * Scrolls the window to `targetY`.
 *
 * The returned promise always settles — on arrival, on being superseded by a
 * later call, or on the user taking over. Callers that care which of those
 * happened should guard with their own sequence number.
 */
export function scrollToY(targetY: number): Promise<void> {
  settle();

  const maxY = Math.max(
    0,
    document.documentElement.scrollHeight - window.innerHeight,
  );
  const to = Math.min(Math.max(0, targetY), maxY);
  const from = window.scrollY;
  const distance = to - from;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Sub-pixel moves are not worth a frame, and reduced-motion means no frames.
  if (reduced || Math.abs(distance) < 2) {
    window.scrollTo(0, to);
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    resolvePending = resolve;
    const startedAt = performance.now();

    const yieldToUser = () => settle();
    const passive = { passive: true } as const;
    window.addEventListener("wheel", yieldToUser, passive);
    window.addEventListener("touchstart", yieldToUser, passive);
    window.addEventListener("keydown", yieldToUser);
    detachInput = () => {
      window.removeEventListener("wheel", yieldToUser);
      window.removeEventListener("touchstart", yieldToUser);
      window.removeEventListener("keydown", yieldToUser);
    };

    const step = (now: number) => {
      const t = Math.min(1, (now - startedAt) / DURATION_MS);
      window.scrollTo(0, from + distance * easeOutCubic(t));
      if (t < 1) {
        frame = requestAnimationFrame(step);
        return;
      }
      settle();
    };
    frame = requestAnimationFrame(step);
  });
}

/**
 * Where `el` sits in the document, independent of current scroll.
 *
 * Measured rather than read off a hardcoded offset, so a notch, a visible sync
 * banner, or a future change to the header's height cannot silently start
 * landing jump targets underneath the chrome.
 */
export function documentTopOf(el: Element): number {
  return el.getBoundingClientRect().top + window.scrollY;
}
