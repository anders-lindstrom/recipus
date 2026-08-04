"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { documentTopOf, scrollToY } from "@/lib/client/fast-scroll";
import { cn } from "@/lib/utils";
import { Sheet } from "./sheet";
import { UiIcon } from "./ui-icon";

/**
 * Aisle navigation.
 *
 * The catalog is every item the household has ever bought — 341 of them across
 * 19 aisles on day one, and it only grows — so reaching "Skafferi" by flicking
 * was never going to work. This is the way around the catalog.
 *
 * Three things are load-bearing, and the first two were learned by measuring the
 * version before this one:
 *
 * 1. **The strip alone was not enough.** 19 aisle names come to about 1970px of
 *    chips inside a 390px phone. It scrolled — touch panning and wheel both
 *    worked — but with the scrollbar hidden there was nothing saying so, and
 *    even once you knew, the far end was five full drags away. A strip is good
 *    for hopping to the aisle next door and useless for finding one by name, so
 *    the full list also lives one tap away in a sheet where all 19 are visible
 *    at once and nothing has to be dragged.
 *
 * 2. **Getting back up needs its own control.** Every jump used to be downward,
 *    with no way home but scrolling. "Listan" is pinned outside the scroller so
 *    it cannot drift off-screen exactly when it is wanted, and so is the button
 *    that opens the sheet.
 *
 * 3. **Landing has to be quick.** See `fast-scroll` — a fixed 180ms, not the
 *    browser's distance-scaled smooth scroll, which spent most of a second
 *    travelling the length of the catalog.
 */

/**
 * Why this says "kategori" where the code says "aisle".
 *
 * The UI used to say "avdelning" throughout, argued from what the thing is FOR:
 * you walk an avdelning, and `lists.category_order` really is a walking order
 * rather than a taxonomy. The household that reads it overruled that — the word
 * is stilted Swedish for what is plainly a category — and the household is who
 * the copy is for. Reasoning about what a word denotes does not outrank a native
 * speaker saying it reads wrong.
 *
 * So: `kategori` on screen, `category` in the schema, and `aisle` left standing
 * in the code of this file, where it names the thing this rail is genuinely
 * about — the order you walk the shop in, which is a different fact from which
 * category a vara belongs to.
 *
 * One word on screen matters most HERE, because these two labels are read aloud
 * and never drawn. A screen reader is the only way to hear them, so a word
 * chosen differently from the visible copy in `ListLayoutSheet` would be a term
 * with nothing on screen to anchor it to — which is what an audit found here.
 */

export interface Aisle {
  id: string;
  name: string;
}

/** The buy zone. Not an aisle, but it is a destination, so it rides along. */
const TOP = "__top__";

/** Aisle headings carry `id="aisle-<id>"`; the buy zone heading uses TOP. */
export function aisleAnchorId(id: string): string {
  return `aisle-${id}`;
}

export interface AisleRailProps {
  aisles: Aisle[];
}

/*
 * Every control on this rail clears 44px, and that is a floor rather than a
 * preference.
 *
 * An in-store audit measured the chips at 38px and the "alla kategorier" button
 * at 36px. This is the "where am I in this shop" control — it is used while
 * moving, one-handed, with a basket in the other hand — which is exactly the
 * condition under which a target below the minimum starts costing you taps. The
 * text stays the same size; only the touchable box grows.
 */
export function AisleRail({ aisles }: AisleRailProps) {
  const [active, setActive] = useState<string>(TOP);
  /**
   * Where a jump in flight is heading.
   *
   * Without this the rail strobes: a 180ms scroll crosses several aisles, the
   * observer reports each one, and the highlight flickers through everything you
   * passed on the way. Showing the destination immediately is also just more
   * honest about what the tap did.
   */
  const [target, setTarget] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const chips = useRef(new Map<string, HTMLButtonElement>());
  const jumpSeq = useRef(0);

  const chromeHeight = () =>
    document.querySelector("header")?.getBoundingClientRect().height ?? 0;

  /**
   * Which aisle you are standing in, derived from where the headings actually
   * are: the last one that has passed up beyond the chrome.
   *
   * Deliberately *not* read out of the observer's own records. The obvious
   * implementation — highlight whichever heading is inside a thin band under the
   * header — is quietly broken, and measuring caught it: a scroll that skips the
   * band never reports anything inside it, so the highlight stays wherever it
   * was. The 180ms jumps do exactly that, and so does any real flick, which left
   * the rail insisting you were in "Frukt & grönt" while you looked at "Kött &
   * fågel". Recomputing from positions cannot get stuck that way.
   */
  const recompute = useCallback(() => {
    const chromeBottom =
      document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;

    /**
     * The line a heading must have passed for its aisle to count as current,
     * set a little way *into* the content rather than flush against the chrome.
     *
     * Two reasons, and the first was a bug: a jump parks its heading 8px below
     * the chrome, and sub-pixel scroll positions put it a fraction the wrong
     * side of a line drawn at exactly that offset — so tapping "Skafferi" landed
     * perfectly and then lit "Fryst". The second is that it reads better: an
     * aisle heading just under the header means that aisle's tiles are what fill
     * the screen, so that is the aisle you are in.
     */
    const line =
      chromeBottom + Math.max(24, (window.innerHeight - chromeBottom) * 0.18);

    let current = TOP;
    for (const id of [TOP, ...aisles.map((a) => a.id)]) {
      const el = document.getElementById(aisleAnchorId(id));
      if (!el) continue;
      if (el.getBoundingClientRect().top > line) break; // in document order
      current = id;
    }
    setActive(current);
  }, [aisles]);

  useEffect(() => {
    if (aisles.length === 0) return;

    const headings = [TOP, ...aisles.map((a) => a.id)]
      .map((id) => document.getElementById(aisleAnchorId(id)))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return;

    // The observer is only a "something moved" trigger, so the work stays off
    // the scroll path. Pulling the root's top edge down to the chrome makes a
    // heading crossing that line the observed event — which is precisely the
    // moment the answer can change.
    const chromeBottom =
      document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
    const observer = new IntersectionObserver(() => recompute(), {
      rootMargin: `${-chromeBottom}px 0px 0px 0px`,
      threshold: 0,
    });

    // No priming call here on purpose. An IntersectionObserver delivers the
    // initial state of every target in its first callback, so the first
    // `recompute` already arrives from the observer — asynchronously, and from a
    // subscription rather than from the effect body, which is the difference
    // between subscribing to something and cascading a render.
    for (const el of headings) observer.observe(el);
    return () => observer.disconnect();
  }, [aisles, recompute]);

  const shown = target ?? active;

  // Keep the lit chip reachable without dragging the strip by hand. `nearest`
  // is deliberate: it does nothing when the chip is already visible, so the rail
  // is not constantly nudging itself while you scroll.
  useEffect(() => {
    chips.current.get(shown)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [shown]);

  const jump = useCallback((id: string) => {
    let y = 0;
    if (id !== TOP) {
      const el = document.getElementById(aisleAnchorId(id));
      if (!el) return;
      // 8px of air, so the heading does not sit flush against the chrome.
      y = documentTopOf(el) - chromeHeight() - 8;
    }

    const seq = ++jumpSeq.current;
    setTarget(id);
    setPicking(false);
    void scrollToY(y).then(() => {
      // A later tap, or the user grabbing the page, owns the highlight now.
      if (jumpSeq.current !== seq) return;
      // Settle the real answer before dropping the optimistic one, so handing
      // over cannot flash the aisle we started from.
      recompute();
      setTarget(null);
    });
  }, [recompute]);

  if (aisles.length === 0) return null;

  return (
    <>
      {/* 3.25rem for a row of 44px chips, and the 4px on each side is the point
          rather than a rounding.

          It was 2.75rem — exactly the height of the chips it holds. They did not
          merely sit flush against the rule above and the header's border below,
          they OVERFLOWED the row by 4px at each end, and their focus rings were
          clipped by the scroller they sit in on top of that. A rail of chips
          with no air around them reads as a rendering fault whether or not
          anything is focused, which is how it was reported. */}
      <div className="flex h-13 items-center gap-1 border-t border-line px-2">
        <button
          type="button"
          onClick={() => jump(TOP)}
          aria-current={shown === TOP ? "true" : undefined}
          className={cn(
            "flex min-h-11 flex-none items-center gap-1 rounded-full py-1.5 pr-3 pl-2 text-caption font-semibold transition-colors duration-150",
            shown === TOP
              ? "bg-brand text-on-brand"
              : "border border-line text-ink-soft",
          )}
        >
          <UiIcon name="toTop" size={14} />
          Listan
        </button>

        <span aria-hidden className="h-4 w-px flex-none bg-line-strong" />

        <div className="relative min-w-0 flex-1">
          <div
            role="navigation"
            aria-label="Hoppa till kategori"
            // `py-1` is load-bearing, not spacing: a scroll container clips at
            // its PADDING box, so this 4px is the room a chip's focus ring has
            // to be drawn in. Without it the ring is cut off flat on the top and
            // bottom of every chip in the rail.
            className="no-scrollbar flex items-center gap-1.5 overflow-x-auto py-1"
          >
            {aisles.map((aisle) => {
              const isActive = aisle.id === shown;
              return (
                <button
                  key={aisle.id}
                  type="button"
                  ref={(el) => {
                    if (el) chips.current.set(aisle.id, el);
                    else chips.current.delete(aisle.id);
                  }}
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => jump(aisle.id)}
                  className={cn(
                    "flex min-h-11 flex-none items-center rounded-full px-3 py-1.5 text-caption font-semibold whitespace-nowrap transition-colors duration-150",
                    isActive
                      ? "bg-brand text-on-brand"
                      : "border border-line text-ink-soft",
                  )}
                >
                  {aisle.name}
                </button>
              );
            })}
          </div>

          {/* Says "there is more this way" — the one thing a hidden scrollbar
              cannot. Without it people concluded the strip did not scroll.

              Fades into `--mode-wash` rather than a fixed colour: buy mode paints
              the header terracotta, and a fade hardcoded to the page colour
              smeared a pale streak across the tint. The rail does not need to
              know modes exist — it just fades into its own background. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-8"
            style={{
              backgroundImage:
                "linear-gradient(to left, var(--mode-wash), transparent)",
            }}
          />
        </div>

        <button
          type="button"
          onClick={() => setPicking(true)}
          aria-label="Alla kategorier"
          className="flex h-11 w-11 flex-none items-center justify-center rounded-full border border-line text-ink-soft"
        >
          <UiIcon name="allAisles" size={16} />
        </button>
      </div>

      {picking && (
        <Sheet title="Hoppa till" onClose={() => setPicking(false)}>
          <div className="px-3 pb-3">
            <button
              type="button"
              onClick={() => jump(TOP)}
              className="mb-2 flex w-full items-center gap-2.5 rounded-control bg-surface px-3 py-3 text-left text-body font-semibold text-ink"
            >
              <UiIcon name="toTop" size={17} className="text-ink-soft" />
              Att handla
            </button>

            {/* Two columns so all 19 aisles are on screen together. The point of
                the sheet is not dragging, so it must not need any. */}
            <div className="grid grid-cols-2 gap-2">
              {aisles.map((aisle) => (
                <button
                  key={aisle.id}
                  type="button"
                  onClick={() => jump(aisle.id)}
                  className={cn(
                    "rounded-control px-3 py-3 text-left text-body-sm font-semibold transition-colors duration-150",
                    aisle.id === active
                      ? "bg-brand text-on-brand"
                      : "bg-surface text-ink",
                  )}
                >
                  {aisle.name}
                </button>
              ))}
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
