import { describe, expect, it } from "vitest";
import { hear, type SpeechResultsLike } from "./use-speech";

/**
 * Reading one event, which is now the whole of the reading rule.
 *
 * The rule is: the last result IS the sentence. Not the sum of the results, not
 * the newest fragment appended to what came before — the last one, whole,
 * replacing whatever was shown a moment ago.
 *
 * That rule exists because the engines cannot be made to agree on any other.
 * Saying "A B C D E" into a phone produces five settled results reading "A",
 * "A B", "A B C", "A B C D", "A B C D E" — each one the entire sentence so far,
 * restated at a new index. A desktop produces one result reading "A B C D E".
 * Both are answered correctly by taking the last and nothing else, and any rule
 * that adds results together is wrong on the phone by construction.
 */

/** The list an engine hands over: every result of the session so far. */
function results(
  ...spoken: [transcript: string, isFinal: boolean][]
): SpeechResultsLike {
  return spoken.map(([transcript, isFinal]) =>
    Object.assign([{ transcript }], { isFinal }),
  );
}

describe("hear", () => {
  /**
   * The reported dictation, event for event. Five results, each restating the
   * whole sentence — the shape that produced "massvismassvis med gröt" when the
   * results were added together.
   */
  it("takes the whole sentence from a phone that restates it", () => {
    const stream = [
      results(["A", true]),
      results(["A", true], ["A B", true]),
      results(["A", true], ["A B", true], ["A B C", true]),
      results(["A", true], ["A B", true], ["A B C", true], ["A B C D", true]),
      results(
        ["A", true],
        ["A B", true],
        ["A B C", true],
        ["A B C D", true],
        ["A B C D E", true],
      ),
    ];

    expect(stream.map((r) => hear({ results: r }))).toEqual([
      "A",
      "A B",
      "A B C",
      "A B C D",
      "A B C D E",
    ]);
  });

  /** A desktop settles the same sentence once, and is read the same way. */
  it("takes the whole sentence from a desktop that states it once", () => {
    expect(hear({ results: results(["A B C D E", true]) })).toBe("A B C D E");
  });

  /** The tail still being guessed at replaces its own earlier guess. */
  it("replaces the guess rather than growing it", () => {
    const stream = [
      results(["två", false]),
      results(["två liter", false]),
      results(["två liter mjölk", false]),
    ];

    expect(stream.map((r) => hear({ results: r }))).toEqual([
      "två",
      "två liter",
      "två liter mjölk",
    ]);
  });

  /**
   * A sentence is not finished because a result says it is.
   *
   * On the phone above, every one of those five results is final — so `isFinal`
   * cannot mean "keep this now". What finishes a sentence is the session
   * ending, which is the hook's business and not this function's. Both readings
   * below are the same sentence, and this says so.
   */
  it("reads a settled and an unsettled sentence the same way", () => {
    expect(hear({ results: results(["mjölk", false]) })).toBe("mjölk");
    expect(hear({ results: results(["mjölk", true]) })).toBe("mjölk");
  });

  /** A fresh guess after a settled result is still the last result. */
  it("follows the last result even when an earlier one settled", () => {
    expect(
      hear({ results: results(["mjölk", true], ["mjölk och bröd", false]) }),
    ).toBe("mjölk och bröd");
  });

  /** Silence reads as nothing, and nothing is never committed. */
  it("has nothing to say before a word is heard", () => {
    expect(hear({ results: results() })).toBe("");
    expect(hear({ results: results(["   ", true]) })).toBe("");
  });
});
