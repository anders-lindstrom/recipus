import { describe, expect, it } from "vitest";
import type { VoiceIngestResult } from "@/lib/services/voice-ingest";
import { speakResult } from "./speech";

/**
 * What the speaker says back, which on a device with no screen is the entire
 * user interface.
 *
 * The rule these tests exist to hold: a reply must never confirm more than
 * actually happened. A list is read in a shop, so a cheerful "added!" for
 * something that did not go on is discovered at the exact moment it cannot be
 * fixed.
 */
describe("speakResult", () => {
  const base: VoiceIngestResult = {
    listId: "hemkop",
    listName: "Hemköp",
    added: [],
    unresolved: [],
    heardNothing: false,
  };

  const added = (name: string, amount: VoiceIngestResult["added"][number]["amount"] = null) => ({
    catalogItemId: name,
    name,
    amount,
  });

  it("names one thing and the list it went on", () => {
    const out = speakResult({ ...base, added: [added("mjölk")] }, "sv");
    expect(out).toBe("La till mjölk på Hemköp.");
  });

  it("says the quantity when one was heard", () => {
    const out = speakResult(
      { ...base, added: [added("mjölk", { value: 2, unit: "l" })] },
      "sv",
    );
    expect(out).toContain("2 l mjölk");
  });

  it("joins several things the way a person would", () => {
    const out = speakResult(
      { ...base, added: [added("mjölk"), added("bröd"), added("ägg")] },
      "sv",
    );
    expect(out).toBe("La till mjölk, bröd och ägg på Hemköp.");
  });

  it("uses English joining for an English device", () => {
    const out = speakResult({ ...base, added: [added("mjölk"), added("bröd")] }, "en");
    expect(out).toBe("Added mjölk and bröd to Hemköp.");
  });

  it("keeps vara names Swedish even in the English reply", () => {
    // The name is what the screen shows in the shop. Saying "milk" back for a
    // list that reads "mjölk" names something the household will not find.
    const out = speakResult({ ...base, added: [added("mjölk")] }, "en");
    expect(out).toContain("mjölk");
    expect(out).not.toContain("milk");
  });

  it("names what it could not find, rather than counting it", () => {
    // "I added 2 of 3 things" leaves the household to work out which one is
    // missing, and they work it out in the shop.
    const out = speakResult(
      { ...base, added: [added("mjölk")], unresolved: ["quinoa flakes"] },
      "en",
    );
    expect(out).toContain("mjölk");
    expect(out).toContain("quinoa flakes");
  });

  it("never claims success when nothing matched", () => {
    const out = speakResult({ ...base, unresolved: ["schnozzberries"] }, "en");
    expect(out).not.toMatch(/^Added/);
    expect(out).toContain("schnozzberries");
  });

  it("admits it heard nothing", () => {
    const sv = speakResult({ ...base, heardNothing: true }, "sv");
    const en = speakResult({ ...base, heardNothing: true }, "en");
    expect(sv).toBe("Jag uppfattade inget att lägga till.");
    expect(en).toBe("I didn't catch anything to add.");
  });

  it("does not return an empty sentence when there is nothing to report", () => {
    // Silence from a speaker is indistinguishable from a crash.
    expect(speakResult(base, "sv").length).toBeGreaterThan(0);
    expect(speakResult(base, "en").length).toBeGreaterThan(0);
  });
});
