"use client";

import { useMemo, useRef, useState } from "react";
import type { CatalogItem, Id } from "@/lib/domain";
import { focusableWithin } from "@/lib/client/use-focus-trap";
import {
  isArrowKey,
  stepFocusWithin,
  type ArrowKey,
} from "@/lib/client/spatial-focus";
import { useLongPress } from "@/lib/client/use-long-press";
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

/** Named so the field can point `aria-controls` at the choices it opens. */
const LISTBOX_ID = "add-bar-matches";

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
  /**
   * `likeItem` is the vara the query resolved to, when it resolved to one —
   * banan, for "mogen banan". The new vara inherits its aisle and icon, so
   * keeping a kind of your own does not cost you a trip to Övrigt.
   */
  onCreate: (name: string, amountText: string, likeItem?: CatalogItem) => void;
  /** Takes an item straight back off the list, recording no purchase. */
  onUndoAdd: (itemIds: Id[]) => void;
  /**
   * Hold a vara in the panel to give it details before it goes on. Same gesture
   * and same sheet as the catalog well, because a grid of varor should behave
   * like a grid of varor wherever it is drawn.
   *
   * It reaches the SEARCH RESULTS as well as the frequent grid now, and that was
   * the gap: holding a tile in "Vanligast" opened the details sheet, holding a
   * row two pixels below it did nothing at all. So the one errand that needs the
   * sheet most — "broccoli is already on the list and I want the frozen ones
   * too", which is only reachable by typing, since anything on the list is
   * filtered out of the well and the frequent grid — was the one errand with no
   * way in.
   */
  onLongPressItem: (itemId: Id) => void;
  /** Puts a hidden vara back in search. Called when one is picked. */
  onUnhide: (itemId: Id) => void;
  /** Aisle names by id, so the create row can say where the vara will land. */
  categoryNames: Map<Id, string>;
}

/**
 * One search result.
 *
 * Its own component purely so it can hold a long-press timer — hooks cannot live
 * in the `.map()` that draws these, and the gesture needs per-row state.
 */
function MatchRow({
  item,
  modifier,
  already,
  onPick,
  onLongPress,
}: {
  item: CatalogItem;
  modifier: string;
  already: boolean;
  onPick: () => void;
  onLongPress: () => void;
}) {
  const { handlers, holding } = useLongPress(onPick, onLongPress);
  return (
    <li role="presentation">
      <button
        type="button"
        /**
         * The row IS the choice, so it carries the option role rather than
         * sitting inside one; `presentation` on the `li` above keeps the listbox
         * owning its options across the list markup.
         *
         * This cost the row its `aria-haspopup="dialog"`, which ARIA does not
         * define on an option — an attribute a role does not support is not a
         * quieter claim, it is an ignored one. Taken deliberately: the claim it
         * made was about a long-press, which a screen-reader user reaches with
         * Shift+F10 whether or not it is advertised, whereas without the listbox
         * these rows were announced as six unheralded buttons and could not be
         * reached from the keyboard at all. The tile in "Vanligast" is not an
         * option and keeps its `longPressOpensDialog` claim untouched.
         */
        role="option"
        aria-selected={false}
        className={cn(
          "flex w-full items-center gap-3 px-3 py-2.5 text-left",
          "border-b border-line last:border-b-0",
          holding ? "bg-brand-tint" : "active:bg-brand-tint",
        )}
        {...handlers}
      >
        <ItemIcon iconRef={item.iconRef} className="text-xl" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-body font-semibold text-ink">{item.name}</span>
          {/* Rendered exactly as the tile will render it — italic, under the
              name — so what you are about to get is what you are looking at. */}
          {modifier && (
            <span className="text-caption text-ink-faint italic">
              {modifier}
            </span>
          )}
        </span>
        {/* Only one of the two ever shows: a hidden vara is by construction not
            on the list, since going on the list is what brings it back. */}
        {item.hidden ? (
          <span className="flex-none rounded-full bg-surface-sunken px-2 py-0.5 text-caption font-semibold text-ink-faint">
            dold
          </span>
        ) : already ? (
          <span className="flex-none text-caption font-semibold text-brand">
            på listan
          </span>
        ) : null}
      </button>
    </li>
  );
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

/**
 * What the last tap actually did, so the panel can say THAT.
 *
 * `label` is the whole sentence rather than a name with " tillagd" stapled on,
 * and that is the fix rather than a refactor. Every tap said "X tillagd",
 * including the extremely common one that added nothing at all: searching for
 * something already on the list and pressing it reported "broccoli tillagd"
 * when broccoli had been there all along. A confirmation that cannot tell you
 * apart from a no-op is worse than silence — it teaches you to stop reading it,
 * on the one strip that also carries undo.
 */
interface JustAdded {
  label: string;
  /**
   * What "Ångra" would remove, or null when undo is not offered.
   *
   * Null for a newly created vara: taking it off the list would leave the
   * catalog entry behind, and a half-undo that looks like a whole one is worse
   * than none. It is one tap to remove from the tile, which is honest about
   * what it does.
   *
   * Also null when nothing happened, which is the case the label above exists
   * for: an "Ångra" that would undo a no-op is a button that removes something
   * you did not just add.
   */
  undo: Id[] | null;
  /**
   * Say that a second kind is possible, on the one occasion it is the answer.
   *
   * Only when the tap changed nothing because the vara was already there —
   * which is exactly the moment someone wants the frozen broccoli as well as
   * the fresh, and the moment the app used to claim it had just added one.
   */
  hint?: boolean;
}

export function AddBar({
  catalog,
  onListItemIds,
  onPick,
  onPickMany,
  onCreate,
  onUndoAdd,
  onLongPressItem,
  onUnhide,
  categoryNames,
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
  /** The field and the panel together — what "focus is still in here" means. */
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

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
        // Hidden ones are excluded outright here, unlike in search: this panel
        // is an offer the app makes unprompted, and offering back something the
        // household has deliberately put away is the whole thing hiding exists
        // to stop. Typing its name still finds it — see `rankMatches`.
        .filter((c) => c.useCount > 0 && !c.hidden && !onListItemIds.has(c.id))
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
    // Reaching a hidden vara through search is the household asking for it
    // back, so it comes back. Hiding is a tidying gesture and must never be the
    // thing standing between someone and a vara they have just typed the name
    // of; the alternative is a tile that goes on the list and stays unfindable.
    const wasHidden = item.hidden;
    if (wasHidden) onUnhide(item.id);
    onPick(item.id, amountText, modifier);

    const said = [
      wasOnList ? null : "tillagd",
      wasHidden ? "visas igen" : null,
      // Named rather than implied: these are the two things a tap on something
      // already listed genuinely changes, and saying which one stops the strip
      // from reading as a lie the moment nothing else happened.
      wasOnList && amountText ? `mängd ${amountText}` : null,
      wasOnList && modifier ? `sort ${modifier}` : null,
    ].filter((s): s is string => s !== null);

    const changed = said.length > 0;
    reset({
      label: changed
        ? `${item.name} — ${said.join(", ")}`
        : `${item.name} står redan på listan`,
      // Undo has to mean "put it back as it was". If the vara was already on
      // the list, this tap changed an amount or a sort rather than adding
      // anything, and removing it would delete something that was there first.
      undo: wasOnList ? null : [item.id],
      hint: !changed,
    });
  }

  function pickPair([first, second]: [CatalogItem, CatalogItem]) {
    const fresh = [first, second].filter((i) => !onListItemIds.has(i.id));
    onPickMany([first.id, second.id]);
    reset({
      label:
        fresh.length > 0
          ? `${first.name} och ${second.name} tillagda`
          : `${first.name} och ${second.name} står redan på listan`,
      undo: fresh.length > 0 ? fresh.map((i) => i.id) : null,
    });
  }

  /**
   * The vara a created one should be filed beside.
   *
   * Only when a qualifier was split off, which is the case this exists for:
   * "mogen banan" resolved to banan, so the new vara belongs in banan's aisle.
   * A query that merely looks a bit like something — "bananbröd" against banan
   * — has no such claim and inherits nothing.
   */
  const createLike = modifier ? matches[0] : undefined;

  function create() {
    onCreate(name, amountText, createLike);
    reset({ label: `${name} — ny vara, tillagd`, undo: null });
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

  /**
   * Arrow keys walk the panel, and the panel keeps real focus while they do.
   *
   * A results list you can only reach with a mouse is a mouse UI with a text box
   * in front of it. Measured before this: ArrowDown in the field did nothing at
   * all, Enter could only ever take the FIRST match, and the confirmation
   * strip's "Ångra" — the undo for the one-key add — had no keyboard route to it
   * whatsoever, because Tab blurred the field and the strip went with it.
   *
   * Roving focus rather than `aria-activedescendant`, and that is a deliberate
   * trade. Activedescendant would keep the caret in the field so you could carry
   * on typing, but it requires the rows to be `role="option"` inside a
   * `role="listbox"` — and these rows are `button`s that the whole e2e suite
   * locates by role, plus `useLongPress` already gives a focused button its own
   * Shift+F10 route to the details sheet. Moving focus for real reuses all of
   * that: highlight a row, press Shift+F10, and the amount-and-sort sheet opens
   * on it — the only keyboard way there, and it cost nothing.
   *
   * Arrow keys are a hardware-keyboard gesture, so nothing here can dismiss a
   * phone's on-screen keyboard: a thumb never generates one.
   */
  function moveInto(from: "top" | "bottom") {
    const stops = panel.current ? focusableWithin(panel.current) : [];
    if (stops.length === 0) return false;
    (from === "top" ? stops[0] : stops[stops.length - 1]).focus();
    return true;
  }

  /**
   * Step by geometry, not by document order — see `spatial-focus`, which owns
   * the rule and is where it is tested. Document order is right for the results
   * list and wrong for "Vanligast", a three-column `TileGrid` whose consecutive
   * tiles are side by side on screen.
   *
   * All this adds is the one thing that belongs to the add bar rather than to
   * grids in general: off the top is back to the field, which is where more
   * typing goes. Off the bottom stays put rather than wrapping — wrapping past
   * the last result into the confirmation strip reads as the list having moved
   * under you.
   */
  function stepWithin(key: ArrowKey) {
    const stops = panel.current ? focusableWithin(panel.current) : [];
    const current = document.activeElement;
    if (!(current instanceof HTMLElement) || !stops.includes(current)) return;
    if (stepFocusWithin(stops, current, key)) return;
    if (key === "ArrowUp") input.current?.focus();
  }

  const typing = name.length >= 1;
  // `open` gates every branch, so the panel cannot outlive the focus that
  // summoned it. It used to gate only two: blur set `open` false while
  // `showSuggestions` read the query alone, so clicking anything else on the
  // page left a full-width results panel hanging over the list until you came
  // back and cleared the field. Measured — it survived `blur()` with "brö" typed.
  const showSuggestions = Boolean(
    open && typing && (matches.length > 0 || canCreate || pair),
  );
  const showFrequent = open && !typing && frequent.length > 0;
  const showPanel = showSuggestions || showFrequent || (open && justAdded);

  return (
    <div
      ref={wrap}
      className="relative my-3"
      // One handler for the whole widget: Escape has to mean the same thing on a
      // result row as it does in the field, and a row that swallowed it would be
      // a dead end you can only leave with the mouse.
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        /**
         * The field owns its own Escape, and this must not second-guess it.
         *
         * This used to ask `document.activeElement === input.current`, which is
         * a question about the state the field's handler has ALREADY changed:
         * an Escape in an empty field blurs, so by the time the event got here
         * the answer was "no" and this refocused it — and focusing the field
         * reopens the panel. Measured: the "Vanligast" pane could not be
         * dismissed by any number of presses. Whose element the event started
         * on is the fact this actually needs, and nothing can move it.
         */
        if (e.target === input.current) return;
        e.preventDefault();
        input.current?.focus();
      }}
      onBlur={(e) => {
        // Only when focus has genuinely left the widget. Tabbing or arrowing
        // from the field INTO the panel is not leaving it, and closing on that
        // blur is what made every control in the panel unreachable.
        if (wrap.current?.contains(e.relatedTarget)) return;
        /**
         * A sheet opening over the panel is not the panel being dismissed.
         *
         * Holding a result row opens the details sheet, which takes focus — and
         * tearing the panel down on that blur unmounts the very row the sheet
         * belongs to, so `useFocusTrap` has nothing connected to hand focus back
         * to and it lands on `<body>`. Measured: Escape out of a details sheet
         * opened from a search row put focus at the top of the document.
         *
         * Staying open is also what the touch path already does — a finger never
         * blurs the field, because the panel prevents the mousedown — so this
         * only makes the keyboard behave like the thumb.
         */
        if (e.relatedTarget?.closest('[role="dialog"]')) return;
        closePanel();
      }}
    >
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
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              // Empty already: the second press is a request to get out, not to
              // clear something that is not there.
              if (raw) reset(null);
              else input.current?.blur();
              return;
            }
            // Into the results, and out the far end back here. The caret does
            // not move in a single-line field, so neither key has another job.
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              if (!showPanel) return;
              if (moveInto(e.key === "ArrowDown" ? "top" : "bottom")) {
                e.preventDefault();
              }
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
          /**
           * The field is a combobox, and saying so is what makes the results
           * exist for a screen reader.
           *
           * Without this the rows appeared with nothing announcing them: the
           * only signal that six varor had just been offered was the arrow key
           * landing on one. `aria-controls` names the listbox rather than the
           * whole panel, so it points at the choices and not at the
           * confirmation strip that sits above them.
           */
          role="combobox"
          aria-expanded={showSuggestions}
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          inputMode="text"
          /**
           * No `enterKeyHint`, deliberately, and this is the interesting one.
           *
           * It was `done`, which promises a keyboard that is about to go away —
           * and Enter here adds the top match and leaves the field focused and
           * empty for the next vara, measured, because adding six things is one
           * errand. So it was argued to `go`, which means take me to the target
           * of what I typed, and then to `send`, which on a Swedish iOS keyboard
           * reads *Skicka* — on a SHARED household list with live two-phone
           * sharing, which invites "send this to my partner": a plausible,
           * adjacent action this app does not have.
           *
           * Three values in one review cycle, every one argued from semantics by
           * someone with no phone in their hand. The churn is the finding. The
           * default *retur* promises nothing, costs nothing to learn, and is the
           * honest label for a field that does two jobs at once — its own
           * accessible name is "Sök eller lägg till vara". Whoever holds the
           * device gets to decide; nobody else should be voting on the
           * most-looked-at key of the most-used surface.
           */
          autoComplete="off"
          autoCorrect="off"
          /**
           * No `autoCapitalize="off"` either, for a better reason than taste.
           *
           * It was set to keep created varor lower-case, and it does not even do
           * that: `ensureVara` derives a vara's id through `slugify` →
           * `normalizeName`, which lowercases, so a capital collides with the
           * existing id and returns the existing vara. A capital cannot fork the
           * catalog. It survives in exactly one place — the display name — and
           * the rename sheets in /varor never had the attribute anyway, so the
           * rule was enforced at one keyboard and nowhere else.
           *
           * The cost was real and permanent: Swedish grocery lists are
           * brand-led — Kalles, Bregott, Oatly, Findus, ICA Basic — and every
           * one of those became a manual shift press, one-handed, in a shop, on
           * a field that already offers no autocorrect and no spellcheck. The
           * fix belongs in `ensureVara`, which owns catalog names; see the
           * report.
           */
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
          ref={panel}
          onMouseDown={keepFocus}
          onKeyDown={(e) => {
            // Left and right join down and up because "Vanligast" is a grid, and
            // a grid you can only walk vertically is half a grid. They are inert
            // in the single-column lists, where nothing shares a row.
            if (!isArrowKey(e.key)) return;
            e.preventDefault();
            // The list screen runs the same stepping over its tiles from a
            // handler on the page root, and this panel is inside it. Without
            // this, one press would be answered twice — once here and once by a
            // handler whose stops are a different set entirely.
            e.stopPropagation();
            stepWithin(e.key);
          }}
          className="absolute inset-x-0 top-full z-30 mt-1.5 overflow-hidden rounded-card border border-line bg-surface-raised shadow-xl shadow-black/10"
        >
          {/* The tile lands behind the keyboard, and keeping focus made that
              worse rather than better: you type on with no idea whether the
              last one took. This says so without a toast, and without leaving
              the field.

              The wrapper is a live region and is here even when there is
              nothing to say, which is the whole reason it is a wrapper. This
              strip is the ONLY confirmation an add gets, and focus never moves
              on an add — so without a region a screen reader was told nothing
              at all, on the surface whose entire purpose is the keyboard. It
              cannot be the strip itself: a region that appears in the same
              breath as its text is one the platform was not yet watching, and
              the announcement that gets lost is the first, which is the only
              one there is. Same shape the recipe screens' regions had to take.

              `status`, not an assertive alert — it must not cut across the
              letters already going into the next vara. */}
          <div role="status" aria-live="polite">
          {justAdded && (
            <div
              className={cn(
                "border-b border-line px-3 py-2 text-caption",
                // Green means "something is on the list" everywhere else in this
                // app, so a tap that changed nothing must not be drawn in it.
                justAdded.hint
                  ? "bg-surface-sunken text-ink-soft"
                  : "bg-brand-tint text-brand-ink",
              )}
            >
              <div className="flex items-center gap-2">
                {/* A tick is a claim that something happened. The one case
                    that reaches this strip having done nothing gets the tile's
                    own "already on the list" mark instead. */}
                <UiIcon
                  name={justAdded.hint ? "toList" : "check"}
                  size={14}
                  className="flex-none"
                />
                <span className="min-w-0 flex-1 truncate font-semibold">
                  {justAdded.label}
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
              {/* The way out of the dead end, said where the dead end is. Before
                  this, the app claimed it had added a second broccoli and there
                  was nowhere to go from there. */}
              {justAdded.hint && (
                <p className="mt-0.5 pl-[22px] text-ink-faint">
                  Håll in raden för att lägga till en annan sort.
                </p>
              )}
            </div>
          )}
          </div>

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
                      onLongPress={() => onLongPressItem(item.id)}
                      // The hold really does open AddDetailsSheet, so this tile
                      // is one of the three that may claim it. `ItemTile` stopped
                      // inferring the claim from `onLongPress` existing, because
                      // the suggestion tile's hold dismisses rather than opens.
                      longPressOpensDialog
                    />
                  );
                })}
              </TileGrid>
            </div>
          )}

          {showSuggestions && (
            // A real listbox, named, and pointed at by the field's
            // `aria-controls`. Arrow keys move DOM focus between its options
            // rather than an `aria-activedescendant`, which ARIA's combobox
            // pattern allows and which is what lets `useLongPress` keep its own
            // Shift+F10 route to the details sheet on the focused row.
            <ul id={LISTBOX_ID} role="listbox" aria-label="Sökträffar">
              {pair && (
                <li role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
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

              {matches.map((item) => (
                <MatchRow
                  key={item.id}
                  item={item}
                  modifier={modifier}
                  already={onListItemIds.has(item.id)}
                  onPick={() => pick(item)}
                  onLongPress={() => onLongPressItem(item.id)}
                />
              ))}

              {canCreate && (
                <li role="presentation">
                  <button
                    role="option"
                    aria-selected={false}
                    type="button"
                      onClick={create}
                    className="flex w-full items-center gap-3 border-t border-line px-3 py-2.5 text-left active:bg-brand-tint"
                  >
                    {/* Shows the icon it will inherit rather than a generic
                        plus, so the row previews the vara you are about to
                        get. */}
                    {createLike ? (
                      <ItemIcon iconRef={createLike.iconRef} className="text-xl" />
                    ) : (
                      <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-brand text-on-brand">
                        <UiIcon name="plus" size={13} />
                      </span>
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-body text-ink-soft">
                        Lägg till{" "}
                        <span className="font-bold text-ink">
                          &ldquo;{name}&rdquo;
                        </span>{" "}
                        som egen vara
                      </span>
                      {/* Where it lands, said before you commit. Filing a kind
                          of your own under Övrigt — which sorts LAST — is how
                          the supported way to keep ripe bananas apart from
                          ordinary ones became a punishment. */}
                      {createLike && (
                        <span className="text-caption text-ink-faint">
                          i {categoryNames.get(createLike.categoryId) ?? "Övrigt"}
                        </span>
                      )}
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
