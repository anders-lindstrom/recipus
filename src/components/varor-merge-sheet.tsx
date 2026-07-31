"use client";

import { useMemo, useState } from "react";
import type { CatalogItem, Id } from "@/lib/domain";
import { rankMatches } from "@/lib/services/search";
import { ItemIcon } from "./icon";
import { Sheet } from "./sheet";
import { UiIcon } from "./ui-icon";
import type { VaraView } from "./varor-model";

/**
 * Slå samman — two words for one thing, resolved into one.
 *
 * The op does exactly two things and must never do more: it tombstones the word
 * being merged away, and records that word as an alias of the survivor. It
 * deliberately does NOT rewrite entries or contributions, because a merge that
 * rewrote rows would not converge — `merge(B→A)` at T5 followed by a long-offline
 * `add_item(B)` at T7 ends with an entry for B in one arrival order and for A in
 * the other.
 *
 * The alias is the whole reason this is not destructive. Every recipe line ever
 * written against "köttfärs" keeps resolving after it is merged into "nötfärs",
 * which share no prefix, compound head or whole word — without the alias those
 * lines would go from a perfect match to nothing at all.
 *
 * Products are moved by this sheet, as ordinary `update_product` ops alongside
 * the merge, exactly as the split moves them. Leaving them on a tombstoned vara
 * would make them invisible on this screen — not in the review queue, not under
 * any word — which is a worse outcome than the duplicate the merge came to fix.
 *
 * Every consequence is stated before the choice rather than after, on the same
 * principle as the move sheet: afterwards, none of them are visible.
 */

const MAX_CANDIDATES = 12;

export interface VarorMergeSheetProps {
  /** The vara being merged AWAY. Its word survives as an alias; the row does not. */
  vara: VaraView;
  /** Every other vara. The caller has already excluded this one. */
  candidates: CatalogItem[];
  /** Names a list this vara is currently on, for the warning. Falls back to the id. */
  listName: (listId: Id) => string;
  onMerge: (toItemId: Id) => void;
  onClose: () => void;
}

export function VarorMergeSheet({
  vara,
  candidates,
  listName,
  onMerge,
  onClose,
}: VarorMergeSheetProps) {
  const [query, setQuery] = useState("");
  const name = query.trim();

  const matches = useMemo(
    () =>
      name
        ? rankMatches(candidates, name, MAX_CANDIDATES)
        : candidates
            .slice()
            .sort(
              (a, b) =>
                b.useCount - a.useCount || a.name.localeCompare(b.name, "sv"),
            )
            .slice(0, MAX_CANDIDATES),
    [candidates, name],
  );

  // Named lists rather than a count. "mjölk står på Hemköp" is something you can
  // act on; "mjölk står på 1 lista" makes you go and look.
  const lists = [...new Set(vara.onList.map((e) => listName(e.listId)))];

  return (
    <Sheet title={`Slå samman ${vara.item.name}`} onClose={onClose}>
      <div className="px-4 pb-3">
        <p className="text-body text-ink-soft">
          <span className="font-semibold text-ink">{vara.item.name}</span>{" "}
          försvinner ur listan över varor — men ordet fortsätter fungera. Recept
          och sökningar som säger {vara.item.name} hittar varan du väljer.
        </p>

        {vara.products.length > 0 && (
          <p className="mt-1.5 text-body text-ink-soft">
            {vara.products.length}{" "}
            {vara.products.length === 1 ? "produkt följer" : "produkter följer"}{" "}
            med, tillsammans med sina köp.
          </p>
        )}

        {lists.length > 0 && (
          // The one consequence that reaches out of this screen and into today's
          // shopping, so it is said in the shop's own name. Not blocked: a merge
          // is a decision about your words, and refusing it because of one tile
          // would be the taxonomy screen taking orders from the list.
          //
          // It used to say the item "försvinner därifrån", and it was telling the
          // truth about the intent and not about the code: the tile stopped being
          // drawn, but the row stayed on the list where nothing could reach it.
          // The shopping now genuinely moves across — see `mergeVaror` — so this
          // says that instead. Neutral about WHICH vara, because the target is
          // chosen from the list below this line.
          <p className="mt-1.5 flex items-start gap-1.5 text-body text-ink-soft">
            <UiIcon name="warning" size={14} className="mt-1 flex-none" />
            <span>
              {vara.item.name} står på {lists.join(" och ")} just nu. Mängden
              följer med till varan du väljer — men vilket recept den kom från
              gör det inte.
            </span>
          </p>
        )}
      </div>

      <div className="px-4">
        <div className="flex items-center gap-2.5 rounded-card border border-line bg-surface px-3 py-2.5">
          <UiIcon name="search" size={18} className="flex-none text-ink-faint" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="Slå samman med…"
            aria-label="Sök vara att slå samman med"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-faint"
          />
        </div>
      </div>

      <ul className="mx-4 mt-1 divide-y divide-line">
        {matches.map((target) => (
          <li key={target.id}>
            <button
              type="button"
              onClick={() => onMerge(target.id)}
              className="flex w-full items-center gap-3 py-3 text-left transition-transform duration-100 active:scale-[0.99]"
            >
              <ItemIcon iconRef={target.iconRef} className="text-2xl" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-semibold text-ink">
                  {target.name}
                </span>
                <span className="block text-caption text-ink-faint">
                  behåll {target.name}, ta bort {vara.item.name}
                </span>
              </span>
              <UiIcon
                name="chevronDown"
                size={16}
                className="-rotate-90 flex-none text-ink-faint"
              />
            </button>
          </li>
        ))}
      </ul>

      {matches.length === 0 && (
        <p className="px-4 py-6 text-center text-body text-ink-faint">
          Ingen annan vara heter så.
        </p>
      )}

      <div className="mt-2 border-t border-line p-3">
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-control bg-surface px-3 py-3 text-body font-semibold text-ink"
        >
          Avbryt
        </button>
      </div>
    </Sheet>
  );
}
