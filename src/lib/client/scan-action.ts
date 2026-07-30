import type { ShopMode } from "./use-mode";

/**
 * What a barcode scan should do, given the mode and whether the item is already
 * on the list.
 *
 * Pure and separate from the scanner for one reason: this is the table that
 * decides whether a scan puts something on your shopping list or takes it off,
 * and getting a cell wrong is invisible until a list is already wrong. Four
 * cells is small enough to state outright and pin with tests, and too important
 * to leave inlined in a component where only a camera can reach it.
 *
 * The asymmetry between the modes is the whole point:
 *
 * BUY mode is bidirectional. You are in the shop with the trolley, so a scan
 * means "this is in my hands now" — tick it off, and record the purchase. An
 * unplanned pickup is added and bought in one gesture, because the item belongs
 * in the history even though it never belonged on the list.
 *
 * PLAN mode only ever adds. Scanning while planning is how you say "we want
 * this": you are looking at a product — in the cupboard, in a delivery, on a
 * screen — and pointing the camera at it to get it onto the list. Taking it
 * *off* would be the opposite of what the gesture means, and a scan is a gesture
 * you make repeatedly and half-aimed, so a bidirectional plan-mode scan quietly
 * removes things you were trying to add. Nothing is lost by refusing: tapping
 * the tile removes it, deliberately, one tap.
 */
export type ScanAction =
  /** Not on the list, planning: put it on. */
  | { kind: "add" }
  /** Not on the list, shopping: it is in the trolley — list it and buy it at once. */
  | { kind: "add_and_buy" }
  /** On the list, shopping: tick off and record the purchase. */
  | { kind: "buy" }
  /** On the list, planning: already where you wanted it. Do nothing. */
  | { kind: "already_on_list" };

export function scanAction(mode: ShopMode, onList: boolean): ScanAction {
  if (mode === "buy") return onList ? { kind: "buy" } : { kind: "add_and_buy" };
  return onList ? { kind: "already_on_list" } : { kind: "add" };
}
