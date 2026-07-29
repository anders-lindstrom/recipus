"use client";

import { useCallback, useRef } from "react";
import { cn, codepointToEmoji } from "@/lib/utils";

/**
 * The tile.
 *
 * This is the app. Everything else is scaffolding around a grid of these, and
 * the single most important property is that tapping one does its thing
 * immediately — no dialog, no confirm, no spinner. A tap that waits on the
 * network is a tap that fails in a shop.
 */

export interface ItemTileProps {
  name: string;
  /** Emoji codepoint, e.g. "1F95B". */
  iconRef: string;
  /** Merged total, already formatted: "11 dl". Empty renders nothing. */
  quantityLabel?: string;
  /** True when the item is in the "att handla" zone rather than the catalog. */
  onList?: boolean;
  /** Shows the 📖 badge — a recipe asked for this. */
  fromRecipe?: boolean;
  /** Cadence engine's reason, e.g. "6 dgr sen". Suggestion tiles only. */
  reason?: string;
  /** Colour of the member who added it, for the recent-change dot. */
  actorColor?: string;
  /** Dimmed while a pending change has not yet reached the server. */
  pending?: boolean;
  onTap: () => void;
  onLongPress?: () => void;
}

// Long-press is the escape hatch for everything rare: amounts, notes, moving an
// item, and removing without recording a purchase. 500ms is long enough not to
// fire while scrolling a grid, short enough not to feel broken.
const LONG_PRESS_MS = 500;

export function ItemTile({
  name,
  iconRef,
  quantityLabel,
  onList = false,
  fromRecipe = false,
  reason,
  actorColor,
  pending = false,
  onTap,
  onLongPress,
}: ItemTileProps) {
  // Refs, not render-locals: tapping a tile re-renders it, and a plain `let`
  // would put the pointerup handler in a different closure from the pointerdown
  // that started the timer — leaving a stray timer that fires a phantom
  // long-press after the user has already moved on.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const start = useCallback(() => {
    if (!onLongPress) return;
    longPressed.current = false;
    timer.current = setTimeout(() => {
      longPressed.current = true;
      // Haptic confirmation matters here: without it a long-press feels like a
      // tap that didn't register. Absent on iOS Safari — hence the optional call.
      navigator.vibrate?.(12);
      onLongPress();
    }, LONG_PRESS_MS);
  }, [onLongPress]);

  return (
    <button
      type="button"
      aria-pressed={onList}
      className={cn(
        "relative flex min-h-[78px] flex-col items-center justify-start",
        "rounded-tile border px-1.5 pt-2.5 pb-2 text-center",
        "transition-[transform,opacity] duration-100 active:scale-[0.96]",
        onList
          ? "border-brand-line bg-brand-tint"
          : "border-line bg-paper-raised opacity-60",
        pending && "opacity-45",
      )}
      onClick={() => {
        // The long-press already acted; the click that follows must not also
        // toggle the item.
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        onTap();
      }}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      {fromRecipe && (
        <span
          aria-hidden
          className="absolute top-1 right-1 flex h-[15px] w-[15px] items-center justify-center rounded-full bg-brand text-[9px] text-white"
        >
          📖
        </span>
      )}
      {actorColor && (
        <span
          aria-hidden
          className="absolute top-1 left-1 h-1.5 w-1.5 rounded-full"
          style={{ background: actorColor }}
        />
      )}

      <span
        aria-hidden
        className={cn("text-2xl leading-none", !onList && "grayscale-[0.7]")}
      >
        {codepointToEmoji(iconRef)}
      </span>

      <span className="mt-1 text-[11px] leading-tight font-semibold text-ink">
        {name}
      </span>

      {quantityLabel ? (
        <span className="mt-0.5 text-[10.5px] leading-none font-extrabold tracking-tight text-brand">
          {quantityLabel}
        </span>
      ) : null}

      {reason ? (
        <span className="mt-0.5 text-[9.5px] leading-none font-bold text-warn">
          {reason}
        </span>
      ) : null}
    </button>
  );
}

/** Three tiles per row is the widest that keeps Swedish item names readable. */
export function TileGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-3 gap-[7px]">{children}</div>;
}

export function SectionHeading({
  children,
  count,
  tone = "muted",
}: {
  children: React.ReactNode;
  count?: number;
  tone?: "muted" | "brand" | "warn";
}) {
  return (
    <div
      className={cn(
        "mx-0.5 mt-3 mb-1.5 flex justify-between text-[10.5px] font-extrabold tracking-[0.11em] uppercase",
        tone === "muted" && "text-ink-faint",
        tone === "brand" && "text-brand",
        tone === "warn" && "text-warn",
      )}
    >
      <span>{children}</span>
      {count !== undefined && <span>{count}</span>}
    </div>
  );
}
