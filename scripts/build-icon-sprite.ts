/**
 * Build an SVG sprite from the OpenMoji codepoints the seed catalog uses.
 *
 * The app renders system emoji when this sprite is absent, so it is an upgrade
 * rather than a dependency — the build never blocks on network access and a
 * fresh clone works immediately. Running it swaps in one consistent icon set
 * that looks the same on every phone, which system emoji emphatically do not.
 *
 * Only the ~340 codepoints actually referenced are fetched. OpenMoji ships
 * roughly 4,000 icons and we are not shipping the other 3,660.
 *
 *   pnpm icons:build
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CATALOG_ITEMS, CATEGORIES } from "../src/db/seed-data";

const OUT = "public/icons/openmoji-sprite.svg";
const BASE =
  "https://raw.githubusercontent.com/hfg-gmuend/openmoji/master/color/svg";

// OpenMoji names files by codepoint, but omits the FE0F variation selector that
// several of our emoji carry. Trying both spellings avoids a pile of spurious
// misses on things like ☕ and ✏️.
function candidateNames(ref: string): string[] {
  const upper = ref.toUpperCase();
  const withoutVs = upper
    .split("-")
    .filter((c) => c !== "FE0F")
    .join("-");
  return upper === withoutVs ? [upper] : [upper, withoutVs];
}

async function fetchIcon(ref: string): Promise<string | null> {
  for (const name of candidateNames(ref)) {
    const res = await fetch(`${BASE}/${name}.svg`);
    if (res.ok) return await res.text();
  }
  return null;
}

/** Strip the outer <svg> wrapper and re-emit the body as a <symbol>. */
function toSymbol(ref: string, svg: string): string | null {
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 72 72";
  const body = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1];
  if (!body) return null;
  return `<symbol id="i${ref}" viewBox="${viewBox}">${body.trim()}</symbol>`;
}

// Image builds pass --strict: there, a partial fetch is a broken deploy waiting
// to happen rather than a cosmetic shortfall, and a build that stops is far
// cheaper than shipping a sprite and finding out in a shop which tiles it left
// out. Interactively it stays lenient — a missing icon or two is not a reason
// to refuse to produce the other 110.
const STRICT = process.argv.includes("--strict");

async function main() {
  const refs = [
    ...new Set([
      ...CATALOG_ITEMS.map((i) => i.iconRef),
      ...CATEGORIES.map((c) => c.icon),
    ]),
  ].sort();

  console.log(`Fetching ${refs.length} OpenMoji icons…`);

  const symbols: string[] = [];
  const missing: string[] = [];

  // Small concurrency: enough to be quick, polite enough not to look like abuse
  // of a volunteer-run project's CDN.
  const CONCURRENCY = 8;
  for (let i = 0; i < refs.length; i += CONCURRENCY) {
    const batch = refs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (ref) => {
        try {
          const svg = await fetchIcon(ref);
          return { ref, symbol: svg ? toSymbol(ref, svg) : null };
        } catch {
          return { ref, symbol: null };
        }
      }),
    );
    for (const { ref, symbol } of results) {
      if (symbol) symbols.push(symbol);
      else missing.push(ref);
    }
    process.stdout.write(`\r  ${Math.min(i + CONCURRENCY, refs.length)}/${refs.length}`);
  }
  process.stdout.write("\n");

  if (symbols.length === 0) {
    // Writing an empty sprite would be worse than writing none: the app would
    // render blank tiles instead of falling back to system emoji.
    console.error("No icons fetched — leaving the sprite absent so the app falls back to system emoji.");
    process.exit(1);
  }

  if (STRICT && missing.length) {
    console.error(
      `--strict: ${missing.length} of ${refs.length} icons could not be fetched ` +
        `(${missing.join(", ")}). Leaving the sprite untouched.`,
    );
    process.exit(1);
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(
    OUT,
    `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n${symbols.join("\n")}\n</svg>\n`,
    "utf8",
  );

  console.log(`Wrote ${OUT} with ${symbols.length} icons.`);
  if (missing.length) {
    // Not a failure: ItemIcon checks for the individual symbol, so these tiles
    // keep their system emoji while the rest get OpenMoji art. Still worth
    // naming them, so the seed data can pick a codepoint OpenMoji covers.
    console.warn(`No OpenMoji art for ${missing.length}: ${missing.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
