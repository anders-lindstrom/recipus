import { describe, expect, it } from "vitest";
import { codepointToEmoji, emojiToCodepoint } from "./utils";

/**
 * The inverse of `codepointToEmoji`, for the icon picker.
 *
 * Icons are stored as codepoint refs ("1F35E") because that is what the OpenMoji
 * sprite is keyed by — but nobody types a codepoint. The picker takes whatever
 * the emoji keyboard produces and converts it, so the storage format never
 * reaches the person choosing.
 */
describe("emojiToCodepoint", () => {
  it("converts a single emoji", () => {
    expect(emojiToCodepoint("🍞")).toBe("1F35E");
    expect(emojiToCodepoint("🥛")).toBe("1F95B");
  });

  it("round-trips with codepointToEmoji", () => {
    // The two directions have to agree or a picked icon renders as something
    // else — and the sprite lookup would silently miss and fall back.
    for (const emoji of ["🍞", "🥛", "🍎", "📦"]) {
      expect(codepointToEmoji(emojiToCodepoint(emoji)!)).toBe(emoji);
    }
  });

  /**
   * Multi-codepoint emoji — a ZWJ sequence like 👨‍🍳 — keep every codepoint,
   * joined the way the sprite names its files. Taking only the first would store
   * a different emoji than the one that was picked.
   */
  it("keeps every codepoint of a joined sequence", () => {
    const ref = emojiToCodepoint("👨‍🍳");
    expect(ref).toBe("1F468-200D-1F373");
    expect(codepointToEmoji(ref!)).toBe("👨‍🍳");
  });

  it("refuses anything that is not an emoji", () => {
    // The input is a free-text field, so "bröd" and "" both arrive here. Storing
    // either would render as a missing sprite rather than as an error.
    expect(emojiToCodepoint("")).toBeNull();
    expect(emojiToCodepoint("bröd")).toBeNull();
    expect(emojiToCodepoint("a")).toBeNull();
  });
});
