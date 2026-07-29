import { describe, expect, it } from "vitest";
import { classifyBarcode, isValidBarcode, normalizeBarcode } from "@/lib/barcode/ean";

// All fixtures below are computed, not guessed -- checksums were derived with
// a small node one-liner applying the GS1 algorithm (EAN-13/UPC-A: weights
// 1,3,1,3,... over digits 1..12; EAN-8: weights 3,1,3,1,... over digits 1..7;
// check digit = (10 - sum%10) % 10), then cross-checked by hand for the first
// fixture. Swedish retail EAN-13s start "73", so the EAN-13 fixtures do too.
const VALID_EAN13 = "7301234567899"; // base 730123456789, check digit 9
const VALID_EAN13_B = "7398765432109"; // base 739876543210, check digit 9
const VALID_EAN8 = "12345670"; // base 1234567, check digit 0
// 036000291452 is the real UPC-A for Kellogg's Corn Flakes -- a convenient
// cross-check that the derived check digit (2) is correct.
const VALID_UPCA = "036000291452";

describe("classifyBarcode", () => {
  it("classifies a valid EAN-13", () => {
    expect(classifyBarcode(VALID_EAN13)).toBe("EAN13");
    expect(classifyBarcode(VALID_EAN13_B)).toBe("EAN13");
  });

  it("classifies a valid EAN-8", () => {
    expect(classifyBarcode(VALID_EAN8)).toBe("EAN8");
  });

  it("classifies a valid UPC-A", () => {
    expect(classifyBarcode(VALID_UPCA)).toBe("UPCA");
  });

  it("rejects an EAN-13 with a wrong check digit", () => {
    expect(classifyBarcode("7301234567890")).toBe("UNKNOWN");
  });

  it("rejects an EAN-8 with a wrong check digit", () => {
    expect(classifyBarcode("12345671")).toBe("UNKNOWN");
  });

  it("rejects a UPC-A with a wrong check digit", () => {
    expect(classifyBarcode("036000291459")).toBe("UNKNOWN");
  });

  it("rejects non-digit input", () => {
    expect(classifyBarcode("730123456789A")).toBe("UNKNOWN");
    expect(classifyBarcode("abcdefgh")).toBe("UNKNOWN");
    expect(classifyBarcode("7301-234567899")).toBe("UNKNOWN"); // hyphens rejected here
  });

  it("rejects wrong lengths, even if all-digit and checksum-plausible", () => {
    expect(classifyBarcode("1234")).toBe("UNKNOWN"); // too short
    expect(classifyBarcode("123456789")).toBe("UNKNOWN"); // 9 digits, no known kind
    expect(classifyBarcode("73012345678990")).toBe("UNKNOWN"); // 14 digits, too long
    expect(classifyBarcode("")).toBe("UNKNOWN");
  });
});

describe("isValidBarcode", () => {
  it("is true for valid codes of every kind", () => {
    expect(isValidBarcode(VALID_EAN13)).toBe(true);
    expect(isValidBarcode(VALID_EAN8)).toBe(true);
    expect(isValidBarcode(VALID_UPCA)).toBe(true);
  });

  it("is false for invalid codes", () => {
    expect(isValidBarcode("7301234567890")).toBe(false);
    expect(isValidBarcode("not-a-barcode")).toBe(false);
  });
});

describe("normalizeBarcode", () => {
  it("returns an EAN-13 unchanged", () => {
    expect(normalizeBarcode(VALID_EAN13)).toBe(VALID_EAN13);
  });

  it("returns an EAN-8 unchanged", () => {
    expect(normalizeBarcode(VALID_EAN8)).toBe(VALID_EAN8);
  });

  it("zero-pads a valid UPC-A (12 digits) to 13", () => {
    expect(normalizeBarcode(VALID_UPCA)).toBe(`0${VALID_UPCA}`);
    expect(normalizeBarcode(VALID_UPCA)).toHaveLength(13);
  });

  it("strips hyphens before validating", () => {
    expect(normalizeBarcode("730-123-456-7899")).toBe(VALID_EAN13);
  });

  it("strips whitespace before validating", () => {
    expect(normalizeBarcode("7301 2345 67899")).toBe(VALID_EAN13);
    expect(normalizeBarcode(" 7301234567899 ")).toBe(VALID_EAN13);
  });

  it("strips hyphens and whitespace from a UPC-A before padding", () => {
    expect(normalizeBarcode("036-000291-452")).toBe(`0${VALID_UPCA}`);
  });

  it("returns null for an invalid checksum", () => {
    expect(normalizeBarcode("7301234567890")).toBeNull();
  });

  it("returns null for non-digit or wrong-length input", () => {
    expect(normalizeBarcode("abc")).toBeNull();
    expect(normalizeBarcode("1234")).toBeNull();
  });
});
