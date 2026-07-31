import { describe, expect, it } from "vitest";
import { modeAfterIdle } from "./use-mode";

/**
 * The idle rule, which is now also the relaunch rule.
 *
 * Buy mode used to live in `sessionStorage`, so being killed and relaunched —
 * which is exactly what a phone does to an app holding a camera open in a shop —
 * dropped you back to "Planerar" without saying so, and every tick after that
 * recorded nothing. Restoring it is governed by the same 90 minutes that already
 * decide when an open app gives up, so what is tested here is one boundary, not
 * two that could drift apart.
 */

const IDLE_MS = 90 * 60 * 1000;
const NOW = Date.parse("2026-07-31T18:00:00.000Z");

function buyingAt(msAgo: number) {
  return { mode: "buy" as const, lastActivityAt: NOW - msAgo };
}

describe("modeAfterIdle", () => {
  it("plans when nothing has ever been stored", () => {
    expect(modeAfterIdle(null, NOW)).toBe("plan");
  });

  it("leaves plan as plan however old it is", () => {
    const lastYear = { mode: "plan" as const, lastActivityAt: 0 };
    expect(modeAfterIdle(lastYear, NOW)).toBe("plan");
  });

  /** The bug this exists for: relaunched mid-shop, four minutes after a tick. */
  it("comes back shopping when the shop is still going on", () => {
    expect(modeAfterIdle(buyingAt(4 * 60 * 1000), NOW)).toBe("buy");
  });

  it("comes back planning the next morning", () => {
    expect(modeAfterIdle(buyingAt(14 * 60 * 60 * 1000), NOW)).toBe("plan");
  });

  it("holds buy mode right up to the window and drops it one ms past", () => {
    expect(modeAfterIdle(buyingAt(IDLE_MS), NOW)).toBe("buy");
    expect(modeAfterIdle(buyingAt(IDLE_MS + 1), NOW)).toBe("plan");
  });

  /**
   * One boundary, stated as a property.
   *
   * A restore window that outran the idle window would put a household back in
   * buy mode for a shop that ended last night, and every tap after that would
   * invent a purchase — so the two questions have to be one function with one
   * flip in it.
   */
  it("flips exactly once, at the idle window", () => {
    const ages = [
      0,
      1_000,
      60_000,
      IDLE_MS - 1,
      IDLE_MS,
      IDLE_MS + 1,
      IDLE_MS * 2,
    ];
    expect(ages.map((age) => modeAfterIdle(buyingAt(age), NOW))).toEqual([
      "buy",
      "buy",
      "buy",
      "buy",
      "buy",
      "plan",
      "plan",
    ]);
  });
});
