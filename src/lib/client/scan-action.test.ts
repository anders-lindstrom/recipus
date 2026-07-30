import { describe, expect, it } from "vitest";
import { scanAction } from "./scan-action";

describe("scanAction", () => {
  it("adds to the list when planning and the item is not on it", () => {
    expect(scanAction("plan", false)).toEqual({ kind: "add" });
  });

  /**
   * The case that makes plan mode safe to point at anything.
   *
   * The scanner stays open and keeps firing, so the same barcode gets read more
   * than once in a session — and you may well scan something you already listed.
   * If that removed it, a scan would undo itself and the list would end up
   * missing the very thing you were photographing.
   */
  it("never removes anything when planning", () => {
    expect(scanAction("plan", true)).toEqual({ kind: "already_on_list" });
  });

  it("ticks off and buys when shopping and the item is on the list", () => {
    expect(scanAction("buy", true)).toEqual({ kind: "buy" });
  });

  it("lists and buys an unplanned pickup when shopping", () => {
    expect(scanAction("buy", false)).toEqual({ kind: "add_and_buy" });
  });

  /**
   * Pinned deliberately: a purchase may only be written while shopping.
   *
   * This is the invariant the modes exist for. Plan mode is where you edit the
   * list at the kitchen table, and if a scan there could record a purchase, the
   * cadence engine and the statistics would learn from planning as though it
   * were shopping — the corruption is silent and cumulative.
   */
  it("only buys in buy mode", () => {
    for (const onList of [true, false]) {
      const action = scanAction("plan", onList);
      expect(action.kind).not.toBe("buy");
      expect(action.kind).not.toBe("add_and_buy");
    }
  });
});
