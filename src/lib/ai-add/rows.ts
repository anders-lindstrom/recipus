/**
 * Model lines → rows the dialog can draw.
 *
 * Pure, and it borrows the entire voice engine rather than reimplementing any
 * of it. Each line goes through `interpretUtterance`, which is what makes "2 l"
 * mean here exactly what it means in the add bar, splits "salt och peppar" into
 * two varor, and peels off a carrier phrase the model left in ("lägg till ägg").
 * Then `resolveSpokenItems` matches against the alias-expanded candidate list —
 * the only matcher that consults aliases, and therefore the only one through
 * which an English word can reach a Swedish katalog.
 *
 * The one thing this adds on top is the group, which the voice path has no
 * notion of because a speaker cannot point at a suggestion grid.
 */

import type { Amount, Id } from "@/lib/domain";
import type { MatchCandidate } from "@/lib/ingredients";
import { normalizeName } from "@/lib/utils";
import { interpretUtterance } from "@/lib/voice/interpret";
import { resolveSpokenItems } from "@/lib/voice/resolve";
import type { LineGroup, ParsedLine } from "./parse";

export interface AiRow {
  /** Stable within one parse, so React keys and the ticked set can use it. */
  id: string;
  /** The words as they were read, kept for showing back what failed. */
  said: string;
  /** The name with any quantity peeled off. */
  name: string;
  amount: Amount | null;
  /** null means no vara answered to this — the dialog offers to create one. */
  catalogItemId: Id | null;
  group: LineGroup;
}

export function buildRows(
  lines: readonly ParsedLine[],
  candidates: MatchCandidate[],
): AiRow[] {
  const rows: AiRow[] = [];
  /*
   * Two indexes, because a row is deduped by whichever key it has.
   *
   * `dedupeResolutions` in the voice path folds matched rows by vara and
   * deliberately leaves unknowns alone — right there, where an unknown is only
   * ever read aloud. Here an unknown is an offer to CREATE a vara, so two
   * spellings of one unmatched word would create the same thing twice, or
   * present the person with the same decision twice. Normalized names, so
   * "Oatly iKaffe" and "oatly ikaffe" are one offer.
   */
  const byItem = new Map<Id, number>();
  const byName = new Map<string, number>();

  for (const line of lines) {
    for (const spoken of interpretUtterance(line.text)) {
      const [resolution] = resolveSpokenItems([spoken], candidates);
      if (!resolution) continue;

      const catalogItemId =
        resolution.status === "matched" ? resolution.catalogItemId : null;
      const key = catalogItemId ?? normalizeName(spoken.name);
      const index = catalogItemId ? byItem.get(catalogItemId) : byName.get(key);

      if (index !== undefined) {
        /*
         * Seen already. The first mention keeps its amount — it is the one the
         * person wrote first — but a later "list" sighting promotes the row out
         * of the suggestion grid. A vara that is both on the list and in the
         * grid below it is on the list, and must arrive ticked.
         */
        if (line.group === "list") rows[index]!.group = "list";
        continue;
      }

      const at = rows.length;
      rows.push({
        id: `r${at}`,
        said: spoken.said,
        name: spoken.name,
        amount: spoken.amount,
        catalogItemId,
        group: line.group,
      });
      if (catalogItemId) byItem.set(catalogItemId, at);
      else byName.set(key, at);
    }
  }

  return rows;
}
