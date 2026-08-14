import { describe, expect, it } from "vitest";
import { dictation, type SpeechResultsLike } from "./use-speech";

/**
 * One dictation, however many times the phone reports it.
 *
 * The bug this exists for: "bröd grötbröd", said once into an Android phone,
 * arrived in the textarea as "brödbrödbrödbröd grötbröd grötbröd". Every word
 * appeared once per event that mentioned it, because the settled words were
 * ACCUMULATED across events — and `results` is the whole session every time, so
 * a result that had already gone final was counted again on each later event.
 *
 * The engines disagree about how much they repeat themselves. Desktop Chrome
 * moves `resultIndex` forward and mentions each result about once; the phone
 * re-sends the entire list, unchanged finals included, several times over. So
 * the assembly has to be idempotent: reading the same list twice must produce
 * the same sentence, not twice the sentence.
 */

/** The list an engine hands over: every result of the session so far. */
function results(
  ...spoken: [transcript: string, isFinal: boolean][]
): SpeechResultsLike {
  return spoken.map(([transcript, isFinal]) =>
    Object.assign([{ transcript }], { isFinal }),
  );
}

describe("dictation", () => {
  /**
   * The reported dictation, reproduced event for event.
   *
   * Two words, eight events: "bröd" guessed at, "bröd" settled and then sent
   * back three more times, "grötbröd" guessed at, settled, and sent back again.
   * Fed to the old accumulator this sequence produces the reported string
   * exactly — four "bröd" and two "grötbröd", one per event that mentioned
   * them — which is why it is written out here rather than summarised.
   */
  it("says each word once however often the phone repeats itself", () => {
    const say = dictation();
    const heard = [
      results(["bröd", false]),
      results(["bröd", true]),
      results(["bröd", true]),
      results(["bröd", true]),
      results(["bröd", true]),
      results(["bröd", true], [" grötbröd", false]),
      results(["bröd", true], [" grötbröd", true]),
      results(["bröd", true], [" grötbröd", true]),
    ].map((r) => say({ results: r }));

    expect(heard.at(-1)).toBe("bröd grötbröd");
    expect(new Set(heard)).toEqual(new Set(["bröd", "bröd grötbröd"]));
  });

  /**
   * The other half of what an event means: an unsettled result REPLACES its own
   * earlier guess. Appending them is what once turned a sentence into a list of
   * its own prefixes, and the accumulator that fixed it is what broke the case
   * above — so both belong in the same test file, watching each other.
   */
  it("replaces the tail it is still guessing at", () => {
    const say = dictation();
    const heard = [
      results(["två", false]),
      results(["två liter", false]),
      results(["två liter mjölk", false]),
      results(["två liter mjölk", true]),
    ].map((r) => say({ results: r }));

    expect(heard).toEqual([
      "två",
      "två liter",
      "två liter mjölk",
      "två liter mjölk",
    ]);
  });

  /** A settled sentence with a new guess growing after it. */
  it("keeps what is settled while the next words are still moving", () => {
    const say = dictation();
    const heard = [
      results(["mjölk", true], [" två", false]),
      results(["mjölk", true], [" två ägg", false]),
      results(["mjölk", true], [" två ägg", true]),
    ].map((r) => say({ results: r }));

    expect(heard).toEqual(["mjölk två", "mjölk två ägg", "mjölk två ägg"]);
  });

  /** A new dictation is a new binding, so nothing carries over from the last. */
  it("starts empty for every session", () => {
    const first = dictation();
    first({ results: results(["bröd", true]) });

    const second = dictation();
    expect(second({ results: results(["ägg", true]) })).toBe("ägg");
  });

  /** Silence reports nothing, and nothing is not a transcript. */
  it("has nothing to say before a word is heard", () => {
    const say = dictation();
    expect(say({ results: results() })).toBe("");
    expect(say({ results: results(["", false]) })).toBe("");
  });
});
