"use client";

import { useMemo, useState } from "react";
import type { CatalogItem, Id, Product } from "@/lib/domain";
import { rankMatches } from "@/lib/services/search";
import { normalizeName } from "@/lib/utils";
import { ItemIcon } from "./icon";
import { Sheet } from "./sheet";
import { UiIcon } from "./ui-icon";
import { productSubtitle } from "./varor-model";

/**
 * Saying which of the household's words a product belongs under.
 *
 * This is the single most valuable action on the registry screen, so it is one
 * tap and no confirmation: a scanned product's purchases do not count towards
 * cadence or statistics until somebody answers this question, and a queue that
 * costs three taps per item is a queue that stays full.
 *
 * It is also deliberately re-openable for a product that already has a vara. An
 * auto-mapped product is a *guess* — the threshold that produces them was set at
 * 0.8 precisely because 0.7 mapped "Kaffe Gevalia Mellanrost" onto ost — and the
 * person standing here is the one who can correct it. A one-way placement would
 * make the guess permanent.
 */

/** How many varor to offer before anyone has typed anything. */
const RESTING_SUGGESTIONS = 8;

export interface VarorPlaceSheetProps {
  product: Product;
  /** Every vara, for search. */
  catalog: CatalogItem[];
  /** Where the product sits now, when this is a correction rather than a first placement. */
  current: CatalogItem | null;
  onPlace: (catalogItemId: Id) => void;
  /** Creates a brand new vara and places the product on it, in that order. */
  onCreateAndPlace: (name: string) => void;
  /** Sends the product back to the queue. Offered only when it has a vara to leave. */
  onUnplace: () => void;
  onClose: () => void;
}

export function VarorPlaceSheet({
  product,
  catalog,
  current,
  onPlace,
  onCreateAndPlace,
  onUnplace,
  onClose,
}: VarorPlaceSheetProps) {
  const [query, setQuery] = useState("");
  const name = query.trim();

  /**
   * Before anything is typed, the household's most-used words.
   *
   * An empty list under a search box is a dead end, and the answer is very often
   * one of the eight things this household buys constantly — a scanned milk
   * carton belongs under "mjölk" far more often than under anything you would
   * have to go looking for.
   */
  const resting = useMemo(
    () =>
      catalog
        .slice()
        .sort(
          (a, b) =>
            b.useCount - a.useCount || a.name.localeCompare(b.name, "sv"),
        )
        .slice(0, RESTING_SUGGESTIONS),
    [catalog],
  );

  // The add bar's ranking, so "mj" reaches mjölk here exactly as it does there.
  // The limit is raised because this sheet has the room and a wrong placement is
  // more expensive to discover than a wrong search suggestion.
  const matches = useMemo(
    () => (name ? rankMatches(catalog, name, 12) : resting),
    [catalog, name, resting],
  );

  const exact = matches.some((m) => m.nameNorm === normalizeName(name));
  const canCreate = name.length >= 2 && !exact;
  const subtitle = productSubtitle(product);

  return (
    <Sheet title={product.name} onClose={onClose}>
      <div className="px-4 pb-3">
        {subtitle && <p className="text-body text-ink-soft">{subtitle}</p>}
        <p className="mt-1 text-body-sm text-ink-faint">
          {current
            ? `Ligger under ${current.name}. Välj en annan vara för att flytta den.`
            : "Vilken av era varor är det här?"}
        </p>
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
              if (e.key !== "Enter") return;
              if (matches.length > 0) onPlace(matches[0].id);
              else if (canCreate) onCreateAndPlace(name);
            }}
            placeholder="Sök vara…"
            aria-label="Sök vara"
            enterKeyHint="done"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-faint"
          />
        </div>
      </div>

      {!name && (
        <p className="mt-3 px-4 text-overline text-ink-faint uppercase">
          Vanligast
        </p>
      )}

      <ul className="mx-4 mt-1 divide-y divide-line">
        {matches.map((vara) => {
          const isCurrent = vara.id === current?.id;
          return (
            <li key={vara.id}>
              <button
                type="button"
                onClick={() => onPlace(vara.id)}
                className="flex w-full items-center gap-3 py-3 text-left transition-transform duration-100 active:scale-[0.99]"
              >
                <ItemIcon iconRef={vara.iconRef} className="text-2xl" />
                <span className="flex-1 text-body font-semibold text-ink">
                  {vara.name}
                </span>
                {/* Marked rather than hidden: seeing where it sits now is what
                    makes "flytta den hit i stället" a decision instead of a
                    guess. Green, because this is the only meaning green has. */}
                {isCurrent && (
                  <span className="flex items-center gap-1 text-caption font-semibold text-brand-ink">
                    <UiIcon name="check" size={14} />
                    Nu
                  </span>
                )}
              </button>
            </li>
          );
        })}

        {canCreate && (
          <li>
            <button
              type="button"
              onClick={() => onCreateAndPlace(name)}
              className="flex w-full items-center gap-3 py-3 text-left"
            >
              <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-brand text-on-brand">
                <UiIcon name="plus" size={14} />
              </span>
              <span className="flex-1 text-body text-ink-soft">
                Skapa varan{" "}
                <span className="font-bold text-ink">&ldquo;{name}&rdquo;</span>
              </span>
            </button>
          </li>
        )}
      </ul>

      {name && matches.length === 0 && !canCreate && (
        <p className="px-4 py-6 text-center text-body text-ink-faint">
          Ingen vara heter så.
        </p>
      )}

      <div className="mt-2 flex flex-col gap-2 border-t border-line p-3">
        {/* Only offered when there is a placement to undo. Stacked and tinted
            rather than sitting beside the neutral action, because it is the one
            here that takes purchases back out of the statistics. */}
        {current && (
          <button
            type="button"
            onClick={onUnplace}
            className="flex w-full items-center justify-center gap-2 rounded-control bg-danger-tint px-3 py-3 text-body font-semibold text-danger"
          >
            <UiIcon name="undo" size={16} />
            Ta bort från {current.name}
          </button>
        )}
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
