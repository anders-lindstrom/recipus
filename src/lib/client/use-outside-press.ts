"use client";

import { useEffect, useRef } from "react";

/**
 * A press outside a popover dismisses it — and does nothing else.
 *
 * The second half is the whole point. The add bar's panel already closed when
 * focus left it, so pressing away from it looked like it worked; what it
 * actually did was close the panel AND deliver the press to whatever was
 * underneath. On this app that is a grid of tiles where one tap takes an item
 * off the list and, in buy mode, records a purchase — so "I just wanted the
 * panel gone" quietly bought the milk. Reported exactly that way.
 *
 * Every popover convention on every platform swallows that first press. It
 * costs one extra tap for someone who genuinely meant to hit the tile, and it
 * removes an unintended write from the surface that can least afford one.
 *
 * WHY POINTERDOWN AND THEN CLICK, rather than either alone:
 *
 * Dismissing on `click` is too late — the tile's own click has already run by
 * the time the popover hears about it, and the two orders are not decidable
 * from inside a listener. Dismissing on `pointerdown` is the right moment but
 * cannot stop what follows: `preventDefault` there suppresses the compatibility
 * mouse events on touch and does NOT reliably suppress `click` from a mouse.
 *
 * So the press is caught on the way down, and a one-shot capture-phase listener
 * is armed to eat the click that belongs to it. Capture phase and
 * `stopPropagation`, so React's own delegated listener at the root never sees
 * the event at all.
 */
export function useDismissOnOutsidePress(
  active: boolean,
  within: React.RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  /**
   * Read through a ref so the listeners are attached once per open, rather than
   * torn down and rebuilt on every render because the callback is a fresh
   * closure each time.
   *
   * Kept current in an effect rather than assigned during render: a ref written
   * while rendering is a render with a side effect, which is a real hazard under
   * a compiler that may render twice and the lint rule says so.
   */
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });

  useEffect(() => {
    if (!active) return;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (within.current?.contains(target)) return;
      /**
       * A sheet opening over the popover is not the popover being dismissed.
       *
       * The same exception the blur handling already makes, and for the same
       * reason: tearing the panel down unmounts the row a sheet was opened
       * from, and the focus trap then has nothing connected to hand focus back
       * to when the sheet closes.
       */
      if (target.closest('[role="dialog"]')) return;

      swallowNextClick();
      dismiss.current();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      /**
       * The armed swallow is deliberately NOT cleaned up here.
       *
       * The press that arms it is the press that dismisses the popover, which
       * is what makes `active` false and runs this cleanup — before the click
       * it exists to eat has been dispatched. Tearing it down here would undo
       * the entire mechanism, and it expires on its own either way.
       */
    };
  }, [active, within]);
}

/**
 * Eat exactly one click: the one belonging to the press that just happened.
 *
 * It has to be able to expire unfired, which is the case worth naming. A press
 * that turns into a scroll produces no click at all, and a swallow left armed
 * would then eat the next press — a real one, made after the popover was
 * already gone. So the next `pointerdown` disarms it.
 */
function swallowNextClick(): void {
  const swallow = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    disarm();
  };
  const disarm = () => {
    document.removeEventListener("click", swallow, true);
    document.removeEventListener("pointerdown", disarm, true);
  };
  document.addEventListener("click", swallow, true);
  // Adding this during the dispatch of the very pointerdown that armed it is
  // safe: the DOM copies an object's listener list before invoking it, so one
  // added mid-dispatch is not called for that same event.
  document.addEventListener("pointerdown", disarm, true);
}
