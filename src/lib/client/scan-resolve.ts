import type { Id, SyncState } from "@/lib/domain";

/**
 * Which vara a scanned barcode means, answered from the device's own state.
 *
 * The design doc promised resolution "cheapest-first: local EAN map in
 * IndexedDB (instant, offline) → server map → Open Food Facts → ask the user",
 * and the local step never existed — every scan went straight to `/api/barcode`,
 * so the whole feature died with the signal. `SyncState.barcodes` has held the
 * map since the registry landed, with a comment saying as much; this is the
 * reader it was waiting for.
 *
 * Pure and separate from the scanner for the same reason `scanAction` is: it
 * decides what a scan is allowed to claim, a wrong answer is invisible until a
 * purchase is already wrong, and a component that only a camera can reach is
 * not somewhere to keep that.
 */
export type ScanResolution =
  /** A product, placed on a vara the catalog can still show. Act on it. */
  | { kind: "vara"; catalogItemId: Id; name: string }
  /**
   * A product we know, with no vara anyone can use.
   *
   * Two different situations arrive here on purpose. A product born from a scan
   * that Open Food Facts could not name has never been placed; and a product
   * whose vara has since been merged away or deleted is placed on a word that
   * no longer exists. Both mean the same thing to the person holding the phone —
   * *nobody has told this app what this is* — and both take the same answer.
   *
   * The second one used to be a phantom purchase. `handleScan` fell back to the
   * name "Varan" and carried on removing, so scanning a barcode pointing at a
   * tombstone recorded a purchase against it. Refusing outright was the obvious
   * fix and the worse one: it leaves the shopper holding an item the app will
   * not take. Asking converts a dead end into the one action that repairs it.
   */
  | { kind: "unplaced"; productId: Id }
  /** Never seen this barcode. Everything begins here, once, per EAN. */
  | { kind: "unknown" };

export function resolveScan(state: SyncState, ean: string): ScanResolution {
  const link = state.barcodes[ean];
  if (!link) return { kind: "unknown" };

  /*
   * A link whose product is missing counts as unknown rather than as an error.
   *
   * Scan-born product ids are derived (`prod:${ean}`), so the repair for a
   * dangling pointer is byte-identical to a first sighting: create that same id
   * and link that same EAN. Treating it as unknown therefore heals the row
   * instead of stranding the barcode, and does it with ops two devices can both
   * mint without coordinating.
   */
  const product = state.products[link.productId];
  if (!product) return { kind: "unknown" };

  if (!product.catalogItemId) return { kind: "unplaced", productId: product.id };

  // Absent from `catalog` IS the tombstone — `delete_catalog_item` and
  // `merge_catalog_items` both remove the row and mark the meta deleted.
  const vara = state.catalog[product.catalogItemId];
  if (!vara) return { kind: "unplaced", productId: product.id };

  return { kind: "vara", catalogItemId: vara.id, name: vara.name };
}
