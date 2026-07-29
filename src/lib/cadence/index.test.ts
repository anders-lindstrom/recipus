import { describe, expect, it } from "vitest";
import {
  analyzeCadence,
  catalogOrderScore,
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
