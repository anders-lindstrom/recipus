"use client";

import { useEffect, useState } from "react";
import { codepointToEmoji } from "@/lib/utils";

/**
 * Item icons.
 *
 * OpenMoji renders identically on every phone; system emoji do not — the same
 * list looks meaningfully different on an iPhone and a Pixel, and half the
 * charm of a tile grid is that it is recognisable at a glance. So the sprite is
 * fetched once, injected once, and used from then on.
 *
 * It is strictly an enhancement. `pnpm icons:build` is optional, the file is
 * gitignored, and when it is missing every tile falls back to the system emoji
 * for the same codepoint. The app is never iconless and the build never depends
 * on a volunteer-run CDN being up.
 */

const SPRITE_URL = "/icons/openmoji-sprite.svg";
const CONTAINER_ID = "openmoji-sprite";

type SpriteState = "loading" | "ready" | "absent";

let spritePromise: Promise<boolean> | null = null;

/** Fetch and inject once per document, however many tiles ask for it. */
function ensureSprite(): Promise<boolean> {
  if (spritePromise) return spritePromise;

  spritePromise = (async () => {
    if (document.getElementById(CONTAINER_ID)) return true;
    try {
      const res = await fetch(SPRITE_URL);
      if (!res.ok) return false;
      const svg = await res.text();
      if (!svg.includes("<symbol")) return false;

      const holder = document.createElement("div");
      holder.id = CONTAINER_ID;
      holder.setAttribute("aria-hidden", "true");
      holder.style.display = "none";
      holder.innerHTML = svg;
      document.body.prepend(holder);
      return true;
    } catch {
      return false;
    }
  })();

  return spritePromise;
}

export function ItemIcon({
  iconRef,
  className,
}: {
  iconRef: string;
  className?: string;
}) {
  const [state, setState] = useState<SpriteState>("loading");
  const symbolId = `i${iconRef.toUpperCase()}`;

  useEffect(() => {
    let alive = true;
    void ensureSprite().then((ok) => {
      if (!alive) return;
      // Present-file is not the same as present-symbol. OpenMoji has no art for
      // every codepoint, and the sprite only carries what was actually fetched,
      // so asking for this specific symbol is what keeps "the sprite exists"
      // from turning one missing icon into a blank tile.
      setState(ok && document.getElementById(symbolId) ? "ready" : "absent");
    });
    return () => {
      alive = false;
    };
  }, [symbolId]);

  // The emoji is rendered until the sprite is confirmed present, so a tile is
  // never blank while the fetch is in flight.
  if (state !== "ready") {
    return (
      <span aria-hidden className={className}>
        {codepointToEmoji(iconRef)}
      </span>
    );
  }

  return (
    <svg
      aria-hidden
      className={className}
      style={{ width: "1em", height: "1em" }}
      role="presentation"
    >
      <use href={`#${symbolId}`} />
    </svg>
  );
}
