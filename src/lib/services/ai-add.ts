/**
 * The whole AI-add read path, in one function.
 *
 * Reads. Never writes. That separation is the difference between this and
 * `voice-ingest.ts` next door, and it is not incidental: the voice path answers
 * a person with no screen, so it must decide AND act, while this one answers a
 * dialog that is about to show its work. Nothing here may put a vara on a list.
 */

import type { AiRow } from "@/lib/ai-add";
import { buildRows, parseInput } from "@/lib/ai-add";
import { interpretUtterance } from "@/lib/voice/interpret";
import { loadMatchCandidates } from "./match-candidates";

export type AiAddInput =
  | { kind: "text"; text: string }
  | { kind: "image"; data: string; mediaType: string };

export interface AiAddResult {
  rows: AiRow[];
  /**
   * False when the model was unavailable and text was read deterministically.
   * The dialog says so, rather than letting a person wonder why "grejer till
   * tacos" produced nothing.
   */
  usedModel: boolean;
}

export async function parseForList(input: AiAddInput): Promise<AiAddResult> {
  const lines = await parseInput(input);
  const candidates = await loadMatchCandidates();

  if (lines) return { rows: buildRows(lines, candidates), usedModel: true };

  /*
   * The model could not help. For text there is still a real answer: the
   * deterministic parser that has been putting "ägg, mjölk och keso" on this
   * household's list from Home Assistant for months. It reads a comma-separated
   * sentence perfectly well and only loses the loose phrasing a model would
   * have tidied.
   *
   * `interpretUtterance` splits on its own, so the raw text goes in as ONE
   * line rather than being pre-split here — two splitters would disagree about
   * "salt och peppar" eventually.
   */
  if (input.kind === "text") {
    const rows = buildRows(
      interpretUtterance(input.text).map((spoken) => ({
        text: spoken.said,
        group: "list" as const,
      })),
      candidates,
    );
    return { rows, usedModel: false };
  }

  // An image without a model is simply unreadable. The route turns this into a
  // 503 with a sentence that says which knob is missing.
  return { rows: [], usedModel: false };
}
