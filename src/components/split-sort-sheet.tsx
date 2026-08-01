"use client";

import { useState } from "react";
import { Sheet } from "./sheet";

/**
 * Naming the second kind.
 *
 * One vara appears at most once per list — the entry's id is
 * `(listId, catalogItemId)` — so "mogna blåbär" and "blåbär" cannot both be an
 * ask about the same vara. The design has always said the answer is a second
 * vara ("wanting ripe mango tracked as its own thing with its own cadence is the
 * registry's split"), and this is the step that makes one.
 *
 * Its own sheet because two flows arrive here and they should not diverge: the
 * add bar's collision question ("you already asked for the ripe ones — is this
 * one of those?") and the entry sheet's "make this sort a vara of its own",
 * which is the same decision reached at leisure rather than under a prompt.
 *
 * What it does NOT do is decide anything. It collects a name and hands it back;
 * which asks move where is the caller's business, and differs between the two —
 * the add bar leaves the plain kind on the list because that is what was just
 * asked for, the entry sheet does not because nobody asked for it.
 */

export interface SplitSortSheetProps {
  /** The vara being split from — "Blåbär". */
  baseName: string;
  /** The sort becoming a vara — "mogna". */
  modifier: string;
  /** Where it will land. It inherits the base's aisle, so this is the base's. */
  aisleName: string;
  /** What happens to the original, which differs by caller. One sentence. */
  note: string;
  onConfirm: (name: string) => void;
  onClose: () => void;
}

export function SplitSortSheet({
  baseName,
  modifier,
  aisleName,
  note,
  onConfirm,
  onClose,
}: SplitSortSheetProps) {
  /**
   * Prefilled with base + sort, in that order, and lowercased.
   *
   * "blåbär mogna" rather than "mogna blåbär" even though the second is the
   * grammatical Swedish, because inflecting an adjective to agree with a noun
   * the app knows nothing about produces "mogen blåbär" as often as it produces
   * the right answer — and the field is right there to fix it. Base first also
   * keeps the two kinds adjacent in an alphabetical list and reachable from the
   * same three letters in search.
   */
  const [draft, setDraft] = useState(
    `${baseName.toLocaleLowerCase("sv")} ${modifier}`,
  );

  const name = draft.trim();
  const ok = name.length >= 2;

  function commit() {
    if (ok) onConfirm(name);
  }

  return (
    <Sheet title="Två sorter" onClose={onClose} onPrimary={commit}>
      <div className="px-4 pb-4">
        <label
          htmlFor="split-sort-name"
          className="mb-1.5 block text-overline text-ink-faint uppercase"
        >
          Vad heter den andra sorten?
        </label>
        <input
          id="split-sort-name"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Commits rather than blurring: one field, one action, nowhere else
            // for the caret to usefully go.
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          inputMode="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          className="w-full rounded-control border border-line bg-surface px-3.5 py-3 text-body text-ink outline-none"
        />
        {/* Both halves of what is about to happen, because this is the answer
            that changes the catalog rather than just the list. Naming the aisle
            matters more than it looks: anything invented without one lands in
            Övrigt, which sorts LAST, and that is how taking the supported path
            used to put the thing at the wrong end of the shop. */}
        <p className="mt-2 text-caption text-ink-soft">
          Hamnar i {aisleName.toLowerCase()}, med samma ikon som{" "}
          {baseName.toLocaleLowerCase("sv")}. Mängden och hur bråttom följer med.{" "}
          {note}
        </p>

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-control bg-surface px-3 py-3 text-body font-semibold text-ink"
          >
            Avbryt
          </button>
          <button
            type="button"
            disabled={!ok}
            onClick={commit}
            className="flex-1 rounded-control bg-brand px-3 py-3 text-body font-semibold text-on-brand transition-transform duration-100 active:scale-[0.98] disabled:opacity-40"
          >
            Skapa
          </button>
        </div>
      </div>
    </Sheet>
  );
}
