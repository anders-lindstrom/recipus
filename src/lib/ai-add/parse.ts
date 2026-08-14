/**
 * The AI front door: messy input, clean Swedish lines out.
 *
 * Deliberately the least clever part of this feature. The model is not asked
 * which vara a word means — `matchIngredient` against `loadMatchCandidates()`
 * answers that, and it is the same matcher the add bar, the recipe importer and
 * the voice path already use. Handing the model 341 varor and asking for ids
 * would put a second reading of "which vara is this" in the codebase, and the
 * codebase's whole sync story rests on there being one of everything.
 *
 * Shaped like `src/lib/recipes/llm.ts` on purpose, including the rule that
 * matters most: nothing here throws. Every failure — the shim not configured,
 * a dead network, a non-2xx answer, output that does not fit the schema —
 * comes back as `null`, and the caller decides what to do about it. For text
 * there is a real answer (the deterministic voice parser); for an image there
 * is not.
 */

import { z } from "zod";

/** A pasted clump is a shopping list, not a novel. Caps request cost. */
const MAX_TEXT_CHARS = 8_000;

/** How long to wait on the home server before giving up and degrading. */
const SHIM_TIMEOUT_MS = 60_000;

/** Where on the input a line was read. See the spec, §2.1. */
export type LineGroup = "list" | "other";

export interface ParsedLine {
  /** One thing, in Swedish, with any quantity left in place: "2 l mjölk". */
  text: string;
  group: LineGroup;
}

export type AiInput =
  | { kind: "text"; text: string }
  | { kind: "image"; data: string; mediaType: string };

const LinesSchema = z.object({
  lines: z.array(
    z.object({
      text: z.string(),
      group: z.enum(["list", "other"]),
    }),
  ),
});

/**
 * Read whatever came in as the things it names.
 *
 * `null` means "the model could not help", which is a different answer from an
 * empty array ("the model looked and there was nothing there") — the caller
 * shows a different message for each, and conflating them is how a person ends
 * up retrying a request that will never work.
 */
export async function parseInput(input: AiInput): Promise<ParsedLine[] | null> {
  const base = process.env.AI_SHIM_URL;
  const secret = process.env.AI_SHIM_SECRET;
  if (!base || !secret) return null;

  const body =
    input.kind === "text"
      ? { kind: "text", text: input.text.slice(0, MAX_TEXT_CHARS) }
      : input;

  let payload: unknown;
  try {
    const res = await fetch(`${shimBase(base)}/parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SHIM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    payload = await res.json();
  } catch {
    return null;
  }

  // The shim is ours, which is exactly why its answer gets no special trust:
  // a contract asserted on one side only is a contract that drifts silently.
  // Its schema lives in a different repository with a different test suite,
  // and nothing stops the two from diverging except a check like this one.
  const parsed = LinesSchema.safeParse(payload);
  if (!parsed.success) return null;

  return parsed.data.lines
    .map((line) => ({ text: line.text.trim(), group: line.group }))
    .filter((line) => line.text.length > 0);
}

/**
 * A trailing slash in `AI_SHIM_URL` is an ordinary thing to type. Left in, it
 * makes `//parse`, which is a 404, which is a `null` — a config typo that
 * presents as a permanently unhelpful model and looks exactly like a real
 * model failure. Same guard in `src/lib/recipes/llm.ts`.
 */
function shimBase(base: string): string {
  return base.replace(/\/+$/, "");
}
