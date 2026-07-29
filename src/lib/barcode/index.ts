/**
 * Barcode data layer: checksum validation/normalization plus the Open Food
 * Facts lookup. See docs/superpowers/specs/2026-07-29-recipus-design.md §5.5.
 *
 * The scanner UI and the local/server EAN maps live elsewhere; this module is
 * data only.
 */

export { classifyBarcode, isValidBarcode, normalizeBarcode } from "./ean";
export type { EanKind } from "./ean";

export { lookupOpenFoodFacts } from "./openfoodfacts";
export type { OffProduct } from "./openfoodfacts";
