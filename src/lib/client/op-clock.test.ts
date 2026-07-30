import { describe, expect, it } from "vitest";
import { nextOpTimestamp } from "./op-clock";

describe("nextOpTimestamp", () => {
  const now = new Date("2026-03-12T10:00:00.000Z");

  it("uses the wall clock when it has moved on", () => {
    expect(nextOpTimestamp("2026-03-12T09:59:59.000Z", now)).toBe(
      "2026-03-12T10:00:00.000Z",
    );
  });

  it("uses the wall clock for the first op", () => {
    expect(nextOpTimestamp(null, now)).toBe("2026-03-12T10:00:00.000Z");
  });

  it("steps forward when two ops land in the same millisecond", () => {
    // The case that matters: LWW cannot order equal timestamps from one actor,
    // so the second op would silently lose.
    expect(nextOpTimestamp("2026-03-12T10:00:00.000Z", now)).toBe(
      "2026-03-12T10:00:00.001Z",
    );
  });

  it("never goes backwards, even if the wall clock does", () => {
    // NTP corrections and daylight saving both move a client clock backwards.
    // An op stamped in the past would lose to one already applied.
    expect(nextOpTimestamp("2026-03-12T10:00:05.000Z", now)).toBe(
      "2026-03-12T10:00:05.001Z",
    );
  });

  it("keeps increasing across a run of same-millisecond ops", () => {
    let last: string | null = null;
    const stamps: string[] = [];
    for (let i = 0; i < 5; i++) {
      last = nextOpTimestamp(last, now);
      stamps.push(last);
    }
    expect(stamps).toEqual([
      "2026-03-12T10:00:00.000Z",
      "2026-03-12T10:00:00.001Z",
      "2026-03-12T10:00:00.002Z",
      "2026-03-12T10:00:00.003Z",
      "2026-03-12T10:00:00.004Z",
    ]);
    // The property that actually matters, stated directly.
    expect([...stamps].sort()).toEqual(stamps);
    expect(new Set(stamps).size).toBe(stamps.length);
  });
});
