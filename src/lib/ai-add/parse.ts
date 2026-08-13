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
 * matters most: nothing here throws. Every failure — no key, a refusal, a dead
 * network, output that does not fit the schema — comes back as `null`, and the
 * caller decides what to do about it. For text there is a real answer (the
 * deterministic voice parser); for an image there is not.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export const AI_ADD_MODEL = "claude-opus-5";
const MAX_TOKENS = 4000;
/** A pasted clump is a shopping list, not a novel. Caps prompt cost. */
const MAX_TEXT_CHARS = 8_000;

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

const SYSTEM_PROMPT = `Du läser en inköpslista och plockar ut sakerna som ska köpas.

Regler:
- Ett element per sak. Slå aldrig ihop två varor på en rad.
- Skriv raden på svenska, med mängden kvar i texten ("2 l mjölk", "3 st ägg").
  Saknas mängd, skriv bara varan.
- Behåll hushållets egna ord. Översätt inte, förfina inte, byt inte ut ett
  märkesnamn mot en generisk vara.
- group är "list" för rader som står på själva listan.
- group är "other" för allt annat du kan läsa: förslagsrutnät ("senast
  använda"), gråmarkerade rader, redan avbockade rader, och reklam.
- Hitta aldrig på varor. Står det ingenting läsbart, svara med en tom lista.
- Skalstreck, rubriker, klockslag, sidnummer och appens egna knappar är inte
  varor.`;

/**
 * Read whatever came in as the things it names.
 *
 * `null` means "the model could not help", which is a different answer from an
 * empty array ("the model looked and there was nothing there") — the caller
 * shows a different message for each, and conflating them is how a person ends
 * up retrying a request that will never work.
 */
export async function parseInput(input: AiInput): Promise<ParsedLine[] | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const client = new Anthropic();
  const content =
    input.kind === "text"
      ? [{ type: "text" as const, text: input.text.slice(0, MAX_TEXT_CHARS) }]
      : [
          {
            type: "image" as const,
            source: {
              type: "base64" as const,
              // The SDK narrows media_type to its known image types; the
              // caller is trusted to pass one (the add bar only ever offers
              // a camera/gallery picker, which yields one of these).
              media_type: input.mediaType as Anthropic.Base64ImageSource["media_type"],
              data: input.data,
            },
          },
        ];

  let response;
  try {
    response = await client.messages.parse({
      model: AI_ADD_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
      output_config: { format: zodOutputFormat(LinesSchema) },
    });
  } catch {
    return null;
  }

  // Checked before parsed_output is read: a refusal can still carry a
  // meaningless parsed_output, exactly as recipes/llm.ts documents.
  if (response.stop_reason === "refusal") return null;

  const parsed = response.parsed_output;
  if (!parsed) return null;

  return parsed.lines
    .map((line) => ({ text: line.text.trim(), group: line.group }))
    .filter((line) => line.text.length > 0);
}
