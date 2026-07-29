/**
 * EAN/UPC checksum validation and normalization.
 *
 * Pure module -- no DOM, no network, no database. See
 * docs/superpowers/specs/2026-07-29-recipus-design.md §5.5 for where this
 * fits: the first, cheapest step of the barcode resolution chain (local map
 * -> server map -> Open Food Facts -> ask the user).
 */

export type EanKind = "EAN13" | "EAN8" | "UPCA" | "UNKNOWN";

const DIGITS_ONLY = /^\d+$/;

function toDigits(code: string): number[] {
  return code.split("").map((c) => Number(c));
}

/**
 * Shared GS1 check-digit algorithm: alternating weights over every digit but
 * the last, compared against the last digit.
 *
 * - EAN-13 (and UPC-A zero-padded to 13): weights 1,3,1,3,... over digits
 *   1..12.
 * - EAN-8 and UPC-A (12 digits, unpadded): weights 3,1,3,1,... over the body.
 *   Zero-padding a UPC-A to 13 and applying the EAN-13 weights gives the same
 *   result as applying 3,1,3,... directly to the 12-digit form, since the
 *   prepended 0 shifts every weight by one position.
 */
function hasValidCheckDigit(digits: number[], firstWeight: 1 | 3): boolean {
  const body = digits.slice(0, -1);
  const checkDigit = digits[digits.length - 1];

  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const weight = i % 2 === 0 ? firstWeight : 4 - firstWeight;
    sum += body[i] * weight;
  }

  const expected = (10 - (sum % 10)) % 10;
  return expected === checkDigit;
}

/** Checksum-validating classifier. Returns UNKNOWN for anything that fails. */
export function classifyBarcode(code: string): EanKind {
  if (!DIGITS_ONLY.test(code)) return "UNKNOWN";

  const digits = toDigits(code);
  switch (code.length) {
    case 13:
      return hasValidCheckDigit(digits, 1) ? "EAN13" : "UNKNOWN";
    case 12:
      return hasValidCheckDigit(digits, 3) ? "UPCA" : "UNKNOWN";
    case 8:
      return hasValidCheckDigit(digits, 3) ? "EAN8" : "UNKNOWN";
    default:
      return "UNKNOWN";
  }
}

export function isValidBarcode(code: string): boolean {
  return classifyBarcode(code) !== "UNKNOWN";
}

/**
 * Canonical storage form. Scanners and hand-typed entries include whitespace
 * and hyphens, so those are stripped before validation. UPC-A (12 digits) is
 * then zero-padded to 13 so the same physical product never gets two rows in
 * the barcodes table.
 */
export function normalizeBarcode(code: string): string | null {
  const stripped = code.replace(/[\s-]/g, "");
  const kind = classifyBarcode(stripped);
  if (kind === "UNKNOWN") return null;
  return kind === "UPCA" ? `0${stripped}` : stripped;
}
