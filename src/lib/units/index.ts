/**
 * Units engine: parses, converts, merges and formats grocery-list amounts.
 *
 * Pure module — no DOM, no network, no database. See
 * docs/superpowers/specs/2026-07-29-recipus-design.md §5.1 for the design
 * rationale (conversion factors, the display ladder, and why cross-family
 * merging is refused).
 */

import type { Amount, MassUnit, Unit, UnitFamily, VolumeUnit } from "@/lib/domain";

// ---------------------------------------------------------------------------
// Unit tables
// ---------------------------------------------------------------------------

const VOLUME_TO_ML: Record<VolumeUnit, number> = {
  ml: 1,
  krm: 1,
  tsk: 5,
  msk: 15,
  cl: 10,
  dl: 100,
  l: 1000,
};

const MASS_TO_G: Record<MassUnit, number> = {
  g: 1,
  hg: 100,
  kg: 1000,
};

const COUNT_UNITS = ["st", "förp", "burk", "påse", "knippe", "pkt"] as const;

const ALL_UNITS: readonly Unit[] = [
  ...(Object.keys(VOLUME_TO_ML) as VolumeUnit[]),
  ...(Object.keys(MASS_TO_G) as MassUnit[]),
  ...COUNT_UNITS,
];

const UNIT_SET = new Set<string>(ALL_UNITS);
const VOLUME_SET = new Set<string>(Object.keys(VOLUME_TO_ML));
const MASS_SET = new Set<string>(Object.keys(MASS_TO_G));

export function unitFamily(unit: Unit): UnitFamily {
  if (VOLUME_SET.has(unit)) return "volume";
  if (MASS_SET.has(unit)) return "mass";
  return "count";
}

export function isUnit(s: string): s is Unit {
  return UNIT_SET.has(s);
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function round(n: number, decimals = 4): number {
  const factor = 10 ** decimals;
  const r = Math.round(n * factor) / factor;
  return r === 0 ? 0 : r; // normalize -0 to 0
}

/** Convert to the family's base unit: ml for volume, g for mass, 1 for count. */
export function toBase(amount: Amount): number {
  const family = unitFamily(amount.unit);
  if (family === "volume") return round(amount.value * VOLUME_TO_ML[amount.unit as VolumeUnit], 6);
  if (family === "mass") return round(amount.value * MASS_TO_G[amount.unit as MassUnit], 6);
  return amount.value;
}

/** Render a base-unit value back as the cleanest Amount for display. */
export function fromBase(baseValue: number, family: UnitFamily, countUnit: Unit = "st"): Amount {
  if (family === "volume") {
    if (baseValue >= 1000) return { value: round(baseValue / 1000), unit: "l" };
    if (baseValue >= 100) return { value: round(baseValue / 100), unit: "dl" };
    return { value: round(baseValue), unit: "ml" };
  }
  if (family === "mass") {
    if (baseValue >= 1000) return { value: round(baseValue / 1000), unit: "kg" };
    return { value: round(baseValue), unit: "g" };
  }
  return { value: round(baseValue), unit: countUnit };
}

/**
 * Scale an amount, respecting what its unit can actually be divided into.
 *
 * Volumes and masses take any value — 1.5 dl is a real measurement. Counts do
 * not: `round()` alone turned a recipe for 4 scaled to 6 into "4,5 st ägg",
 * which is not a thing to put in a basket, on the very sheet whose own comment
 * says getting this wrong is how you come home with half the cream.
 *
 * Rounded UP rather than to nearest, and that is the whole decision. Half an
 * egg is not purchasable, so the question is only which way to be wrong, and
 * the two directions are not symmetrical: buying one egg too many costs a
 * krona, while buying one too few means the dish cannot be made. The floor of 1
 * follows from the same argument — scaling a recipe down must never produce
 * "0 st", which reads as "do not buy this" for an ingredient the recipe needs.
 */
export function scaleAmount(amount: Amount, factor: number): Amount {
  const scaled = amount.value * factor;
  if (unitFamily(amount.unit) === "count") {
    return { value: Math.max(1, Math.ceil(scaled)), unit: amount.unit };
  }
  return { value: round(scaled), unit: amount.unit };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const VULGAR_FRACTIONS: Record<string, number> = {
  "½": 0.5,
  "¼": 0.25,
  "¾": 0.75,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅛": 0.125,
};

const VULGAR_CLASS = "[½¼¾⅓⅔⅛]";

// Alternatives are ordered most-specific first, since regex alternation picks
// the first match at the current position rather than the longest one:
//   1. ASCII mixed fraction   "1 1/2"
//   2. ASCII simple fraction  "1/2"
//   3. whole + vulgar         "1 ½" / "1½"
//   4. bare vulgar            "½"
//   5. plain decimal/integer  "1,5" / "1.5" / "2"
const NUMBER_RE = new RegExp(
  `^(?:(?<mInt>\\d+)\\s+(?<mNum>\\d+)/(?<mDen>\\d+)` +
    `|(?<fNum>\\d+)/(?<fDen>\\d+)` +
    `|(?<whole>\\d+(?:[.,]\\d+)?)\\s*(?<vulg>${VULGAR_CLASS})` +
    `|(?<vulgOnly>${VULGAR_CLASS})` +
    `|(?<plain>\\d+(?:[.,]\\d+)?))`,
);

const HEDGE_RE = /^(ca|cirka|ungefär)\.?\s+/i;
const RANGE_RE = /^\s*[-–]\s*/;
const WORD_RE = /^\p{L}+/u;

interface NumberMatch {
  value: number;
  length: number;
}

function matchNumber(s: string): NumberMatch | null {
  const m = NUMBER_RE.exec(s);
  if (!m) return null;
  const g = m.groups!;
  let value: number;
  if (g.mInt !== undefined) {
    value = parseInt(g.mInt, 10) + parseInt(g.mNum!, 10) / parseInt(g.mDen!, 10);
  } else if (g.fNum !== undefined) {
    value = parseInt(g.fNum, 10) / parseInt(g.fDen!, 10);
  } else if (g.whole !== undefined) {
    value = parseFloat(g.whole.replace(",", ".")) + VULGAR_FRACTIONS[g.vulg!]!;
  } else if (g.vulgOnly !== undefined) {
    value = VULGAR_FRACTIONS[g.vulgOnly]!;
  } else {
    value = parseFloat(g.plain!.replace(",", "."));
  }
  return { value, length: m[0].length };
}

interface ParsedQuantity {
  amount: Amount;
  /** Index into the (already trimmed) source string where the rest begins. */
  restIndex: number;
}

/**
 * Parses a leading quantity — optional hedge, a number (possibly a range,
 * taking the upper bound), and an optional unit — off the start of `s`.
 * `s` must already be trimmed. Returns null if there is no number at all.
 */
function parseLeadingQuantity(s: string): ParsedQuantity | null {
  let offset = 0;

  const hedge = HEDGE_RE.exec(s);
  if (hedge) offset += hedge[0].length;

  const first = matchNumber(s.slice(offset));
  if (!first) return null;
  offset += first.length;
  let value = first.value;

  // Range: "2-3 dl" / "2–3 dl" -> take the upper bound. Only commit the dash
  // if a valid number actually follows it.
  const rangeSep = RANGE_RE.exec(s.slice(offset));
  if (rangeSep) {
    const upper = matchNumber(s.slice(offset + rangeSep[0].length));
    if (upper) {
      value = upper.value;
      offset += rangeSep[0].length + upper.length;
    }
  }

  // Optional unit word. Only consumed (along with the whitespace before it)
  // when it is actually a known unit — otherwise it belongs to "rest".
  const wsLen = /^\s*/.exec(s.slice(offset))![0].length;
  const wordMatch = WORD_RE.exec(s.slice(offset + wsLen));
  let unit: Unit = "st";
  if (wordMatch) {
    const candidate = wordMatch[0].toLowerCase();
    if (isUnit(candidate)) {
      unit = candidate;
      offset += wsLen + wordMatch[0].length;
    }
  }

  return { amount: { value, unit }, restIndex: offset };
}

/** Parse a standalone amount string. Returns null if there is no number. */
export function parseAmount(input: string): Amount | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const parsed = parseLeadingQuantity(trimmed);
  return parsed ? parsed.amount : null;
}

const WORD_NUMBER_RE = /^(en|ett)\s+(\S.*)$/i;

/** Split a leading quantity off an ingredient line. */
export function parseQuantityPrefix(line: string): { amount: Amount | null; rest: string } {
  const trimmed = line.trim();

  // "en gul lök" / "ett ägg" — only when followed by more words, so "en" or
  // "ett" alone (or the start of an unrelated word like "energisk") doesn't
  // get misread as a quantity.
  const wordNumber = WORD_NUMBER_RE.exec(trimmed);
  if (wordNumber) {
    return { amount: { value: 1, unit: "st" }, rest: wordNumber[2]!.trim() };
  }

  const parsed = parseLeadingQuantity(trimmed);
  if (!parsed) return { amount: null, rest: trimmed };
  return { amount: parsed.amount, rest: trimmed.slice(parsed.restIndex).trim() };
}

// ---------------------------------------------------------------------------
// Merging and formatting
// ---------------------------------------------------------------------------

/**
 * Merge amounts, summing within each family and returning at most one Amount
 * per family. Nulls are ignored. Count units merge ONLY when identical
 * (3 st + 2 st = 5 st; 3 st + 2 påse stays as two entries).
 */
export function mergeAmounts(amounts: Array<Amount | null>): Amount[] {
  let volumeSum = 0;
  let massSum = 0;
  let hasVolume = false;
  let hasMass = false;
  const countTotals = new Map<Unit, number>();

  for (const amount of amounts) {
    if (!amount) continue;
    const family = unitFamily(amount.unit);
    if (family === "volume") {
      volumeSum += toBase(amount);
      hasVolume = true;
    } else if (family === "mass") {
      massSum += toBase(amount);
      hasMass = true;
    } else {
      countTotals.set(amount.unit, (countTotals.get(amount.unit) ?? 0) + amount.value);
    }
  }

  const result: Amount[] = [];
  if (hasVolume) result.push(fromBase(volumeSum, "volume"));
  if (hasMass) result.push(fromBase(massSum, "mass"));
  for (const [unit, value] of countTotals) {
    result.push({ value: round(value), unit });
  }
  return result;
}

function formatNumber(n: number): string {
  const fixed = (Math.round(n * 100) / 100).toFixed(2); // "1.20"
  const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, ""); // "1.2" | "8"
  return (trimmed === "" || trimmed === "-" ? "0" : trimmed).replace(".", ",");
}

export function formatAmount(amount: Amount): string {
  return `${formatNumber(amount.value)} ${amount.unit}`;
}

const FAMILY_ORDER: Record<UnitFamily, number> = { volume: 0, mass: 1, count: 2 };

/** "8 dl + 3 st" — joins with " + " in a stable family order: volume, mass, count. */
export function formatAmounts(amounts: Amount[]): string {
  return [...amounts]
    .sort((a, b) => FAMILY_ORDER[unitFamily(a.unit)] - FAMILY_ORDER[unitFamily(b.unit)])
    .map(formatAmount)
    .join(" + ");
}
