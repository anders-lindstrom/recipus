"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The aisle rail.
 *
 * The catalog is every item the household has ever bought — 341 of them across
 * 19 aisles on day one, and it only grows. Reaching "Skafferi" meant a dozen
 * flicks past everything else, which is why the search box was doing work that
 * browsing should have done.
 *
 * The rail is placed *after* the "att handla" zone and made `sticky`, so plain
 * CSS gives it exactly the behaviour it wants with no scroll handler at all: it
 * is absent while you are looking at your list, and it pins itself under the
 * header the moment the catalog starts. The add bar scrolls away above it,
 * which is why the rail carries its own way back to search.
 *
 * Which chip is highlighted comes from an IntersectionObserver on the aisle
 * headings rather than a scroll listener — same information, none of the
 * per-frame work on a list this long.
 */

export interface Aisle {
  id: string;
  name: string;
}

export interface AisleRailProps {
  aisles: Aisle[];
  /** Scrolls back to the top and focuses the add bar. */
  onSearch: () => void;
}

export function AisleRail({ aisles, onSearch }: AisleRailProps) {
  const [active, setActive] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const chips = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (aisles.length === 0) return;

    const headings = aisles
      .map((a) => document.getElementById(`aisle-${a.id}`))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return;

    // The band is a thin strip just under the pinned chrome. A heading inside
    // it is the aisle you are standing in; `-88%` at the bottom keeps the
    // twenty headings below the fold from all counting as visible at once.
    const observer = new IntersectionObserver(
      (records) => {
        const entered = records.filter((r) => r.isIntersecting);
        if (entered.length === 0) return;
        // Topmost wins when a short aisle puts two headings in the band.
        const top = entered.reduce((a, b) =>
          a.boundingClientRect.top <= b.boundingClientRect.top ? a : b,
        );
        setActive(top.target.id.replace(/^aisle-/, ""));
      },
      { rootMargin: "-38% 0px -88% 0px", threshold: 0 },
    );

    for (const el of headings) observer.observe(el);
    return () => observer.disconnect();
  }, [aisles]);

  // Keep the highlighted chip reachable without dragging the rail by hand.
  // `nearest` is deliberate: it does nothing when the chip is already visible,
  // so the rail is not constantly nudging itself while you scroll.
  useEffect(() => {
    if (!active) return;
    chips.current
      .get(active)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  if (aisles.length === 0) return null;

  return (
    <div
      className={cn(
        "sticky top-[calc(env(safe-area-inset-top)+3rem)] z-20 -mx-3",
        // Tinted to the well it lives in, not to the page: catalog tiles scroll
        // underneath this, and a page-coloured strip read as a lighter band
        // cutting across the sunken section. Opaque for the same reasons as the
        // header above it.
        "border-b border-line bg-surface-sunken",
      )}
    >
      <div
        ref={railRef}
        role="navigation"
        aria-label="Hoppa till avdelning"
        className="no-scrollbar flex h-11 items-center gap-1.5 overflow-x-auto px-3"
      >
        <button
          type="button"
          onClick={onSearch}
          className="flex-none rounded-full border border-line px-3 py-1.5 text-caption font-semibold text-ink-soft"
        >
          Sök
        </button>

        <span aria-hidden className="h-4 w-px flex-none bg-line-strong" />

        {aisles.map((aisle) => {
          const isActive = aisle.id === active;
          return (
            <button
              key={aisle.id}
              type="button"
              ref={(el) => {
                if (el) chips.current.set(aisle.id, el);
                else chips.current.delete(aisle.id);
              }}
              aria-current={isActive ? "true" : undefined}
              onClick={() => {
                document
                  .getElementById(`aisle-${aisle.id}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className={cn(
                "flex-none rounded-full px-3 py-1.5 text-caption font-semibold whitespace-nowrap transition-colors duration-150",
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
    </div>
  );
}
