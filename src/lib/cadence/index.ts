/**
 * Purchase-cadence engine.
 *
 * Pure: no database, network or DOM access. Turns a catalog item's purchase
 * history into "you're probably out of milk" — see
 * docs/superpowers/specs/2026-07-29-recipus-design.md section 5.3.
 */

import type { Amount, Id, UnitFamily } from "@/lib/domain";
import { toBase, unitFamily } from "@/lib/units";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Minimum purchases before an item has any opinion at all (2 intervals). */
const MIN_PURCHASES = 3;

/**
 * Confidence saturates once an item has this many purchase intervals (i.e.
 * roughly 8-10 purchases), per the "saturating around 8-10 purchases" rule.
 */
const CONFIDENCE_SATURATION_INTERVALS = 7;

/** Half-life, in days, of the recency decay used by catalogOrderScore. */
const CATALOG_ORDER_HALF_LIFE_DAYS = 30;

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface CadenceStats {
  purchaseCount: number;
  /** Median days between purchases. Null when there is not enough history. */
  medianIntervalDays: number | null;
  /** 0..1. How much to trust medianIntervalDays. */
  confidence: number;
  /** daysSinceLast / medianIntervalDays. Null when medianIntervalDays is null. */
  overdueScore: number | null;
  daysSinceLast: number | null;
}

/**
 * (purchaseDates, now) -> { medianIntervalDays, confidence, overdueScore }.
 *
 * Confidence formula: a robust coefficient of variation, plus a count factor
 * that saturates once there is enough history to trust it.
 *
 *   cv               = MAD(intervals) / median(intervals)   -- robust spread
 *   consistencyScore  = clamp(1 - cv, 0, 1)                  -- 0 = erratic, 1 = metronomic
 *   countFactor       = clamp(intervalCount / 7, 0, 1)       -- ramps up to 1 by ~8 purchases
 *   confidence        = consistencyScore * countFactor
 *
 * Median absolute deviation (MAD), not standard deviation, so a single wild
 * gap doesn't dominate the spread estimate any more than it dominates the
 * median interval itself. An item bought every 4±1 days has cv ~0.13-0.25 and
 * clears 0.7 once countFactor reaches 1; an item bought at wildly irregular
 * intervals (e.g. 3, 90, 12, 200 days apart) has cv well above 0.8 and scores
 * near zero regardless of count.
 */
export function analyzeCadence(purchaseDates: Date[], now: Date): CadenceStats {
  const purchaseCount = purchaseDates.length;

  if (purchaseCount === 0) {
    return {
      purchaseCount,
      medianIntervalDays: null,
      confidence: 0,
      overdueScore: null,
      daysSinceLast: null,
    };
  }

  const sorted = [...purchaseDates].sort((a, b) => a.getTime() - b.getTime());
  const daysSinceLast = daysBetween(sorted[sorted.length - 1], now);

  if (purchaseCount < MIN_PURCHASES) {
    return {
      purchaseCount,
      medianIntervalDays: null,
      confidence: 0,
      overdueScore: null,
      daysSinceLast,
    };
  }

  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    intervals.push(daysBetween(sorted[i - 1], sorted[i]));
  }

  const medianIntervalDays = median(intervals);
  const mad = median(intervals.map((interval) => Math.abs(interval - medianIntervalDays)));
  const cv = medianIntervalDays === 0 ? (mad === 0 ? 0 : Infinity) : mad / medianIntervalDays;
  const consistencyScore = clamp(1 - cv, 0, 1);
  const countFactor = clamp(intervals.length / CONFIDENCE_SATURATION_INTERVALS, 0, 1);
  const confidence = consistencyScore * countFactor;

  const overdueScore =
    medianIntervalDays > 0
      ? daysSinceLast / medianIntervalDays
      : daysSinceLast > 0
        ? Infinity
        : 0;

  return { purchaseCount, medianIntervalDays, confidence, overdueScore, daysSinceLast };
}

/** Suggestions are never made below this confidence, however overdue. */
const SUGGESTION_CONFIDENCE_FLOOR = 0.3;

/** Suggestion threshold on overdueScore. */
const SUGGESTION_OVERDUE_THRESHOLD = 0.85;

const DEFAULT_SUGGESTION_LIMIT = 8;

export interface SuggestionInput {
  catalogItemId: Id;
  purchases: Date[];
}

export interface Suggestion {
  catalogItemId: Id;
  overdueScore: number;
  confidence: number;
  medianIntervalDays: number;
  daysSinceLast: number;
  /** Swedish, shown under the tile: "6 dgr sen", "brukar nu", "2 v sen". */
  reason: string;
}

function reasonFor(daysSinceLast: number, medianIntervalDays: number): string {
  const daysOverdue = Math.round(daysSinceLast - medianIntervalDays);
  if (daysOverdue <= 0) return "brukar nu";
  if (daysOverdue <= 13) return `${daysOverdue} dgr sen`;
  const weeksOverdue = Math.floor(daysOverdue / 7);
  return `${weeksOverdue} v sen`;
}

/**
 * Ranks catalog items by how overdue they are, for the "Föreslås" row.
 *
 * Items with insufficient history, below the overdue threshold, or below the
 * confidence floor never appear. Exclusions (already on the list) are removed
 * before the limit is applied, so a full list never crowds out a genuinely
 * overdue item that just happens to already be there.
 */
export function rankSuggestions(
  items: SuggestionInput[],
  opts: { now: Date; excludeItemIds?: Set<Id>; limit?: number },
): Suggestion[] {
  const exclude = opts.excludeItemIds ?? new Set<Id>();
  const limit = opts.limit ?? DEFAULT_SUGGESTION_LIMIT;

  const candidates: Suggestion[] = [];
  for (const item of items) {
    if (exclude.has(item.catalogItemId)) continue;

    const stats = analyzeCadence(item.purchases, opts.now);
    if (
      stats.medianIntervalDays === null ||
      stats.overdueScore === null ||
      stats.daysSinceLast === null
    ) {
      continue;
    }
    if (stats.overdueScore < SUGGESTION_OVERDUE_THRESHOLD) continue;
    if (stats.confidence < SUGGESTION_CONFIDENCE_FLOOR) continue;

    candidates.push({
      catalogItemId: item.catalogItemId,
      overdueScore: stats.overdueScore,
      confidence: stats.confidence,
      medianIntervalDays: stats.medianIntervalDays,
      daysSinceLast: stats.daysSinceLast,
      reason: reasonFor(stats.daysSinceLast, stats.medianIntervalDays),
    });
  }

  candidates.sort((a, b) => b.overdueScore - a.overdueScore || b.confidence - a.confidence);
  return candidates.slice(0, limit);
}

/**
 * Recency+frequency score for ordering the catalog. Higher sorts first.
 * Completely separate from cadence — needs no purchase history and works from
 * week one, on the plain use_count/last_used_at columns on CatalogItem.
 *
 * `useCount * 2^(-daysSinceLastUse / halfLife)`: usage decays exponentially
 * with a 30-day half-life, so an item used 50 times a year ago (decayed to
 * ~0.02% of its weight) ranks below one used 5 times this week.
 */
export function catalogOrderScore(useCount: number, lastUsedAt: Date | null, now: Date): number {
  if (lastUsedAt === null) return 0;
  const daysSinceLastUse = Math.max(0, daysBetween(lastUsedAt, now));
  return useCount * Math.pow(2, -daysSinceLastUse / CATALOG_ORDER_HALF_LIFE_DAYS);
}

// ---------------------------------------------------------------------------
// "We probably still have this"
// ---------------------------------------------------------------------------

/**
 * Confidence floor for excluding an ingredient from a recipe.
 *
 * Stricter than SUGGESTION_CONFIDENCE_FLOOR on purpose. Being wrong about a
 * suggestion costs a glance at a row you did not need; being wrong here costs an
 * ingredient you discover missing while cooking.
 */
const STILL_HAVE_CONFIDENCE_FLOOR = 0.5;

/**
 * How far into the normal interval we are still willing to assume you have it.
 *
 * Half. Not "within a week" — a flat window gets yoghurt and soy sauce wrong in
 * opposite directions, and the whole point of having a cadence per item is that
 * the app already knows the difference.
 */
const STILL_HAVE_INTERVAL_FRACTION = 0.5;

/**
 * The largest demand we will assume is already covered by what is in the cupboard.
 *
 * This gate is doing the work a perishability taxonomy would otherwise do, and we
 * do not have one: no quantity is recorded per purchase, so "bought grädde two
 * days ago" cannot distinguish one carton from three. What we DO know is what the
 * recipe is asking for. Gating on that captures the real win — spices, oils,
 * vinegar, mustard, soy — and refuses the dangerous one, 5 dl of cream or 500 g of
 * mince, whatever the history says.
 */
const CONDIMENT_SCALE: Record<UnitFamily, number> = {
  volume: 100, // ml, i.e. 1 dl
  mass: 100, // g
  count: 2, // st
};

/** True when the recipe wants little enough that the cupboard plausibly covers it. */
export function isCondimentScale(amount: Amount | null): boolean {
  // "Salt och peppar" has no amount at all, which is exactly the case this is for.
  if (amount === null) return true;
  return toBase(amount) <= CONDIMENT_SCALE[unitFamily(amount.unit)];
}

/**
 * Whether a recipe ingredient is probably already in the kitchen.
 *
 * Four independent gates, ALL of which must hold. That is the design, not
 * belt-and-braces: excluding something you actually needed is discovered while
 * cooking, which is far worse than a redundant tile you can ignore. The
 * asymmetry is deliberate and is what the tests pin.
 *
 * Degrades to "no" by construction. With no purchase history there is no median,
 * so nothing is ever excluded — which means this is inert on a fresh install and
 * only starts helping as history accumulates. There is no cliff to fall off.
 */
export function probablyStillHave(
  stats: CadenceStats,
  amount: Amount | null,
): boolean {
  if (stats.medianIntervalDays === null) return false; // implies < MIN_PURCHASES
  if (stats.daysSinceLast === null) return false;
  if (stats.confidence < STILL_HAVE_CONFIDENCE_FLOOR) return false;
  if (!isCondimentScale(amount)) return false;
  return (
    stats.daysSinceLast <=
    stats.medianIntervalDays * STILL_HAVE_INTERVAL_FRACTION
  );
}
