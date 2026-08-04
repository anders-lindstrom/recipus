"use client";

import { useRef } from "react";
import { useFocusTrap } from "@/lib/client/use-focus-trap";
import { cn } from "@/lib/utils";
import { UiIcon } from "./ui-icon";

/**
 * The bottom sheet.
 *
 * Three screens had grown their own copy of this — the entry breakdown, the
 * list switcher, and the recipe screen's list picker — and they had already
 * drifted apart on corner radius, backdrop opacity and whether Escape did
 * anything. Sheets are the app's only modal surface, so there is one of them.
 *
 * Everything rare lives behind a sheet rather than a route: it keeps the list
 * on screen underneath, and it cannot throw away the hydrated store the way a
 * navigation would.
 */

export interface SheetProps {
  /** Names the dialog for assistive tech. Rendered when `showTitle`. */
  title: string;
  showTitle?: boolean;
  /** Sits opposite the title — a total, a count. Needs `showTitle`. */
  trailing?: React.ReactNode;
  onClose: () => void;
  /**
   * The one affirmative thing this sheet is for, fired by Enter.
   *
   * Give it only to a sheet that asks a question with a single answer — "Lägg
   * till", "Spara", "Skapa båda". A sheet that is a menu of equals leaves it
   * off, because Enter picking one of five buttons for you is how a keypress
   * ends up removing something. See `useFocusTrap`.
   */
  onPrimary?: () => void;
  children: React.ReactNode;
  className?: string;
}

export function Sheet({
  title,
  showTitle = true,
  trailing,
  onClose,
  onPrimary,
  children,
  className,
}: SheetProps) {
  /**
   * Focus in, Tab held inside, Escape out, Enter through, focus back to the
   * trigger.
   *
   * Escape used to live here on its own — a sheet you cannot dismiss from the
   * keyboard is a trap on the desktop side of a PWA, where there is no back
   * gesture to fall back on. It moved into the trap because trapping Tab is
   * what turns it from a courtesy into the only way out; see useFocusTrap.
   *
   * Enter joined it there for the mirror-image reason. Every field in these
   * sheets commits and blurs on Enter, which left the keyboard able to fill a
   * sheet in and not to submit it — you had to reach for the mouse for the last
   * step of every single one. The trap is where that has to live, because it is
   * the only thing that knows where focus actually went after the blur.
   */
  const dialogRef = useFocusTrap<HTMLDivElement>(onClose, onPrimary);

  /**
   * Has a gesture actually STARTED inside this sheet yet?
   *
   * Every sheet in this app is opened by a long-press, and on a touchscreen the
   * click that a touch synthesizes is hit-tested at the finger's position when it
   * LIFTS — not where it went down. The sheet has mounted under the finger by
   * then, so the press that opened it delivers one final click straight into the
   * sheet, aimed at whatever control now happens to sit under that thumb.
   *
   * Measured on a Pixel 7 (tests/e2e/list.spec.ts reproduces it): long-pressing a
   * tile in "att handla" put that click on the backdrop, so the entry sheet opened
   * and shut inside one gesture. Long-press a tile lower down the page and the
   * same click lands on the sheet's own action row instead — "Köpte inte", "Ta
   * bort" — so the gesture that was meant to OPEN the breakdown silently took the
   * item off the list. That is the bug reported from production, and both halves
   * of it are this one stray click.
   *
   * So the sheet ignores pointer input until it has seen a `pointerdown` of its
   * own. A latch rather than a timer: the stray click is by construction the only
   * one that can reach a freshly-mounted sheet without a pointerdown in front of
   * it, and a time window would be a guess about how long a thumb takes to lift.
   */
  const ownGesture = useRef(false);

  return (
    <div
      ref={dialogRef}
      className="animate-fade-in fixed inset-0 z-50 flex items-end bg-ink/40 backdrop-blur-[2px] outline-none"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      // So the dialog can hold focus itself when the sheet has no field to
      // offer — never a tab stop of its own, only a place to start.
      tabIndex={-1}
      onPointerDownCapture={() => {
        ownGesture.current = true;
      }}
      /**
       * The stray click's third effect, and the last one to be noticed.
       *
       * A touch's synthesized sequence is mousemove, mousedown, mouseup, click —
       * no `pointerdown`, which is exactly why the latch above catches it. The
       * click was the loud half; the mousedown is the quiet one, and it moves
       * focus to whatever is focusable under the finger. Measured: long-pressing
       * a catalog tile opens the details sheet with its amount field autofocused
       * and the keyboard already rising, and then the gesture's own mousedown
       * takes the focus straight back off it — so the field this sheet exists
       * for arrives empty, unfocused, and one tap away. Before the dialog was
       * focusable at all it was worse: focus landed on `<body>`, outside the
       * modal that had just claimed the screen.
       *
       * `preventDefault` on mousedown suppresses only the focus change; the
       * click still comes, and is still stopped below. Safe to do
       * unconditionally within the latch, because a real press of any kind —
       * mouse or finger — puts a `pointerdown` in front of its mousedown, and
       * that is the one thing this synthesized sequence cannot.
       */
      onMouseDownCapture={(e) => {
        if (!ownGesture.current) e.preventDefault();
      }}
      onClickCapture={(e) => {
        if (ownGesture.current) return;
        // Capture, so this runs before the click reaches any button inside —
        // stopping it here is the difference between "the sheet opened" and "the
        // sheet opened and removed the item".
        e.stopPropagation();
      }}
      // Only a click on the backdrop ITSELF dismisses. Without the target check a
      // press that began on the sheet's own content — dragging a finger while
      // reading the breakdown — closes the sheet when it happens to end up out
      // here, which reads as the app throwing you out mid-thought.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "animate-sheet-in safe-bottom max-h-[85dvh] w-full overflow-y-auto",
          "rounded-t-sheet bg-surface-raised shadow-2xl shadow-black/25",
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* The grabber is the only thing that says "this came up from the
            bottom and goes back down"; without it a sheet reads as a page. */}
        <div className="flex justify-center pt-2.5 pb-1">
          <span
            aria-hidden
            className="h-1 w-9 rounded-full bg-line-strong"
          />
        </div>

        {showTitle && (
          <div className="flex items-baseline gap-3 px-4 pt-2 pb-3">
            <h2 className="flex-1 text-display text-ink">{title}</h2>
            {trailing}
          </div>
        )}

        {children}
      </div>
    </div>
  );
}

/**
 * The row of actions at the foot of a sheet.
 *
 * Destructive and neutral actions used to sit side by side at identical weight,
 * separated by a hairline — which is how "Ta bort" gets tapped by someone
 * reaching for "Ändra mängd". They are stacked now, and only the destructive
 * one is coloured.
 */
export function SheetActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-line p-3">
      {children}
    </div>
  );
}

export function SheetButton({
  tone = "neutral",
  icon,
  onClick,
  disabled = false,
  children,
}: {
  /**
   * `primary` is the one action a sheet exists to make easy, and there is at
   * most one per sheet — green, because green means "on the list" in this app
   * and the only sheet using it is putting something there.
   */
  tone?: "neutral" | "danger" | "primary";
  icon?: React.ReactNode;
  onClick: () => void;
  /** For a primary action that is already done — see the vara sheet. */
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center justify-center gap-2 rounded-control px-3 py-3",
        "text-body font-semibold transition-transform duration-100 active:scale-[0.98]",
        tone === "neutral" && "bg-surface text-ink",
        tone === "danger" && "bg-danger-tint text-danger",
        tone === "primary" && "bg-brand text-on-brand",
        disabled && "opacity-45 active:scale-100",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * Three small controls on one line, where three full-width rows would say the
 * same thing three times as loudly.
 *
 * For the edits that are one tap and one word — rename, icon, category. They
 * were three of the seven full-width rows in the vara sheet, which pushed the
 * things people actually come to that sheet for below the fold. Still 44px tall,
 * because a smaller target is not what was wrong with them.
 */
export function SheetButtonRow({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-2">{children}</div>;
}

export function SheetChipButton({
  icon,
  onClick,
  children,
}: {
  icon?: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-11 flex-1 basis-0 flex-col items-center justify-center gap-0.5",
        "rounded-control bg-surface px-2 py-2 text-caption font-semibold text-ink",
        "transition-transform duration-100 active:scale-[0.98]",
      )}
    >
      {icon}
      <span className="max-w-full truncate">{children}</span>
    </button>
  );
}

/**
 * The rest of what you can do, folded away until asked for.
 *
 * A native `<details>`, so it is a disclosure the platform already knows how to
 * announce and operate — closed is the honest default for controls a household
 * reaches for a few times a year, and there is nothing here to teach.
 */
export function SheetAdvanced({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const self = useRef<HTMLDetailsElement>(null);

  return (
    <details
      ref={self}
      /**
       * Bring what was just revealed into view.
       *
       * This sits at the very bottom of a sheet that is already scrolled to its
       * own end — the whole point of it is to be last — so opening it puts every
       * control it contains below the fold. Measured on a vara with products and
       * a delete blocker: the summary rotated its chevron and nothing else
       * appeared to happen, which reads as a control that does not work.
       *
       * `nearest` rather than `center`: scroll the least that makes it visible,
       * so a disclosure opened on a short sheet does not lurch.
       */
      onToggle={(e) => {
        if (!e.currentTarget.open) return;
        self.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }}
      className="group rounded-control bg-surface"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-center gap-1.5 px-3 py-3 text-body font-semibold text-ink-soft [&::-webkit-details-marker]:hidden">
        {label}
        <UiIcon
          name="chevronDown"
          size={15}
          className="flex-none transition-transform duration-150 group-open:rotate-180"
        />
      </summary>
      <div className="flex flex-col gap-2 px-2 pb-2">{children}</div>
    </details>
  );
}
