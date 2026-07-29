"use client";

import { useEffect } from "react";
import { cn } from "@/lib/utils";

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
  children: React.ReactNode;
  className?: string;
}

export function Sheet({
  title,
  showTitle = true,
  trailing,
  onClose,
  children,
  className,
}: SheetProps) {
  // A sheet you cannot dismiss from the keyboard is a trap on the desktop side
  // of a PWA, where there is no back gesture to fall back on.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-end bg-ink/40 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
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
  children,
}: {
  tone?: "neutral" | "danger";
  icon?: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-center gap-2 rounded-control px-3 py-3",
        "text-body font-semibold transition-transform duration-100 active:scale-[0.98]",
        tone === "neutral" && "bg-surface text-ink",
        tone === "danger" && "bg-danger-tint text-danger",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
