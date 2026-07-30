import { describe, expect, it } from "vitest";
import type { Amount } from "@/lib/domain";
import {
  analyzeCadence,
  catalogOrderScore,
  isCondimentScale,
  localDayKey,
  probablyStillHave,
  purchaseDays,
  rankSuggestions,
  type SuggestionInput,
} from "@/lib/cadence";

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Builds purchase dates from a start date and the gaps (in days) between them. */
function datesFromIntervals(start: Date, intervals: number[]): Date[] {
  const dates = [start];
  let cursor = start;
  for (const gap of intervals) {
    cursor = addDays(cursor, gap);
    dates.push(cursor);
  }
  return dates;
}

const START = new Date("2026-01-01T00:00:00.000Z");

describe("analyzeCadence", () => {
  it("stays silent with zero purchases", () => {
    const stats = analyzeCadence([], START);
    expect(stats.purchaseCount).toBe(0);
    expect(stats.medianIntervalDays).toBeNull();
    expect(stats.confidence).toBe(0);
    expect(stats.overdueScore).toBeNull();
    expect(stats.daysSinceLast).toBeNull();
  });

  it("stays silent with a single purchase, but still reports daysSinceLast", () => {
    const purchase = START;
    const now = addDays(START, 10);
    const stats = analyzeCadence([purchase], now);
    expect(stats.purchaseCount).toBe(1);
    expect(stats.medianIntervalDays).toBeNull();
    expect(stats.confidence).toBe(0);
    expect(stats.overdueScore).toBeNull();
    expect(stats.daysSinceLast).toBe(10);
  });

  it("stays silent with two purchases (one interval is not enough)", () => {
    const purchases = datesFromIntervals(START, [7]);
    const now = addDays(purchases[1], 4);
    const stats = analyzeCadence(purchases, now);
    expect(stats.purchaseCount).toBe(2);
    expect(stats.medianIntervalDays).toBeNull();
    expect(stats.confidence).toBe(0);
    expect(stats.overdueScore).toBeNull();
    expect(stats.daysSinceLast).toBe(4);
  });

  it("speaks up at exactly three purchases (two intervals)", () => {
    const purchases = datesFromIntervals(START, [7, 7]);
    const now = addDays(purchases[2], 3);
    const stats = analyzeCadence(purchases, now);
    expect(stats.purchaseCount).toBe(3);
    expect(stats.medianIntervalDays).toBe(7);
    // Perfectly regular, but only two intervals of history: confidence is
    // real but modest (count factor 2/7), and below the suggestion floor.
    expect(stats.confidence).toBeGreaterThan(0);
    expect(stats.confidence).toBeCloseTo(2 / 7, 5);
    expect(stats.confidence).toBeLessThan(0.3);
    expect(stats.daysSinceLast).toBe(3);
    expect(stats.overdueScore).toBeCloseTo(3 / 7, 5);
  });

  it("uses the true median, not the mean, so one outlier gap can't poison the interval", () => {
    // Mostly a steady 7-day buyer, with one holiday-length 60-day gap.
    const purchases = datesFromIntervals(START, [7, 7, 7, 60, 7, 7, 7]);
    const now = addDays(purchases[purchases.length - 1], 7);
    const stats = analyzeCadence(purchases, now);
    // The mean of these intervals is ~15.7 days; the median absorbs the
    // outlier and stays at the item's real cadence.
    expect(stats.medianIntervalDays).toBe(7);
  });

  it("scores a regular buyer (milk, ~4±1 days) with high confidence", () => {
    // 10 intervals clustered around 4 days: three 3's, four 4's, three 5's.
    const intervals = [3, 4, 5, 4, 3, 5, 4, 4, 5, 3];
    const purchases = datesFromIntervals(START, intervals);
    const now = addDays(purchases[purchases.length - 1], 4);
    const stats = analyzeCadence(purchases, now);
    expect(stats.medianIntervalDays).toBe(4);
    expect(stats.confidence).toBeGreaterThan(0.7);
  });

  it("scores an erratic buyer (saffron, gaps of 3/90/12/200 days) near zero confidence", () => {
    const purchases = datesFromIntervals(START, [3, 90, 12, 200]);
    const now = addDays(purchases[purchases.length - 1], 5);
    const stats = analyzeCadence(purchases, now);
    expect(stats.confidence).toBeLessThan(0.1);
  });

  it("reports overdueScore around 1 for an item due today", () => {
    const intervals = [3, 4, 5, 4, 3, 5, 4, 4, 5, 3];
    const purchases = datesFromIntervals(START, intervals);
    const now = addDays(purchases[purchases.length - 1], 4); // == median
    const stats = analyzeCadence(purchases, now);
    expect(stats.overdueScore).toBe(1);
  });

  it("reports a large overdueScore for a badly overdue item", () => {
    const intervals = [3, 4, 5, 4, 3, 5, 4, 4, 5, 3];
    const purchases = datesFromIntervals(START, intervals);
    const now = addDays(purchases[purchases.length - 1], 30); // median is 4
    const stats = analyzeCadence(purchases, now);
    expect(stats.overdueScore).toBeCloseTo(7.5, 5);
    expect(stats.overdueScore).toBeGreaterThan(2);
  });

  /**
   * The bug this dedup exists for.
   *
   * Two people shopping at different shops on the same Saturday, or one item
   * ticked off on both the Hemköp and the ICA list, and every one of those days
   * contributes a zero-day interval. Half the intervals being zero drags the
   * median to half its true value, and the engine starts suggesting weekly items
   * every three or four days.
   */
  it("does not let a same-day double purchase halve the median", () => {
    const weekly = datesFromIntervals(START, [7, 7, 7, 7, 7, 7, 7]);
    const doubled = weekly.flatMap((d) => [d, new Date(d.getTime() + 3 * 60 * 60 * 1000)]);

    const clean = analyzeCadence(weekly, addDays(START, 60));
    const withDoubles = analyzeCadence(doubled, addDays(START, 60));

    expect(clean.medianIntervalDays).toBe(7);
    expect(withDoubles.medianIntervalDays).toBe(7);
    expect(withDoubles.purchaseCount).toBe(clean.purchaseCount);
    // Confidence too: zero-day intervals inflate the MAD as well as moving the
    // median, so an item bought like clockwork looked erratic.
    expect(withDoubles.confidence).toBeCloseTo(clean.confidence, 10);
  });

  /**
   * Dedup keeps the LAST purchase of a day, not the first.
   *
   * Keeping the first would make the app think you shopped longer ago than you
   * did, which is the direction that produces a false "you're out of this".
   */
  it("measures daysSinceLast from the last purchase of the day", () => {
    const morning = new Date("2026-02-10T08:00:00.000Z");
    const evening = new Date("2026-02-10T19:00:00.000Z");
    const now = new Date("2026-02-11T19:00:00.000Z");
    const stats = analyzeCadence([morning, evening], now);
    expect(stats.purchaseCount).toBe(1);
    expect(stats.daysSinceLast).toBe(1);
  });

  /** Two genuinely separate days are still two purchases. */
  it("does not collapse purchases on different days", () => {
    const purchases = datesFromIntervals(START, [1, 1]);
    const stats = analyzeCadence(purchases, addDays(START, 3));
    expect(stats.purchaseCount).toBe(3);
    expect(stats.medianIntervalDays).toBe(1);
  });
});

describe("rankSuggestions", () => {
  /** A confident item: median 4 days, 10 intervals -> confidence ~0.75. */
  function regularItem(catalogItemId: string): SuggestionInput {
    const intervals = [3, 4, 5, 4, 3, 5, 4, 4, 5, 3];
    const purchases = datesFromIntervals(START, intervals);
    return { catalogItemId, purchases };
  }

  /** `now` at which every `regularItem` above is exactly due (overdueScore 1). */
  const dueNow = addDays(datesFromIntervals(START, [3, 4, 5, 4, 3, 5, 4, 4, 5, 3]).at(-1)!, 4);

  it("suggests nothing below the overdue threshold", () => {
    const intervals = [7, 7, 7, 7, 7, 7, 7]; // median 7, high confidence
    const purchases = datesFromIntervals(START, intervals);
    const barelyDue = addDays(purchases[purchases.length - 1], 5); // 5/7 = 0.71 < 0.85
    const result = rankSuggestions(
      [{ catalogItemId: "a", purchases }],
      { now: barelyDue },
    );
    expect(result).toEqual([]);
  });

  it("suggests an item at or above the 0.85 overdue threshold", () => {
    const intervals = [7, 7, 7, 7, 7, 7, 7]; // median 7, high confidence
    const purchases = datesFromIntervals(START, intervals);
    const due = addDays(purchases[purchases.length - 1], 6); // 6/7 ~= 0.857 >= 0.85
    const result = rankSuggestions([{ catalogItemId: "a", purchases }], { now: due });
    expect(result).toHaveLength(1);
    expect(result[0].catalogItemId).toBe("a");
  });

  it("never suggests an item below the confidence floor, however overdue", () => {
    const erraticPurchases = datesFromIntervals(START, [3, 90, 12, 200]);
    const veryLate = addDays(erraticPurchases[erraticPurchases.length - 1], 500);
    const stats = analyzeCadence(erraticPurchases, veryLate);
    // Sanity check the fixture: wildly overdue, but low confidence.
    expect(stats.overdueScore).toBeGreaterThan(5);
    expect(stats.confidence).toBeLessThan(0.3);

    const result = rankSuggestions(
      [{ catalogItemId: "saffron", purchases: erraticPurchases }],
      { now: veryLate },
    );
    expect(result).toEqual([]);
  });

  it("drops excluded items before applying the limit", () => {
    const items: SuggestionInput[] = ["a", "b"].map((id) => regularItem(id));
    const result = rankSuggestions(items, {
      now: dueNow,
      excludeItemIds: new Set(["a"]),
    });
    expect(result).toHaveLength(1);
    expect(result[0].catalogItemId).toBe("b");
  });

  it("caps output at the default limit of 8", () => {
    const items: SuggestionInput[] = Array.from({ length: 12 }, (_, i) =>
      regularItem(`item-${i}`),
    );
    const result = rankSuggestions(items, { now: dueNow });
    expect(result).toHaveLength(8);
  });

  it("respects a custom limit", () => {
    const items: SuggestionInput[] = Array.from({ length: 12 }, (_, i) =>
      regularItem(`item-${i}`),
    );
    const result = rankSuggestions(items, { now: dueNow, limit: 3 });
    expect(result).toHaveLength(3);
  });

  it("sorts by overdueScore descending", () => {
    const now = addDays(START, 5000);
    // Both far overdue, but "fast" (small median) racks up a higher ratio
    // for the same absolute days-since-last.
    const result = rankSuggestions(
      [
        { catalogItemId: "slow", purchases: datesFromIntervals(START, [10, 10, 10, 10, 10, 10, 10]) },
        { catalogItemId: "fast", purchases: datesFromIntervals(START, [4, 4, 4, 4, 4, 4, 4]) },
      ],
      { now },
    );
    expect(result.map((r) => r.catalogItemId)).toEqual(["fast", "slow"]);
    expect(result[0].overdueScore).toBeGreaterThan(result[1].overdueScore);
  });

  it("tie-breaks equal overdueScore by confidence descending", () => {
    // Item A: median 4, 10 intervals -> confidence ~0.75, overdueScore exactly 1.
    const aIntervals = [3, 4, 5, 4, 3, 5, 4, 4, 5, 3];
    const aPurchases = datesFromIntervals(START, aIntervals);
    const now = addDays(aPurchases[aPurchases.length - 1], 4);

    // Item B: median 10, only 3 intervals -> confidence ~0.43, but timed so
    // overdueScore is also exactly 1 at the same `now`.
    const bIntervals = [10, 10, 10];
    const bStart = addDays(now, -10 - 30); // last purchase 10 days before `now`
    const bPurchases = datesFromIntervals(bStart, bIntervals);
    expect(bPurchases[bPurchases.length - 1].getTime()).toBe(addDays(now, -10).getTime());

    const statsA = analyzeCadence(aPurchases, now);
    const statsB = analyzeCadence(bPurchases, now);
    expect(statsA.overdueScore).toBe(1);
    expect(statsB.overdueScore).toBe(1);
    expect(statsA.confidence).toBeGreaterThan(statsB.confidence);

    const result = rankSuggestions(
      [
        { catalogItemId: "b", purchases: bPurchases },
        { catalogItemId: "a", purchases: aPurchases },
      ],
      { now },
    );
    expect(result.map((r) => r.catalogItemId)).toEqual(["a", "b"]);
  });

  it('reasons "brukar nu" when the item is due right on schedule', () => {
    const intervals = [3, 4, 5, 4, 3, 5, 4, 4, 5, 3]; // median 4
    const purchases = datesFromIntervals(START, intervals);
    const now = addDays(purchases[purchases.length - 1], 4); // daysOverdue = 0
    const result = rankSuggestions([{ catalogItemId: "a", purchases }], { now });
    expect(result[0].reason).toBe("brukar nu");
  });

  it('reasons "N dgr sen" for 1-13 days overdue', () => {
    const intervals = [3, 4, 5, 4, 3, 5, 4, 4, 5, 3]; // median 4
    const purchases = datesFromIntervals(START, intervals);
    const now = addDays(purchases[purchases.length - 1], 10); // daysOverdue = round(10-4) = 6
    const result = rankSuggestions([{ catalogItemId: "a", purchases }], { now });
    expect(result[0].reason).toBe("6 dgr sen");
  });

  it('reasons "N v sen" for 14+ days overdue', () => {
    const intervals = [3, 4, 5, 4, 3, 5, 4, 4, 5, 3]; // median 4
    const purchases = datesFromIntervals(START, intervals);
    const now = addDays(purchases[purchases.length - 1], 30); // daysOverdue = round(30-4) = 26 -> 3 weeks
    const result = rankSuggestions([{ catalogItemId: "a", purchases }], { now });
    expect(result[0].reason).toBe("3 v sen");
  });
});

describe("catalogOrderScore", () => {
  it("scores a never-used item at 0", () => {
    expect(catalogOrderScore(0, null, START)).toBe(0);
    expect(catalogOrderScore(50, null, START)).toBe(0);
  });

  it("ranks a lightly-used-but-recent item above a heavily-used-but-stale one", () => {
    const now = addDays(START, 365);
    const staleButPopular = catalogOrderScore(50, START, now); // used 50x, a year ago
    const freshButRare = catalogOrderScore(5, addDays(now, -7), now); // used 5x, this week
    expect(freshButRare).toBeGreaterThan(staleButPopular);
  });

  it("ranks more recent use higher for the same use count", () => {
    const now = addDays(START, 100);
    const recent = catalogOrderScore(10, addDays(now, -5), now);
    const older = catalogOrderScore(10, addDays(now, -50), now);
    expect(recent).toBeGreaterThan(older);
  });

  it("ranks higher use count higher for the same recency", () => {
    const now = addDays(START, 100);
    const usedOften = catalogOrderScore(20, addDays(now, -10), now);
    const usedRarely = catalogOrderScore(2, addDays(now, -10), now);
    expect(usedOften).toBeGreaterThan(usedRarely);
  });

  it("decays by half at exactly the half-life", () => {
    const now = addDays(START, 30);
    const score = catalogOrderScore(10, START, now);
    expect(score).toBeCloseTo(5, 5);
  });
});

describe("probablyStillHave", () => {
  /**
   * The gates are asymmetric on purpose: a redundant tile is a glance, a missing
   * ingredient is discovered while cooking. These tests pin that asymmetry rather
   * than the individual numbers, so tuning the thresholds later cannot quietly
   * widen the rule into the dangerous direction.
   */
  const now = new Date("2026-03-30T12:00:00.000Z");

  /** Weekly-ish purchases, so median ≈ 7 days and confidence is high. */
  function weekly(count: number, daysSinceLast: number): Date[] {
    const out: Date[] = [];
    for (let i = count - 1; i >= 0; i--) {
      out.push(new Date(now.getTime() - (daysSinceLast + i * 7) * 86400000));
    }
    return out;
  }

  const soy: Amount = { value: 1, unit: "msk" };
  const cream: Amount = { value: 5, unit: "dl" };
  const mince: Amount = { value: 500, unit: "g" };

  it("excludes a condiment bought well inside its normal interval", () => {
    const stats = analyzeCadence(weekly(8, 2), now);
    expect(probablyStillHave(stats, soy)).toBe(true);
  });

  it("does not exclude one bought more than half an interval ago", () => {
    const stats = analyzeCadence(weekly(8, 5), now);
    expect(probablyStillHave(stats, soy)).toBe(false);
  });

  it("never excludes a bulk quantity, however strong the history", () => {
    // The load-bearing test. Bought yesterday, years of weekly history — and it
    // must STILL go on the list, because the recipe wants five decilitres.
    const stats = analyzeCadence(weekly(50, 1), now);
    expect(stats.confidence).toBeGreaterThan(0.9);
    expect(probablyStillHave(stats, cream)).toBe(false);
    expect(probablyStillHave(stats, mince)).toBe(false);
  });

  it("excludes an ingredient with no stated amount", () => {
    // "salt och peppar" — the case the amount gate exists to allow.
    const stats = analyzeCadence(weekly(8, 1), now);
    expect(probablyStillHave(stats, null)).toBe(true);
  });

  it("excludes nothing without enough history", () => {
    // Fresh install: inert by construction, which is the graceful degradation.
    expect(probablyStillHave(analyzeCadence([], now), soy)).toBe(false);
    expect(probablyStillHave(analyzeCadence(weekly(1, 1), now), soy)).toBe(false);
    expect(probablyStillHave(analyzeCadence(weekly(2, 1), now), soy)).toBe(false);
  });

  it("respects the per-item interval rather than a flat window", () => {
    // Three weeks since the last bottle. Yoghurt bought weekly: you are out.
    // Soy sauce bought yearly: you certainly are not. A flat "within a week"
    // rule would get both wrong, in opposite directions.
    const yearly: Date[] = [];
    for (let i = 4; i >= 0; i--) {
      yearly.push(new Date(now.getTime() - (21 + i * 365) * 86400000));
    }
    expect(probablyStillHave(analyzeCadence(weekly(10, 21), now), soy)).toBe(false);
    expect(probablyStillHave(analyzeCadence(yearly, now), soy)).toBe(true);
  });

  it("treats the condiment ceiling by unit family, not raw number", () => {
    expect(isCondimentScale({ value: 1, unit: "dl" })).toBe(true);
    expect(isCondimentScale({ value: 2, unit: "dl" })).toBe(false);
    expect(isCondimentScale({ value: 100, unit: "g" })).toBe(true);
    expect(isCondimentScale({ value: 1, unit: "hg" })).toBe(true);
    expect(isCondimentScale({ value: 2, unit: "st" })).toBe(true);
    expect(isCondimentScale({ value: 3, unit: "st" })).toBe(false);
  });
});

describe("localDayKey", () => {
  /**
   * One definition of "which day is this", shared by the cadence engine's
   * per-day purchase collapsing and by suggestion dismissals.
   *
   * They are the same question — "the same shopping occasion" and "for the rest
   * of today" both mean a household's local calendar day, not a UTC one and not
   * a rolling 24 hours. Two implementations of that would drift at exactly one
   * hour of the year and be unreproducible when they did.
   */
  it("is the local calendar day, zero-padded", () => {
    expect(localDayKey(new Date(2026, 6, 5, 13, 30))).toBe("2026-07-05");
    // Padding is not cosmetic: unpadded keys sort wrong, and this string is a
    // database primary key component.
    expect(localDayKey(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });

  it("puts just-before-midnight and just-after on different days", () => {
    const before = localDayKey(new Date(2026, 6, 5, 23, 59, 59));
    const after = localDayKey(new Date(2026, 6, 6, 0, 0, 1));
    expect(before).not.toBe(after);
  });

  it("agrees with the day boundary purchaseDays already uses", () => {
    // If these two ever disagree, a dismissal silences an item for a window
    // that does not line up with the day the engine reasons about.
    const evening = new Date(2026, 6, 5, 22, 0);
    const nextMorning = new Date(2026, 6, 6, 7, 0);
    expect(purchaseDays([evening, nextMorning])).toHaveLength(2);
    expect(localDayKey(evening)).not.toBe(localDayKey(nextMorning));

    const sameDay = new Date(2026, 6, 5, 8, 0);
    expect(purchaseDays([evening, sameDay])).toHaveLength(1);
    expect(localDayKey(evening)).toBe(localDayKey(sameDay));
  });
});
