import { describe, expect, it } from "vitest";
import { type CatalogItem, emptyState, productId, type SyncState } from "@/lib/domain";
import { resolveScan } from "./scan-resolve";

const EAN = "7310865004703";
const PROD = productId(EAN);

function vara(id: string, name: string): CatalogItem {
  return {
    id,
    name,
    nameNorm: name,
    categoryId: "mejeri-agg",
    iconRef: "1F95B",
    isCustom: false,
    hasAtHome: false,
    useCount: 0,
    lastUsedAt: null,
  };
}

/** A state with the barcode linked to a product placed on a live vara. */
function placed(): SyncState {
  const state = emptyState();
  state.catalog["mjolk"] = vara("mjolk", "mjölk");
  state.products[PROD] = {
    id: PROD,
    name: "Mellanmjölk 1,5%",
    brand: "Arla",
    catalogItemId: "mjolk",
    defaultSize: null,
    sourceSizeText: null,
    imageUrl: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: "anders",
  };
  state.barcodes[EAN] = { ean: EAN, productId: PROD, source: "manual" };
  return state;
}

describe("resolveScan", () => {
  it("answers from local state alone when the product is placed", () => {
    expect(resolveScan(placed(), EAN)).toEqual({
      kind: "vara",
      catalogItemId: "mjolk",
      name: "mjölk",
    });
  });

  it("calls a barcode it has never seen unknown", () => {
    expect(resolveScan(placed(), "0000000000000")).toEqual({ kind: "unknown" });
  });

  it("asks when the product has no vara yet", () => {
    const state = placed();
    state.products[PROD].catalogItemId = null;
    expect(resolveScan(state, EAN)).toEqual({ kind: "unplaced", productId: PROD });
  });

  /**
   * The phantom purchase, closed.
   *
   * `handleScan` used to read `state.catalog[id]`, fall back to the name
   * "Varan" when it was missing, and remove-with-purchase anyway — so a barcode
   * pointing at a vara that had since been merged away recorded a purchase
   * against a tombstone. A merge re-points the products it can see and a delete
   * is refused while any product hangs off the word, so reaching this needs a
   * product mapped from another device mid-merge; narrow, and it is the same
   * shape as the bug that did reach production.
   */
  it("refuses to name a vara that has been merged or deleted away", () => {
    const state = placed();
    delete state.catalog["mjolk"];
    expect(resolveScan(state, EAN)).toEqual({ kind: "unplaced", productId: PROD });
  });

  /**
   * A dangling link heals rather than strands the barcode: the id a repair
   * would mint is the one the link already names, because scan-born ids are
   * derived from the EAN.
   */
  it("treats a link whose product is gone as a first sighting", () => {
    const state = placed();
    delete state.products[PROD];
    expect(resolveScan(state, EAN)).toEqual({ kind: "unknown" });
  });

  it("never reaches the network", () => {
    // The whole point: this is the tier that works in a basement. If it ever
    // grows an await, the scan stops working exactly where it is needed.
    expect(resolveScan).toHaveLength(2);
    expect(resolveScan(placed(), EAN)).not.toBeInstanceOf(Promise);
  });
});
