"use client";

import { useMemo, useRef, useState } from "react";
import type { CatalogItem, Id } from "@/lib/domain";
import { resolvePair, resolveQuery } from "@/lib/services/search";
import { cn, normalizeName } from "@/lib/utils";
import { ItemIcon } from "./icon";
import { ItemTile, TileGrid } from "./item-tile";
import { UiIcon } from "./ui-icon";

/**
 * The add bar.
 *
 * Typing is the fastest way onto the list for anything not already visible, so
 * this has to behave: match on three letters, accept a quantity inline, and
 * never make creating a new item feel like filling in a form.
 *
 * It scrolls away with the page rather than pinning. The header already carries
 * the list name and the aisle rail; a third pinned bar would eat a fifth of a
 * phone screen to save one flick back to the top, and the rail's "Listan"
 * button is that flick.
 *
 * It reads a query as amount + sort + vara rather than as one string to look
 * up — see `resolveQuery`. "mogen mango" used to match nothing at all, and the
 * only thing on offer was creating a second mango in Övrigt, permanently, next
 * to the one that was already there.
 *
 * Focusing it used to do nothing at all, which is a whole screen of keyboard
 * bought with nothing under it. Now it opens on the six varor this household
 * buys most, because the overwhelmingly common errand is a staple you buy every
 * week and the fastest way to type "mjölk" is not to.
 */

/**
 * How many varor the opened panel offers.
 *
 * Six, so it is two rows of the same three-column grid the rest of the app
 * uses. Three rows would put the last of them under the keyboard on a small
 * phone, which is worse than not offering them.
 */
const FREQUENT_COUNT = 6;

/**
 * The grid is a labelled group, so the heading a sighted person reads is also
 * what names it to a screen reader — and what the e2e suite reaches for, rather
 * than a class name that is one refactor from meaning nothing.
 */
const FREQUENT_HEADING_ID = "add-bar-frequent";

export interface AddBarProps {
  catalog: CatalogItem[];
  /** Items already on the current list, so they can be marked rather than re-added. */
  onListItemIds: Set<Id>;
  /**
   * `modifier` is the household's qualifier read off the front of the query —
   * "mogen" from "mogen mango". Empty when nothing led the vara's name.
   */
  onPick: (itemId: Id, amountText: string, modifier: string) => void;
  /** Both halves of "salt och peppar", in the order they were typed. */
  onPickMany: (itemIds: Id[]) => void;
  onCreate: (name: string, amountText: string) => void;
  /** Takes an item straight back off the list, recording no purchase. */
  onUndoAdd: (itemIds: Id[]) => void;
}

/**
 * Its own component only so the ids it carries stay narrowed to a real array
 * through the callback — the alternative is a non-null assertion inside a
 * closure, which is exactly where one eventually stops being true.
 */
function UndoAdd({ ids, onUndo }: { ids: Id[]; onUndo: (ids: Id[]) => void }) {
  return (
    <button
      type="button"
      onClick={() => onUndo(ids)}
      className="flex flex-none items-center gap-1 font-bold underline underline-offset-2"
    >
      <UiIcon name="undo" size={13} />
      Ångra
    </button>
  );
}

/** What the last tap put on the list, so the panel can say so. */
interface JustAdded {
  label: string;
  /**
   * What "Ångra" would remove, or null when undo is not offered.
   *
   * Null for a newly created vara: taking it off the list would leave the
   * catalog entry behind, and a half-undo that looks like a whole one is worse
   * than none. It is one tap to remove from the tile, which is honest about
   * what it does.
   */
  undo: Id[] | null;
}

export function AddBar({
  catalog,
  onListItemIds,
  onPick,
  onPickMany,
  onCreate,
  onUndoAdd,
}: AddBarProps) {
  const [raw, setRaw] = useState("");
  const [open, setOpen] = useState(false);
  const [justAdded, setJustAdded] = useState<JustAdded | null>(null);
  /**
   * The panel's varor, captured when it opened rather than derived every render.
   *
   * They must not reshuffle under a thumb that is tapping through them: an item
   * leaving the grid the instant it is added would slide the next one into the
   * space your finger is already travelling towards. So the set is frozen, and
   * the ones you add simply turn green where they stand.
   */
  const [frequent, setFrequent] = useState<CatalogItem[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const opened = useRef(false);

  const { matches, modifier, amountText, name } = useMemo(
    () => resolveQuery(catalog, raw),
    [catalog, raw],
  );
  const pair = useMemo(() => resolvePair(catalog, raw), [catalog, raw]);

  // Against the whole typed name, not the matched vara: typing "mogen mango"
  // resolves to mango, and creating "mogen mango" as its own vara has to stay
  // available for the household that genuinely wants it as one.
  const exact = matches.some((m) => m.nameNorm === normalizeName(name));
  const canCreate = name.length >= 2 && !exact && !pair;

  function openPanel() {
    // Only on a real open. Picking refocuses the input, and recomputing here
    // would defeat the freeze the moment it mattered most.
    if (opened.current) return;
    opened.current = true;
    setFrequent(
      catalog
        .filter((c) => c.useCount > 0 && !onListItemIds.has(c.id))
        // `useCount` counts shops, not taps — it is incremented by a purchase
        // and nothing else — so this really is "what you buy", not "what you
        // last fiddled with". A household with no shops behind it has no
        // answer here, and the panel stays shut rather than offering the
        // alphabet.
        .sort(
          (a, b) =>
            b.useCount - a.useCount || a.name.localeCompare(b.name, "sv"),
        )
        .slice(0, FREQUENT_COUNT),
    );
    setOpen(true);
  }

  function closePanel() {
    opened.current = false;
    setOpen(false);
    setJustAdded(null);
  }

  /**
   * Put the caret back in the field.
   *
   * Adding six things is one errand, not six. The suggestion row that took the
   * tap unmounts on the same frame, so without this focus falls to <body> and
   * the phone keyboard animates shut and open again between every single vara.
   * `keepFocus` on the buttons stops the blur from happening at all; this is
   * what recovers it on the platforms where preventing mousedown is not enough.
   */
  function reset(added: JustAdded | null) {
    setRaw("");
    setJustAdded(added);
    input.current?.focus();
  }

  function pick(item: CatalogItem) {
    const wasOnList = onListItemIds.has(item.id);
    onPick(item.id, amountText, modifier);
    reset({
      label: modifier ? `${item.name}, ${modifier}` : item.name,
      // Undo has to mean "put it back as it was". If the vara was already on
      // the list, this tap changed an amount or a sort rather than adding
      // anything, and removing it would delete something that was there first.
      undo: wasOnList ? null : [item.id],
    });
  }

  function pickPair([first, second]: [CatalogItem, CatalogItem]) {
    const fresh = [first, second].filter((i) => !onListItemIds.has(i.id));
    onPickMany([first.id, second.id]);
    reset({
      label: `${first.name} och ${second.name}`,
      undo: fresh.length > 0 ? fresh.map((i) => i.id) : null,
    });
  }

  function create() {
    onCreate(name, amountText);
    reset({ label: `${name} — ny vara`, undo: null });
  }

  /**
   * A press anywhere inside the panel must never take focus off the input.
   *
   * On the panel rather than on each control, and that is not tidiness. Blur
   * closes the panel, so a press that blurs first unmounts the very thing it
   * was aimed at and the click lands on nothing — the tap simply does not
   * happen. The frequent grid is built from `ItemTile`, which has no reason to
   * know about any of this and takes no mouse-event props, so per-control
   * handlers could not have covered it anyway. One handler on the container
   * covers everything inside it, including whatever gets added next.
   *
   * `mousedown`'s default action is the focus change itself, and preventing it
   * on the way up the tree is enough. The click still fires.
   */
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  const typing = name.length >= 1;
  const showSuggestions = typing && (matches.length > 0 || canCreate || pair);
  const showFrequent = open && !typing && frequent.length > 0;
  const showPanel = showSuggestions || showFrequent || (open && justAdded);

  return (
    <div className="relative my-3">
      <div className="flex items-center gap-2.5 rounded-card border border-line bg-surface-raised px-3 py-2.5">
        <UiIcon name="search" size={18} className="flex-none text-ink-faint" />
        <input
          ref={input}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setJustAdded(null);
          }}
          onFocus={openPanel}
          onBlur={closePanel}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              // Empty already: the second press is a request to get out, not to
              // clear something that is not there.
              if (raw) reset(null);
              else input.current?.blur();
              return;
            }
            if (e.key !== "Enter") return;
            // Enter takes the top match, or creates when nothing matched. The
            // whole point is never having to reach for the mouse mid-sentence.
            if (pair) pickPair(pair);
            else if (matches.length > 0) pick(matches[0]);
            else if (canCreate) create();
          }}
          placeholder="Lägg till vara…"
          aria-label="Sök eller lägg till vara"
          enterKeyHint="done"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-faint"
        />
        {amountText && (
          <span className="flex-none rounded-full bg-brand-tint px-2 py-0.5 text-caption font-bold text-brand-ink">
            {amountText}
          </span>
        )}
        {raw && (
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => reset(null)}
            aria-label="Rensa"
            className="-mr-1 flex h-7 w-7 flex-none items-center justify-center rounded-full text-ink-faint"
          >
            <UiIcon name="clear" size={16} />
          </button>
        )}
      </div>

      {showPanel && (
        <div
          onMouseDown={keepFocus}
          className="absolute inset-x-0 top-full z-30 mt-1.5 overflow-hidden rounded-card border border-line bg-surface-raised shadow-xl shadow-black/10"
        >
          {/* The tile lands behind the keyboard, and keeping focus made that
              worse rather than better: you type on with no idea whether the
              last one took. This says so without a toast, and without leaving
              the field. */}
          {justAdded && (
            <div className="flex items-center gap-2 border-b border-line bg-brand-tint px-3 py-2 text-caption text-brand-ink">
              <UiIcon name="check" size={14} className="flex-none" />
              <span className="min-w-0 flex-1 truncate font-semibold">
                {justAdded.label} tillagd
              </span>
              {justAdded.undo !== null && (
                <UndoAdd
                  ids={justAdded.undo}
                  onUndo={(ids) => {
                    onUndoAdd(ids);
                    setJustAdded(null);
                    input.current?.focus();
                  }}
                />
              )}
            </div>
          )}

          {showFrequent && (
            <div
              role="group"
              aria-labelledby={FREQUENT_HEADING_ID}
              className="px-3 pt-2.5 pb-3"
            >
              <h3
                id={FREQUENT_HEADING_ID}
                className="mb-2 text-overline text-ink-faint uppercase"
              >
                Vanligast
              </h3>
              <TileGrid>
                {frequent.map((item) => {
                  const already = onListItemIds.has(item.id);
                  return (
                    <ItemTile
                      key={item.id}
                      name={item.name}
                      iconRef={item.iconRef}
                      onList={already}
                      // Inert once it is on the list, rather than removing.
                      // Green means one thing in this app and it means it here
                      // too, but a tap that took something OFF the list would
                      // record a purchase in buy mode — from inside the panel
                      // whose entire job is putting things on.
                      onTap={() => {
                        if (already) return;
                        pick(item);
                      }}
                    />
                  );
                })}
              </TileGrid>
            </div>
          )}

          {showSuggestions && (
            <ul>
              {pair && (
                <li>
                  <button
                    type="button"
                      onClick={() => pickPair(pair)}
                    className="flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-left active:bg-brand-tint"
                  >
                    <span className="flex flex-none -space-x-1.5">
                      {pair.map((item) => (
                        <ItemIcon
                          key={item.id}
                          iconRef={item.iconRef}
                          className="text-xl"
                        />
                      ))}
                    </span>
                    <span className="flex-1 text-body font-semibold text-ink">
                      {pair[0].name} och {pair[1].name}
                    </span>
                    <span className="flex-none text-caption font-semibold text-brand">
                      2 varor
                    </span>
                  </button>
                </li>
              )}

              {matches.map((item) => {
                const already = onListItemIds.has(item.id);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                          onClick={() => pick(item)}
                      className={cn(
                        "flex w-full items-center gap-3 px-3 py-2.5 text-left",
                        "border-b border-line last:border-b-0 active:bg-brand-tint",
                      )}
                    >
                      <ItemIcon iconRef={item.iconRef} className="text-xl" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-body font-semibold text-ink">
                          {item.name}
                        </span>
                        {/* Rendered exactly as the tile will render it —
                            italic, under the name — so what you are about to
                            get is what you are looking at. */}
                        {modifier && (
                          <span className="text-caption text-ink-faint italic">
                            {modifier}
                          </span>
                        )}
                      </span>
                      {already && (
                        <span className="flex-none text-caption font-semibold text-brand">
                          på listan
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
                      onClick={create}
                    className="flex w-full items-center gap-3 border-t border-line px-3 py-2.5 text-left active:bg-brand-tint"
                  >
                    <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-brand text-on-brand">
                      <UiIcon name="plus" size={13} />
                    </span>
                    <span className="flex-1 text-body text-ink-soft">
                      Lägg till{" "}
                      <span className="font-bold text-ink">
                        &ldquo;{name}&rdquo;
                      </span>
                    </span>
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
