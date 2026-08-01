"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Press and hold, on anything.
 *
 * Lifted verbatim out of `ItemTile`, which owned the only copy — and that was
 * the reason the add bar's search results had no second tier at all. Long-press
 * is how this app reaches everything rare (amount, sort, priority, hiding a
 * vara), so a surface that offers a vara and cannot be held is a surface where
 * half the app does not exist. Search results are exactly such a surface, and
 * "broccoli is already on the list, I want the frozen one too" is exactly the
 * errand that dies there.
 *
 * A hook rather than a wrapper component, because the two callers draw
 * completely different things — a 92px tile and a full-width list row — and
 * share nothing but the gesture.
 */

/**
 * Long enough not to fire while scrolling a grid, short enough not to feel
 * broken. Unchanged from the tile, deliberately: one gesture to learn.
 */
const LONG_PRESS_MS = 500;

export interface LongPress {
  /** Spread onto the pressable element. */
  handlers: {
    onClick: (e: React.MouseEvent) => void;
    onPointerDown: () => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onPointerLeave: () => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onContextMenu: (e: React.MouseEvent) => void;
  };
  /** True while the timer is filling, for the press-in affordance. */
  holding: boolean;
}

export function useLongPress(
  onTap: () => void,
  onLongPress?: () => void,
): LongPress {
  // Refs, not render-locals: acting re-renders the caller, and a plain `let`
  // would put the pointerup handler in a different closure from the pointerdown
  // that started the timer — leaving a stray timer that fires a phantom
  // long-press after the user has already moved on.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  // Without the affordance, holding looks identical to a tap that has not
  // registered, so people let go at 400ms and conclude the gesture does not
  // exist — which is how a long-press-only feature stays undiscovered forever.
  const [holding, setHolding] = useState(false);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  }, []);

  const start = useCallback(() => {
    if (!onLongPress) return;
    longPressed.current = false;
    setHolding(true);
    timer.current = setTimeout(() => {
      longPressed.current = true;
      setHolding(false);
      // Haptic confirmation matters here: without it a long-press feels like a
      // tap that didn't register. Absent on iOS Safari — hence the optional call.
      navigator.vibrate?.(12);
      onLongPress();
    }, LONG_PRESS_MS);
  }, [onLongPress]);

  return {
    holding,
    handlers: {
      onClick: () => {
        // The long-press already acted; the click that follows must not also
        // fire the tap.
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        onTap();
      },
      onPointerDown: start,
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
      /*
       * The keyboard route, which the tile spent a release without.
       *
       * Enter and Space activate the button — which on a tile *removes the item
       * and records a purchase* — so without this the keyboard could reach the
       * destructive half of a control and not the corrective half. WCAG 2.1.1
       * Keyboard, Level A. Both platform conventions for "more about this", so
       * it works on a keyboard with a menu key and on one without.
       */
      onKeyDown: (e: React.KeyboardEvent) => {
        if (!onLongPress) return;
        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
        e.preventDefault();
        cancel();
        onLongPress();
      },
      /*
       * Right-click opens it too.
       *
       * `preventDefault` is what stops a touch long-press raising the browser's
       * own menu over the sheet the hold just opened, and it is needed whether
       * or not there is anything to open. The guard is for the touch case, where
       * the 500ms timer has already fired by the time the platform synthesizes
       * this.
       */
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        if (!onLongPress || longPressed.current) return;
        longPressed.current = true;
        cancel();
        onLongPress();
      },
    },
  };
}
