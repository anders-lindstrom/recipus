"use client";

import { useCallback, useRef, useState } from "react";
import type { Priority } from "@/lib/domain";
import { cn } from "@/lib/utils";
import { ItemIcon } from "./icon";
import { UiIcon } from "./ui-icon";

/**
 * The tile.
 *
 * This is the app. Everything else is scaffolding around a grid of these, and
 * the single most important property is that tapping one does its thing
 * immediately — no dialog, no confirm, no spinner. A tap that waits on the
 * network is a tap that fails in a shop.
 *
 * The two states have to be tellable apart in a fraction of a second, in bad
 * light, at arm's length. So they differ on three axes at once — fill, border
 * and icon saturation — rather than on opacity alone. Opacity was the old
 * approach and it had a real cost: `opacity-60` on the whole tile dragged the
 * item name down to a 2.5:1 contrast ratio, which is unreadable for anyone with
 * even mild low vision. Catalog tiles now recede by using a quieter ink colour
 * that still clears AA, and by desaturating the icon rather than the text.
 */

export interface ItemTileProps {
  name: string;
  /** Emoji codepoint, e.g. "1F95B". */
  iconRef: string;
  /** Merged total, already formatted: "11 dl". Empty renders nothing. */
  quantityLabel?: string;
  /** True when the item is in the "att handla" zone rather than the catalog. */
  onList?: boolean;
  /** Shows the recipe badge — a recipe asked for this. */
  fromRecipe?: boolean;
  /** Cadence engine's reason, e.g. "6 dgr sen". Suggestion tiles only. */
  reason?: string;
  /** Urgent first and ochre, convenient last and muted. Never a badge. */
  priority?: Priority;
  /** The household's qualifier — "mogna". Rendered under the name. */
  modifier?: string | null;
  /** Colour of the member who added it, for the recent-change dot. */
  actorColor?: string;
  /** Dimmed while a pending change has not yet reached the server. */
  pending?: boolean;
  /** Plays the arrival animation. Only the "att handla" zone sets this. */
  animateIn?: boolean;
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
  priority = "normal",
  modifier = null,
  actorColor,
  pending = false,
  animateIn = false,
  onTap,
  onLongPress,
}: ItemTileProps) {
  // Refs, not render-locals: tapping a tile re-renders it, and a plain `let`
  // would put the pointerup handler in a different closure from the pointerdown
  // that started the timer — leaving a stray timer that fires a phantom
  // long-press after the user has already moved on.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  // Drives the press-in affordance. Without it, holding a tile looks identical
  // to a tap that hasn't registered, so people let go at 400ms and conclude the
  // gesture doesn't exist — which is how a long-press-only feature stays
  // undiscovered forever.
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

  return (
    <button
      type="button"
      aria-pressed={onList}
      className={cn(
        "group relative flex min-h-[92px] flex-col items-center justify-start",
        "rounded-tile border px-1.5 pt-3 pb-2.5 text-center",
        "transition-[transform,background-color,border-color]",
        onList
          ? "border-brand-line bg-brand-tint"
          : "border-line bg-surface-raised",
        // Two different durations off one state: the slow squeeze is the
        // long-press filling up, the fast one is the release or a plain tap.
        holding
          ? "scale-[0.93] duration-500 ease-linear"
          : "duration-100 active:scale-[0.95]",
        pending && "opacity-55",
        animateIn && "animate-tile-in",
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
          className="absolute top-1.5 right-1.5 flex h-[17px] w-[17px] items-center justify-center rounded-full bg-brand text-on-brand"
        >
          <UiIcon name="recipes" size={10} />
        </span>
      )}
      {actorColor && (
        <span
          aria-hidden
          className="absolute top-1.5 left-1.5 h-1.5 w-1.5 rounded-full"
          style={{ background: actorColor }}
        />
      )}

      <ItemIcon
        iconRef={iconRef}
        className={cn(
          "text-[26px] leading-none transition-[filter] duration-150",
          // Catalog art is muted rather than hidden — enough to let the green
          // zone win the eye, not so much that a red pepper stops being red.
          !onList && "saturate-[0.55] dark:saturate-[0.75]",
        )}
      />

      {/* Priority rides the ink of text that is already here — no extra DOM, no
          layout shift, and no second colour on the tile. Both corners are
          already spoken for (recipe badge right, actor dot left), and green has
          exactly one meaning in this app: on the list. Ochre on the NAME reads
          as "this one" without competing for that meaning.

          The visually-hidden suffix is not decoration: ochre-versus-grey is the
          entire signal, so without it the distinction simply does not exist for
          a screen reader, and it is invisible to anyone who cannot separate the
          two hues. */}
      <span
        className={cn(
          "mt-1.5 text-label text-balance",
          onList ? "text-ink" : "text-ink-soft",
          priority === "urgent" && "font-bold text-warn",
          priority === "convenient" && "text-ink-soft",
        )}
      >
        {name}
        {priority !== "normal" ? (
          <span className="sr-only">
            {priority === "urgent" ? ", bråttom" : ", om du hinner"}
          </span>
        ) : null}
      </span>

      {/* The household's own qualifier, under the name and above the quantity —
          "mogna" belongs to the thing, the amount belongs to the ask. */}
      {modifier ? (
        <span className="mt-0.5 text-caption text-ink-faint italic">
          {modifier}
        </span>
      ) : null}

      {quantityLabel ? (
        <span className="mt-1 text-caption font-bold text-brand-ink">
          {quantityLabel}
        </span>
      ) : null}

      {reason ? (
        <span className="mt-1 text-[0.6875rem] leading-none font-semibold text-warn">
          {reason}
        </span>
      ) : null}
    </button>
  );
}

/** Three tiles per row is the widest that keeps Swedish item names readable. */
export function TileGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-3 gap-2">{children}</div>;
}

export function SectionHeading({
  children,
  count,
  tone = "muted",
  id,
  action,
}: {
  children: React.ReactNode;
  count?: number;
  tone?: "muted" | "brand" | "warn";
  /** Set on aisle headings so the rail can scroll to them. */
  id?: string;
  /**
   * A control on the right, before the count. The row is tall enough to hold one
   * whether or not it is there — a heading that grows when an action appears
   * would shove the whole list down, which is the jitter this app has already
   * been bitten by once.
   */
  action?: React.ReactNode;
}) {
  return (
    <h2
      id={id}
      className={cn(
        "mx-0.5 mt-5 mb-2 flex min-h-7 items-center gap-2 text-overline uppercase",
        id && "aisle-anchor",
        tone === "muted" && "text-ink-faint",
        tone === "brand" && "text-ink-soft",
        tone === "warn" && "text-warn",
      )}
    >
      <span className="flex-1">{children}</span>
      {action}
      {count !== undefined && (
        <span className="text-ink-faint tabular-nums">{count}</span>
      )}
    </h2>
  );
}
