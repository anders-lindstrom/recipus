"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Amount,
  CatalogItem,
  Category,
  Contribution,
  Id,
  List,
  ListEntry,
  Priority,
} from "@/lib/domain";
import {
  activeEntries,
  buildEntryView,
  byPriority,
  groupByCategory,
  itemsOnlyWantedByRecipe,
  shouldGroupByAisle,
  tileVaror,
  walkingRank,
  type EntryView,
  type RecipeAdditionInfo,
} from "@/lib/services/entries";
import type { ShopMode } from "@/lib/client/use-mode";
import { isArrowKey, stepFocusWithin } from "@/lib/client/spatial-focus";
import type { Tap } from "@/lib/client/use-long-press";
import { groupingFor, useListLayout } from "@/lib/client/use-list-layout";
import { cn } from "@/lib/utils";
import { useOnce } from "@/lib/client/use-once";
import { useSustained } from "@/lib/client/use-sustained";
import { AddBar } from "./add-bar";
import { AddDetailsSheet } from "./add-details-sheet";
import { AisleRail, aisleAnchorId } from "./aisle-rail";
import { EntrySheet } from "./entry-sheet";
import { ListLayoutSheet } from "./list-layout-sheet";
import { visibleSuggestions as visibleSuggestionsOf } from "./list-model";
import { MoveSheet } from "./move-sheet";
import { ItemTile, SectionHeading, TileGrid } from "./item-tile";
import {
  DuplicateAskSheet,
  type DuplicateAsk,
} from "./duplicate-ask-sheet";
import { SplitSortSheet } from "./split-sort-sheet";
import {
  RecipeRemovalSheet,
  type RecipeRemovalCandidate,
} from "./recipe-removal-sheet";
import { UiIcon } from "./ui-icon";

/**
 * The list screen.
 *
 * Two zones: what you need to buy, and everything you ever buy. There are no
 * checkboxes — an item is on the list or it isn't, and one tap moves it between
 * the two. That is the entire core loop, and its speed is the product.
 *
 * The green is spent entirely on the first zone. The header used to be a solid
 * brand-coloured bar, which meant the most saturated thing on screen was the
 * furniture rather than the seven items you actually came here for; now the
 * chrome is paper and ink, and the only green things are the items still to buy
 * and the one primary action. The catalog sits in a sunken well beneath, so the
 * boundary between "my list" and "everything" is a change of ground rather than
 * a heading you have to read.
 */

export interface ListScreenActions {
  /**
   * `amountText` is the raw trailing quantity the add bar split off ("2 l").
   * The caller parses it with the units engine — the same one the recipe
   * importer uses — so there is one implementation of "2 l" in the codebase.
   *
   * `undoesClientOpId` names the `remove_item` whose purchase this add retracts.
   * Only undo passes it; see the op's own comment for why it matters.
   */
  addItem: (
    catalogItemId: Id,
    amountText?: string,
    undoesClientOpId?: string,
  ) => void;
  /**
   * `bought` false means "changed my mind" and must not record a purchase.
   * Returns the op's `clientOpId` so undo can retract what it wrote.
   */
  removeItem: (catalogItemId: Id, bought: boolean) => string;
  setAmount: (catalogItemId: Id, amount: Amount | null) => void;
  setModifier: (catalogItemId: Id, modifier: string | null) => void;
  /** Which one on the shelf — "den i blå kartong". Edits the manual share. */
  setNote: (catalogItemId: Id, note: string | null) => void;
  setPriority: (catalogItemId: Id, priority: Priority) => void;
  /**
   * `likeItem` is the vara a new one should be filed beside — banan, for
   * "mogen banan". Without it a created vara lands in Övrigt, which sorts last.
   */
  createItem: (
    name: string,
    amountText: string,
    likeItem?: CatalogItem,
  ) => void;
  /**
   * Two kinds of one thing, made into two varor: the sort moves onto `newName`
   * carrying the manual ask, and the original is tidied.
   *
   * `keepPlain` says whether anybody wants the plain kind — true from the add
   * bar, where somebody has just asked for it, false from the entry sheet, where
   * the gesture means "this was always the ripe ones". The whole ordered plan is
   * `splitSortOps`, which is pure and tested.
   */
  splitSort: (
    baseItemId: Id,
    newName: string,
    options: { keepPlain: boolean; plainAmountText?: string },
  ) => void;
  /**
   * A vara created beside another one and put on the list with these details.
   * Not a split — nothing is moving off an existing ask.
   */
  createVaraLike: (params: {
    name: string;
    likeItem: CatalogItem;
    amount: Amount | null;
    priority: Priority;
  }) => Id | null;
  /** Out of search and the catalog well, keeping every purchase behind it. */
  setHidden: (catalogItemId: Id, hidden: boolean) => void;
  removeRecipe: (recipeAdditionId: Id) => void;
  /**
   * Relocates an item to another list, carrying its priority and manual
   * contribution. The payload is built by the caller from the store, because the
   * op has to carry what it moves — see `move_item` in lib/sync/ops.ts.
   */
  moveItem: (catalogItemId: Id, toListId: Id) => void;
  /**
   * "Inte den här gången" — silences a cadence suggestion for the rest of the
   * day, for the whole household. Not an op: dismissals cannot conflict, so they
   * go straight to the server. See src/api/routes/suggestions.ts.
   */
  dismissSuggestion: (catalogItemId: Id) => void;
  restoreSuggestion: (catalogItemId: Id) => void;
  openScanner: () => void;
  switchList: () => void;
  /**
   * The list's walking order, sent WHOLE. It is one value under one clock, so a
   * partial order would let last-write-wins settle on a sequence neither person
   * arranged. See `moveCategory`.
   */
  setCategoryOrder: (categoryOrder: Id[]) => void;
}

export interface ListScreenProps {
  list: List;
  /** Every list in the household, for the move picker. May be just `list`. */
  lists: List[];
  categories: Category[];
  catalog: CatalogItem[];
  entries: ListEntry[];
  contributions: Contribution[];
  recipeAdditions: Record<Id, RecipeAdditionInfo>;
  suggestions: Array<{ catalogItemId: Id; reason: string }>;
  members: Array<{ id: string; initials: string; color: string }>;
  sync: { online: boolean; pendingCount: number; signedOut: boolean };
  onReauthenticate?: () => void;
  /** Planning at home vs shopping in the shop. See lib/client/use-mode.ts. */
  mode: ShopMode;
  onModeChange: (mode: ShopMode) => void;
  actions: ListScreenActions;
}

export function ListScreen({
  list,
  lists,
  categories,
  catalog,
  entries,
  contributions,
  recipeAdditions,
  suggestions,
  members,
  sync,
  onReauthenticate,
  mode,
  onModeChange,
  actions,
}: ListScreenProps) {
  const router = useRouter();
  const [openEntry, setOpenEntry] = useState<Id | null>(null);
  /**
   * "Ångra" does not expire, and that is the whole point.
   *
   * It used to sit in the "Att handla" heading and vanish after eight seconds, and
   * an audit of a real shopping trip found what that costs. Ticking an item from a
   * later aisle — which is what mid-shop looks like — rendered the only undo 702px
   * above the viewport, most of a screen out of sight, and it was gone before
   * anyone scrolled up to look. So the shopper does the obvious thing instead:
   * finds the item in the catalog and taps it back on. That restores the item but
   * NOT the truth — `add_item` only retracts a purchase when handed the
   * `undoesClientOpId` that `undoLastBuy` alone passes — so the row stands and the
   * cadence engine learns from a purchase that never happened.
   *
   * That is the one thing `use-mode.ts` promises cannot happen: "you under-record
   * purchases, you never invent one". In the single most likely accident in a
   * moving shopper's hand, the app invented one.
   *
   * A timer is the wrong instrument for an undo whose entire job is to catch a
   * mistake you have not noticed yet — it expires exactly when it is needed. So
   * there is none. The offer stands until it is used, replaced by the next removal,
   * or dismissed, and it says which item it will undo so a stale one is ignorable
   * rather than confusing.
   */
  const [undoable, setUndoable] = useState<{
    id: Id;
    name: string;
    /** The removal to retract. Without it undo re-adds but leaves the purchase. */
    clientOpId: string;
    /** Drives the label: only a buy is a "köp" to undo. */
    bought: boolean;
  } | null>(null);
  /**
   * A recipe removal waiting on the "and its ingredients?" question.
   *
   * Held rather than dispatched immediately: the ingredients only this recipe
   * wants have to be computed BEFORE the contributions go, since afterwards
   * there is nothing left to tell them apart from anything else on the list.
   */
  const [duplicateAsk, setDuplicateAsk] = useState<DuplicateAsk | null>(null);
  /**
   * A sort on its way to becoming a vara, waiting to be named.
   *
   * `keepPlain` is the one thing that differs between the two routes here, and
   * it is not cosmetic. From the add bar, somebody has just asked for the plain
   * kind, so the original entry stays and becomes that ask. From the entry
   * sheet, nobody has — the whole gesture is "this was always the ripe ones" —
   * so the original comes off the list unless a recipe still wants it.
   */
  const [splitting, setSplitting] = useState<{
    itemId: Id;
    modifier: string;
    keepPlain: boolean;
    /** What the add bar had typed for the plain kind. Empty otherwise. */
    amountText: string;
  } | null>(null);
  const [removingRecipe, setRemovingRecipe] = useState<{
    additionId: Id;
    title: string;
    candidates: RecipeRemovalCandidate[];
  } | null>(null);
  /** The item whose "which list?" picker is open. */
  const [moving, setMoving] = useState<Id | null>(null);
  /** A catalog item being given details before it goes on the list. */
  const [addingDetails, setAddingDetails] = useState<Id | null>(null);
  const [layoutOpen, setLayoutOpen] = useState(false);
  /**
   * Suggestions dismissed on THIS device since the last hydrate.
   *
   * Held locally as well as written to the server so the tile disappears under
   * your thumb rather than after a round trip — and so the gesture still does
   * something visible in a shop with no signal. The server's own exclusion takes
   * over from the next snapshot onwards, at which point this set is redundant
   * and harmlessly stale.
   */
  const [dismissed, setDismissed] = useState<Set<Id>>(new Set());
  /** The one dismissal still offering "Ångra", in the Föreslås heading. */
  const [undoableDismissal, setUndoableDismissal] = useState<{
    id: Id;
    name: string;
  } | null>(null);
  const longPressHint = useOnce("recipus:hint:longpress");

  // Ops normally drain in tens of milliseconds. Only say anything once one has
  // been waiting long enough that the delay is the story.
  const syncIsSlow = useSustained(sync.pendingCount > 0, {
    delayMs: 1200,
    dwellMs: 900,
  });

  const live = useMemo(() => activeEntries(entries), [entries]);
  // Stand-ins included, so an entry whose vara was merged or deleted away is a
  // tile you can tap off rather than a row nothing can draw. See `tileVaror`.
  const { byId, standIns } = useMemo(
    () => tileVaror(catalog, live),
    [catalog, live],
  );
  const onListIds = useMemo(
    () => new Set(live.map((e) => e.catalogItemId)),
    [live],
  );

  const views = useMemo(() => {
    const map = new Map<Id, EntryView>();
    for (const e of live) {
      map.set(e.catalogItemId, buildEntryView(e, contributions, recipeAdditions));
    }
    return map;
  }, [live, contributions, recipeAdditions]);

  /**
   * Buying something used to raise a toast, and the toast was the problem.
   *
   * It sat bottom-centre for five seconds, on top of the entry sheet's own
   * buttons (measured: it covered the row below "Ändra mängd"), and the core
   * loop is tapping tile after tile — so the confirmation for tap three was
   * still in the way when you made tap four. A shopping list does not need a
   * banner to announce this: the tile leaves the zone, the count drops, and both
   * are already on screen.
   *
   * What the toast did carry was undo, which is worth keeping, because an item
   * tapped off by mistake drops back into its aisle somewhere down the catalog
   * rather than staying where you can see it. So undo moves into the section
   * heading — in normal flow, where it cannot cover a control.
   */
  function tapOnList(item: CatalogItem) {
    // The one gesture whose meaning depends on the mode, deliberately the only
    // one. At the kitchen table you are editing an intention and nothing should
    // be recorded; in a shop you are recording an event. That asymmetry is the
    // whole reason the mode exists, and it is what makes the purchase history
    // trustworthy enough to build statistics and fridge inference on.
    //
    /*
     * Haptic on the buy, for the reason `use-long-press.ts` already writes down
     * about the hold: "without it a long-press feels like a tap that didn't
     * register". That argument was never carried across to the gesture it
     * matters most for — the one that happens twenty-five times a trip, writes
     * purchase history, and is made while looking at a shelf rather than at the
     * screen. Buying is the only branch that gets one: in plan mode nothing is
     * being recorded, so there is nothing to confirm.
     *
     * Same 12ms, and optional-chained for the same reason — iOS Safari has no
     * vibrate at all.
     */
    if (mode === "buy") navigator.vibrate?.(12);
    remove(item.id, item.name, mode === "buy");
  }

  /**
   * The one place an item leaves the list, whichever gesture asked for it.
   *
   * The tap uses the mode; the entry sheet deliberately offers the OTHER mode's
   * answer ("Markera som köpt" while planning, "Köpte inte" while shopping), so
   * neither mode can trap you into recording the wrong thing. Routing all three
   * through here is what keeps the undo bookkeeping identical for all of them.
   */
  function remove(id: Id, name: string, bought: boolean) {
    /*
     * A stand-in never records a purchase, whatever the caller asked for.
     *
     * Its vara is tombstoned, so the purchase is credited to a word nobody uses
     * — and ACCEPTED rather than rejected, because deletes here are soft and the
     * row is still there. The merge's server-side re-pointing has already run by
     * then and is gated on that op, so nothing will ever move the credit to the
     * survivor: the tombstone keeps the count and the survivor under-records for
     * good.
     *
     * The guard is here rather than at the call sites because there are three of
     * them and the first fix only covered one — a tap. "Markera som köpt" in the
     * entry sheet went straight past it, which is the same bug reached by a
     * longer route. One choke point, so a fourth caller cannot reintroduce it.
     */
    const clientOpId = actions.removeItem(id, bought && !standIns.has(id));
    // Replaces whatever was on offer. One strip, always the most recent removal:
    // a stack of them would be chrome in the thumb zone, and the mistake people
    // actually make is on the tap they just made.
    setUndoable({ id, name, clientOpId, bought });
    setAnnouncement(bought ? `${name} köpt` : `${name} borttagen`);
  }

  /**
   * Hand the split to the store, once the second kind has a name.
   *
   * All this decides is which of the two shapes it is; the plan itself —
   * including the ordering that stops a removed entry keeping its old sort — is
   * `splitSortOps`, where it can be asserted rather than eyeballed.
   */
  function splitSort(name: string) {
    if (!splitting) return;
    actions.splitSort(splitting.itemId, name, {
      keepPlain: splitting.keepPlain,
      plainAmountText: splitting.amountText,
    });
    setSplitting(null);
    setOpenEntry(null);
  }

  function undoLastBuy() {
    if (!undoable) return;
    // Two halves, and the second one used to be missing: put the item back, and
    // retract the purchase the removal recorded. Re-adding alone left "bought"
    // permanently including things the user had just said they had not bought.
    actions.addItem(undoable.id, undefined, undoable.clientOpId);
    setAnnouncement(`${undoable.name} tillbaka på listan`);
    setUndoable(null);
  }

  // The household's own choice, falling back to the rule that shipped before
  // there was one — so a list nobody has configured looks exactly as it did.
  const { layout, setLayout } = useListLayout();
  const grouped = groupingFor(layout, shouldGroupByAisle(live.length));

  // Walking order first, urgency second — and that order of tie-breaks is the
  // whole argument. Sorting urgency across aisles would trade a useful signal
  // for the far more useful one of not walking back across the shop, so urgent
  // rises WITHIN an aisle and never out of it.
  //
  // The aisle sort used to be implicit: the grouped view got it from
  // `groupByCategory` and the flat view did not get it at all, so turning
  // headings off left the tiles in whatever order the entry map happened to
  // produce. Sorting here gives both views the same sequence and makes "one long
  // list" mean "the same walk, without the headings" rather than "unordered".
  const aisleRank = walkingRank(list.categoryOrder);
  const toBuyTiles = live
    .slice()
    .sort((a, b) => {
      const ai = byId.get(a.catalogItemId);
      const bi = byId.get(b.catalogItemId);
      const byAisle =
        aisleRank(ai?.categoryId ?? "") - aisleRank(bi?.categoryId ?? "");
      if (byAisle !== 0) return byAisle;
      const av = views.get(a.catalogItemId);
      const bv = views.get(b.catalogItemId);
      return av && bv ? byPriority(av, bv) : 0;
    })
    .map((e) => byId.get(e.catalogItemId))
    .filter((c): c is CatalogItem => Boolean(c));

  function renderTile(item: CatalogItem) {
    const view = views.get(item.id);
    return (
      <ItemTile
        key={item.id}
        name={item.name}
        iconRef={item.iconRef}
        quantityLabel={view?.totalLabel}
        fromRecipe={view?.hasRecipeSource}
        priority={view?.priority}
        modifier={view?.modifier}
        onList
        animateIn
        onTap={(tap) => {
          keepFocusAfterTap(tap);
          tapOnList(item);
        }}
        onLongPress={() => setOpenEntry(item.id)}
      />
    );
  }

  const catalogByCategory = useMemo(
    () =>
      groupByCategory(
        // Anything already on the list is shown above; repeating it below is
        // just a second place to tap the same thing.
        //
        // Hidden varor are out of the well entirely, which is most of what
        // hiding is FOR: the well is 341 tiles you scroll past on the way to
        // something, and a household's own one-off kinds accumulate there faster
        // than anywhere else. They stay reachable by typing the name — see
        // `rankMatches`, which demotes rather than drops.
        catalog.filter((c) => !c.hidden && !onListIds.has(c.id)),
        (c) => c.categoryId,
        list.categoryOrder,
      ),
    [catalog, onListIds, list.categoryOrder],
  );

  const categoryName = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name])),
    [categories],
  );

  // The rail only advertises aisles that actually have something in them —
  // a chip that scrolls to an empty heading is a chip that looks broken.
  const aisles = useMemo(
    () =>
      catalogByCategory.map((group) => ({
        id: group.categoryId,
        name: categoryName.get(group.categoryId) ?? "Övrigt",
      })),
    [catalogByCategory, categoryName],
  );

  /**
   * Suggestions taken up in this session, kept hidden for the rest of it.
   *
   * `onListIds` below is not enough on its own, and the gap is buy mode: taking
   * a vara off the list is exactly what makes it leave `live`, so a suggestion
   * accepted in the car and ticked off in the shop would come straight back
   * into "Föreslås" — offering to sell you the milk already in the trolley. The
   * server's own exclusion set (`list-data.ts`) has the same blind spot from
   * the other side: it filters `removedAt === null` at query time and does not
   * know what has happened since.
   *
   * Session-scoped on purpose. The next snapshot recomputes suggestions from
   * the purchase that tapping it wrote, at which point this set is redundant
   * and harmlessly stale — the same shape, and the same reasoning, as
   * `dismissed` above.
   */
  const [accepted, setAccepted] = useState<Set<Id>>(new Set());

  /**
   * What just happened, for a screen reader.
   *
   * The core loop is silent to assistive tech, and deliberately so for sighted
   * users: the toast that used to confirm a buy was REMOVED because it covered
   * the entry sheet's own buttons, on the grounds that "the tile leaves the
   * zone, the count drops, and both are already on screen". Both of those are
   * visual. Nothing replaced them for anyone not looking at the screen — not
   * even "Ångra köp", which is the safety valve for the mistake most worth
   * catching.
   *
   * A live region costs no pixels, so it does not reopen the argument the toast
   * lost. `polite`, not assertive: it must not interrupt someone mid-way
   * through the next tile.
   */
  const [announcement, setAnnouncement] = useState("");

  /** See `visibleSuggestions` in list-model.ts for why there are three sets. */
  const visibleSuggestions = useMemo(
    () => visibleSuggestionsOf(suggestions, { onList: onListIds, accepted, dismissed }),
    [suggestions, dismissed, accepted, onListIds],
  );

  function acceptSuggestion(id: Id) {
    setAccepted((prev) => new Set(prev).add(id));
    actions.addItem(id);
    setAnnouncement(`${byId.get(id)?.name ?? "Varan"} tillagd`);
  }

  function dismissSuggestion(id: Id, name: string) {
    setDismissed((prev) => new Set(prev).add(id));
    setUndoableDismissal({ id, name });
    actions.dismissSuggestion(id);
  }

  function undoDismissal() {
    if (!undoableDismissal) return;
    const { id } = undoableDismissal;
    setDismissed((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setUndoableDismissal(null);
    actions.restoreSuggestion(id);
  }

  const openItem = openEntry ? byId.get(openEntry) : undefined;
  const openView = openEntry ? views.get(openEntry) : undefined;
  const movingItem = moving ? byId.get(moving) : undefined;
  const movingView = moving ? views.get(moving) : undefined;
  const addingItem = addingDetails ? byId.get(addingDetails) : undefined;
  const splitItem = splitting ? byId.get(splitting.itemId) : undefined;
  const splitViewHasRecipe = splitting
    ? Boolean(views.get(splitting.itemId)?.hasRecipeSource)
    : false;

  /** The aisle a vara is filed in, for the sheets that say where things land. */
  const aisleOf = (item: CatalogItem) =>
    categoryName.get(item.categoryId) ?? "Övrigt";

  /**
   * Arrow keys walk the tiles, which is the whole screen from a keyboard.
   *
   * Tab already reached every tile, one at a time, in document order — which on
   * a page whose catalog runs to 341 of them is not a route to anything. The
   * arrows were doing what arrows do with no handler: scrolling the page, so a
   * tile could be focused and unreachable in the same breath.
   *
   * One handler on the page root rather than one per grid, because the grids
   * this has to cross are not one component: "Att handla" is a grid per aisle
   * when the list is grouped, "Föreslås" is another, and the catalog well is one
   * per aisle again. Collected together and stepped by geometry, ArrowDown off
   * the last row of the list simply lands in the first row of what follows —
   * nothing here has to know the sections exist.
   *
   * TILES ONLY. The headings' own controls — Ordning, Varor, the undo — stay on
   * Tab, so an arrow pressed mid-grid can never land somewhere that is not a
   * vara. The add bar is inside this root and runs the same stepping over its
   * own panel; it stops the event, so the two never both answer one press.
   */
  function stepTiles(e: React.KeyboardEvent) {
    if (!isArrowKey(e.key)) return;
    const root = e.currentTarget;
    if (!(root instanceof HTMLElement)) return;
    const tiles = Array.from(
      root.querySelectorAll<HTMLElement>("[data-tile-grid] > button"),
    );
    const current = document.activeElement;
    if (!(current instanceof HTMLElement) || !tiles.includes(current)) return;
    // Prevented whether or not focus moved. At the edges of the grid there is
    // nowhere to go, and scrolling the page instead is the exact behaviour
    // being replaced — an arrow that sometimes moves focus and sometimes moves
    // the page is worse than one that does neither.
    e.preventDefault();
    stepFocusWithin(tiles, current, e.key);
  }

  /**
   * Where focus goes when the tile under it is about to stop existing.
   *
   * Activating a tile is the core loop, and from a keyboard it was a loop you
   * could only run once: Space takes the item off the list, the tile unmounts,
   * and focus falls to `<body>` — where the arrow keys go back to scrolling the
   * page and the next Space does nothing at all. Ticking off three things meant
   * three journeys back in with Tab.
   *
   * The NEXT tile in the same grid, so a run of presses walks forward the way
   * reading does; the previous one when there is no next, so clearing the tail
   * of an aisle does not dead-end on the last item. When the grid empties there
   * is nothing left in it to hold focus and it goes where it always went.
   *
   * The element itself rather than the item's id, and that is not laziness:
   * `ItemTile` is keyed by id inside a stable parent, so React keeps the very
   * same DOM node across the commit that removes its neighbour. `isConnected`
   * covers the one case where it does not — an item that changes grid entirely,
   * which happens when a removal empties an aisle and the grouping changes
   * underneath it.
   */
  const handOffFocus = useRef<HTMLElement | null>(null);

  function keepFocusAfterTap(tap: Tap) {
    handOffFocus.current = null;
    // A thumb tap must not leave a focus ring on the tile that slides into the
    // gap. Nobody is looking at the keyboard focus on a touchscreen, and moving
    // it there would be a visible mark on a tile the user never chose.
    if (!tap.fromKeyboard) return;
    const current = document.activeElement;
    if (!(current instanceof HTMLElement)) return;
    const grid = current.closest("[data-tile-grid]");
    if (!grid) return;
    const tiles = Array.from(grid.querySelectorAll<HTMLElement>(":scope > button"));
    const i = tiles.indexOf(current);
    if (i < 0) return;
    handOffFocus.current = tiles[i + 1] ?? tiles[i - 1] ?? null;
  }

  /**
   * On every commit, because the commit that matters is simply the next one.
   *
   * The ref is set inside a click handler and the state change it precedes is
   * batched with it, so the first render after it is the one where the old tile
   * has gone. Cleared as it is read, so a later commit — a sync arriving, a
   * sheet opening — cannot pull focus back to a tile the user has since left.
   */
  useEffect(() => {
    const next = handOffFocus.current;
    if (!next) return;
    handOffFocus.current = null;
    if (next.isConnected) next.focus();
  });

  return (
    <div className="min-h-dvh pb-28" onKeyDown={stepTiles}>
      {/* Mounted always, and empty until there is something to say. A region
          that appears in the same breath as its text is one the platform was
          not yet watching, so the first announcement — often the only one —
          is the one that gets lost. The add bar's own region says the same
          thing about itself, in the same words. */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {/* Opaque, not frosted. A translucent bar let high-contrast tile labels
          ghost through it in dark mode, and `backdrop-filter` on a bar pinned
          over a 341-tile scroller costs a GPU repaint every frame on exactly
          the hardware this has to stay smooth on.

          Buy mode washes this whole block terracotta and thickens the bottom
          border. Nothing below it changes — in particular `ItemTile` never does,
          which is what structurally keeps the mode from colliding with
          green-means-on-the-list. `--mode-wash` tells the aisle rail's edge fade
          what it is fading into. */}
      <header
        className={cn(
          "safe-top sticky top-0 z-30 border-b transition-colors duration-200",
          mode === "buy"
            ? // The accent is an inset shadow, not a thicker border, because a
              // border changes the header's HEIGHT — and the aisle rail measures
              // that height at runtime to place its jump offsets and its
              // active-aisle line. Measured: a 2px border made the header 94px in
              // buy mode against 93px in plan. An inset shadow costs no layout, so
              // both modes are exactly one height.
              "border-mode-buy-line bg-mode-buy-wash shadow-[inset_0_-2px_0_var(--color-mode-buy-line)] [--mode-wash:var(--color-mode-buy-wash)]"
            : "border-line bg-surface",
        )}
      >
        {/* 3.25rem, not the 3rem it was. The controls in here are 44px and the
            focus ring is 2px at 2px offset, so a row of 48 left 2px of the 4px
            a ring needs — and this row is pinned at the very top of the
            viewport, so the missing 2px was not clipped by anything, it was
            simply off screen. Every pinned offset in `globals.css` is measured
            against this height and the rail's; they moved together. */}
        <div className="flex h-13 items-center gap-1 px-3">
          {/* The list's name is this screen's heading as well as the way to
              switch lists, and it had been neither — a styled span in a button,
              with no <h1> anywhere on the page for a screen reader to orient by.
              The heading wraps the control rather than replacing it, so the
              switcher is untouched and the type scale does not move. */}
          <h1 className="min-w-0">
            <button
              type="button"
              onClick={actions.switchList}
              className="-ml-1 flex min-h-11 items-center gap-1 rounded-control px-1 py-1"
            >
              <span className="truncate text-title text-ink">{list.name}</span>
              <UiIcon
                name="chevronDown"
                size={16}
                className="flex-none text-ink-faint"
              />
            </button>
          </h1>

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => onModeChange(mode === "buy" ? "plan" : "buy")}
            // The accessible name STARTS with the visible word. It used to be only
            // "Byt till planeringsläge", which does not contain the label the
            // button actually shows — so a speech-input user saying "tryck
            // Handlar" got nothing at all (WCAG 2.5.3 Label in Name, Level A),
            // and everyone else got the classic toggle ambiguity of a control
            // whose name describes the state it is NOT in.
            aria-label={
              mode === "buy"
                ? "Handlar — byt till planeringsläge"
                : "Planerar — byt till handla-läge"
            }
            className={cn(
              // 44px, not the 32 it was. This is the control that decides what
              // every other tap on the screen MEANS — a tile tapped in the wrong
              // mode either invents a purchase or fails to record one — and it
              // was the shortest thing on a header where the settings link had
              // already been grown for exactly this reason. The pill now matches
              // the aisle rail's chips directly below it, which are the same
              // type at the same 44px, so the header reads as one row of
              // controls rather than two sizes of them.
              "mr-1 flex min-h-11 flex-none items-center gap-1.5 rounded-full px-3",
              "text-caption font-semibold transition-colors duration-150",
              mode === "buy"
                // `text-on-brand`, not a hardcoded white. White on the buy line
                // measured 2.65:1 in dark mode against a 4.5:1 requirement — the
                // colour system was already right and this was the one surface
                // not using it. See `--color-mode-buy-line` in globals.css, which
                // the light half of the same fix darkens.
                ? "bg-mode-buy-line text-on-brand"
                : "border border-line text-ink-soft",
            )}
          >
            <UiIcon name={mode === "buy" ? "scan" : "edit"} size={14} />
            {mode === "buy" ? "Handlar" : "Planerar"}
          </button>

          {/* The household's faces, and the way into settings.

              They were decoration — the only thing on this header you could not
              press — while the one screen that answers "which build is this
              phone actually running" had no entry point at all. Your own initials
              are where anyone looks for "me", so that is where it goes, and it
              costs no new furniture on a header that is already full. */}
          <Link
            href="/installningar"
            aria-label="Inställningar"
            // The avatars stay 24px; the box around them does not. Measured at
            // 18×24 — the smallest target in the app, on the only way into
            // settings — against WCAG 2.2's 24×24 floor and the 44px this app
            // uses everywhere a thumb is expected. Padding rather than a bigger
            // glyph, so the header's density is unchanged.
            className="-mr-1 ml-1 flex min-h-11 min-w-11 flex-none items-center justify-center px-1"
          >
            {members.map((m) => (
              <span
                key={m.id}
                title={m.id}
                className="-ml-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface text-badge text-white"
                style={{ background: m.color }}
              >
                {m.initials}
              </span>
            ))}
          </Link>

          {/* The two screens that are not this one. Everything else up here is
              about the list you are standing in front of, so they get quiet
              icons rather than a nav bar competing with the tiles.

              The registry used to be reachable only from a button two thirds of
              the way down the catalog well, on the grounds that a grid glyph up
              here would read as a second copy of the aisle rail's own grid
              glyph. That was true of a grid glyph and not of the problem: three
              screens were being advertised in three unrelated places, and the
              one nobody could find was the one filed furthest down. A bag reads
              as goods rather than as a layout, and the button in the well stays
              — it is right where it is, it just is not the only way in. */}
          {/* 44×44, and the glyphs are unchanged at 20px — only the touchable
              box grew. Measured at 36×36 with 4px between them: two different
              screens, both under the floor this app uses everywhere else, in the
              top corner a one-handed grip reaches least well. The settings link
              beside them had already been fixed for the same reason and these
              two were left behind. */}
          <Link
            href="/varor"
            aria-label="Varor"
            className="ml-1 flex h-11 w-11 flex-none items-center justify-center rounded-full text-ink-soft"
          >
            <UiIcon name="registry" size={20} />
          </Link>

          <Link
            href="/recept"
            aria-label="Recept"
            className="-mr-1 flex h-11 w-11 flex-none items-center justify-center rounded-full text-ink-soft"
          >
            <UiIcon name="recipes" size={20} />
          </Link>
        </div>

        {/* Only ever appears when there is something to say. Never a modal,
            never a spinner over the list.

            "Something to say" excludes an op that is merely in flight — see
            `useSustained`. Being offline or signed out shows at once, because
            those are states you stay in rather than blips: the banner appears
            once and the list settles under it.

            It is a raised card with a warn accent rather than the warn-tinted
            strip it used to be: measured, `warn-tint` sits only ΔL* 1.60 from
            the buy-mode wash, so on an orange header the strip all but
            disappeared exactly when it had something to say. */}
        {(sync.signedOut || !sync.online || syncIsSlow) && (
          <div className="mx-2 mb-2 flex items-center gap-2 rounded-control border-l-[3px] border-warn bg-surface-raised px-2.5 py-1.5 text-caption text-warn shadow-sm">
            {sync.signedOut ? (
              <>
                <UiIcon name="warning" size={14} className="flex-none" />
                <span className="flex-1">Inloggningen har gått ut</span>
                <button
                  type="button"
                  onClick={onReauthenticate}
                  className="font-bold underline underline-offset-2"
                >
                  Logga in igen
                </button>
              </>
            ) : (
              <>
                <UiIcon
                  name={sync.online ? "retry" : "offline"}
                  size={14}
                  className="flex-none"
                />
                <span>
                  {sync.online ? "Synkar" : "Offline"}
                  {sync.pendingCount > 0 &&
                    ` · ${sync.pendingCount} ${
                      sync.pendingCount === 1 ? "ändring" : "ändringar"
                    } väntar`}
                </span>
              </>
            )}
          </div>
        )}

        {/* Aisle navigation belongs to the whole page, not to the catalog, so it
            pins with the header rather than appearing when the catalog starts.
            That is what makes going back *up* possible: a rail that lived below
            the buy zone scrolled away exactly when you wanted it. */}
        <AisleRail aisles={aisles} />
      </header>

      <div className="px-3">
        <AddBar
          catalog={catalog}
          onListItemIds={onListIds}
          onPick={(itemId, amountText, modifier) => {
            // A qualifier that was typed is a statement, not an inheritance, so
            // it just applies — and it overwrites whatever was there, because
            // "mogen mango" said which mango it means. The question below only
            // exists for the case where nothing was said.
            if (modifier) {
              actions.addItem(itemId, amountText);
              actions.setModifier(itemId, modifier);
              return;
            }

            // The one case where adding from the bar is not unambiguous: the
            // item is already on the list carrying a qualifier, and the amount
            // about to be written shares a record with it. Applying silently
            // would deliver "1 st mogna" to someone who asked for one mango.
            const existing = views.get(itemId);
            if (existing?.modifier) {
              setDuplicateAsk({
                itemId,
                itemName: byId.get(itemId)?.name ?? itemId,
                existingModifier: existing.modifier,
                amountText,
              });
              return;
            }
            actions.addItem(itemId, amountText);
          }}
          onPickMany={(itemIds) => {
            for (const id of itemIds) actions.addItem(id);
          }}
          // `bought: false` throughout. Undoing an add is a change of plan and
          // never a shop, and recording it as one would teach the cadence
          // engine that this household buys salt every time it mistypes.
          onUndoAdd={(itemIds) => {
            for (const id of itemIds) actions.removeItem(id, false);
          }}
          onCreate={actions.createItem}
          onLongPressItem={setAddingDetails}
          onUnhide={(id) => actions.setHidden(id, false)}
          categoryNames={categoryName}
        />

        <SectionHeading
          id={aisleAnchorId("__top__")}
          count={live.length > 0 ? live.length : undefined}
          // In the slot the undo vacated, and next to the thing it governs
          // rather than up in a header that is already full. The order of the
          // aisles is the single highest-value edit on this screen — everything
          // the add bar invents starts in Övrigt, which sorts last — and until
          // now there was no way to make it anywhere in the app.
          action={
            <button
              type="button"
              onClick={() => setLayoutOpen(true)}
              aria-label="Vy och ordning"
              // 44px of target inside 32px of layout. The negative margin is
              // what keeps the second half of that true: this heading
              // deliberately reserves a fixed height so a control appearing in
              // it cannot shove the list down, and a plainly taller button would
              // have spent 12px of the first screen to buy the same reach.
              //
              // Vertically only. It used to pull right as well, which left 4px
              // to the count beside it against the heading's own `gap-2` of 8 —
              // and 4px is exactly the reach of a focus ring, so the ring was
              // drawn through the "12". The label moves 4px left; nothing else
              // about the row does.
              className="-my-1.5 flex min-h-11 items-center gap-1 rounded-full px-2 text-caption font-semibold text-ink-soft normal-case"
            >
              <UiIcon name="allAisles" size={14} />
              Ordning
            </button>
          }
        >
          Att handla
        </SectionHeading>

        {/* Said once, ever.

            Amounts, priority, the household's qualifier, moving a vara, and
            taking something off WITHOUT recording a purchase are all behind a
            500ms hold that nothing advertises. The press-in affordance on the
            tile confirms the gesture to someone already trying it and does
            nothing for the person who never does — which, for a gesture with no
            visible entry point, is most people.

            In flow rather than over the tiles, for the same reason the buy
            toast was taken out: this sits above the grid it describes and
            covers no control. It waits for a third item so it is not the first
            thing a brand-new list says.

            Left as it is, after trying to narrow it to "en bricka i listan" and
            finding that worse. The hold is one gesture with two meanings — here
            and in the catalog it opens a sheet, on a Föreslås tile it dismisses
            the suggestion outright — and this sentence is the only thing that
            advertises any of it. Scoping it to the list buys accuracy about two
            or three suggestion tiles by making it silent about 341 catalog ones,
            whose hold is the documented way to say "two mogna mango" without
            three navigations. That is a worse trade, and `useOnce` makes it a
            one-way one: this is said once ever per device, so anyone who has
            already read it never sees a correction. The gesture that needs
            changing is the destructive one, not the sentence. */}
        {longPressHint.pending && live.length >= 3 && (
          <div className="mb-2 flex items-center gap-2 rounded-control border border-line bg-surface-raised px-3 py-2">
            <UiIcon
              name="edit"
              size={14}
              className="flex-none text-ink-faint"
            />
            <p className="flex-1 text-caption text-ink-soft">
              Håll en bricka intryckt för mängd, prioritet och mer.
            </p>
            <button
              type="button"
              onClick={longPressHint.dismiss}
              aria-label="Dölj tipset"
              className="-mr-1 flex h-7 w-7 flex-none items-center justify-center rounded-full text-ink-faint"
            >
              <UiIcon name="clear" size={14} />
            </button>
          </div>
        )}

        {live.length === 0 ? (
          <div className="rounded-card border border-dashed border-line-strong px-6 py-10 text-center">
            <p className="text-body font-semibold text-ink">Listan är tom</p>
            <p className="mx-auto mt-1 max-w-[26ch] text-body-sm text-ink-soft">
              Sök efter en vara, eller tryck på något i katalogen nedan.
            </p>
          </div>
        ) : grouped ? (
          groupByCategory(
            toBuyTiles,
            (c) => c.categoryId,
            list.categoryOrder,
          ).map((group) => (
            <div key={group.categoryId}>
              <SectionHeading tone="brand">
                {categoryName.get(group.categoryId) ?? "Övrigt"}
              </SectionHeading>
              <TileGrid>{group.items.map(renderTile)}</TileGrid>
            </div>
          ))
        ) : (
          <TileGrid>{toBuyTiles.map(renderTile)}</TileGrid>
        )}

        {/* Kept mounted while an undo is still offered, even with nothing left
            to suggest — dismissing the only suggestion must not take the way to
            change your mind down with it. */}
        {(visibleSuggestions.length > 0 || undoableDismissal) && (
          <>
            <SectionHeading
              tone="warn"
              action={
                undoableDismissal && (
                  <button
                    type="button"
                    onClick={undoDismissal}
                    className="flex items-center gap-1 rounded-full bg-warn-tint px-2.5 py-1 text-caption font-semibold text-ink normal-case"
                  >
                    <UiIcon name="undo" size={13} />
                    Ångra {undoableDismissal.name}
                  </button>
                )
              }
            >
              Föreslås
            </SectionHeading>
            <TileGrid>
              {visibleSuggestions.map((s) => {
                const item = byId.get(s.catalogItemId);
                if (!item) return null;
                return (
                  <ItemTile
                    key={item.id}
                    name={item.name}
                    iconRef={item.iconRef}
                    reason={s.reason}
                    onTap={(tap) => {
                    keepFocusAfterTap(tap);
                    acceptSuggestion(item.id);
                  }}
                    // Long-press ACTS here rather than opening a sheet, which is
                    // a departure from every other tile. A suggestion has only
                    // two possible answers — yes and not today — and a sheet
                    // containing one button is ceremony. The safety valve is the
                    // Ångra above, exactly as it is for buying.
                    onLongPress={() => dismissSuggestion(item.id, item.name)}
                    // Which is why this one tile must not claim a dialog: the
                    // hold acts, and every other tile's hold opens something.
                    longPressOpensDialog={false}
                  />
                );
              })}
            </TileGrid>
          </>
        )}
      </div>

      {/* The catalog gets its own ground. Everything above this line is the
          household's current intent; everything below is the vocabulary it
          draws on, and the two should not look like one long list. */}
      <section className="mt-6 border-t border-line bg-surface-sunken px-3 pb-6">
        {/* The well has never had a name, which is why the bottom two-thirds of
            this screen reads as "more list" rather than as the vocabulary the
            list is drawn from. Naming it also gives the registry its one entry
            point, in the only place on the app that is unambiguously about the
            same set of things.

            A masthead rather than another `SectionHeading`: it is the well's
            title, not a peer of the aisle headings underneath it, and at 17px
            against their 11px caps the hierarchy says so without a rule. */}
        <div className="flex items-center gap-2 pt-4">
          <h2 className="flex-1 text-title text-ink">Allt ni handlar</h2>
          <Link
            href="/varor"
            className="flex flex-none items-center gap-1.5 rounded-full border border-line-strong px-3 py-1.5 text-caption font-semibold text-ink-soft"
          >
            <UiIcon name="registry" size={14} />
            Varor
          </Link>
        </div>

        {catalogByCategory.map((group) => (
          <div key={group.categoryId}>
            <SectionHeading id={aisleAnchorId(group.categoryId)} tone="brand">
              {categoryName.get(group.categoryId) ?? "Övrigt"}
            </SectionHeading>
            <TileGrid>
              {group.items.map((item) => (
                <ItemTile
                  key={item.id}
                  name={item.name}
                  iconRef={item.iconRef}
                  // The well has the same problem in reverse: adding a vara
                  // takes its tile OUT of the well, so filling a list from the
                  // keyboard dead-ended on the first item exactly as ticking one
                  // off did.
                  onTap={(tap) => {
                    keepFocusAfterTap(tap);
                    actions.addItem(item.id);
                  }}
                  // Same 500ms hold as the buy zone, so there is one gesture to
                  // learn rather than two. Adding a bare item was the ONLY thing
                  // a catalog tile could do, so "two mogna mango" meant tapping
                  // mango here, watching it leave the catalog, scrolling up to
                  // find it among everything already on the list, and holding
                  // THAT. Three navigations to say something you knew before you
                  // started.
                  onLongPress={() => setAddingDetails(item.id)}
                />
              ))}
            </TileGrid>
          </div>
        ))}
      </section>

      {/* Undo, in the thumb arc.

          This is not the toast that was taken out. That one floated bottom-centre
          ON TOP of the entry sheet's own buttons, so the confirmation for tap
          three covered the control you wanted for tap four. This sits at z-30,
          UNDER every sheet's z-50 backdrop, so it cannot cover a control in the
          one situation that mattered — and it announces nothing, it only offers
          the retraction. The scan button below is the app's proof that the bottom
          of the screen is where a shopper's thumb already is; this is the same
          reasoning applied to the one control that repairs a mistake.

          Cleared to the left of the scan button rather than layered under it: a
          44px target half-covered by a 56px circle is a 44px target you miss.

          The gap above the screen edge is a MARGIN on the card, not padding on
          the wrapper. `.safe-bottom` sets `padding-bottom:
          env(safe-area-inset-bottom)`, so a `pb-3` beside it is the same
          property twice and source order picks the winner — measured: on a phone
          with no home indicator the inset resolves to 0 and the strip sat flush
          against the bottom edge. A margin cannot collide with it, so the card
          clears the edge by 12px on a Pixel and by 12px plus the indicator on an
          iPhone. */}
      {undoable && (
        <div className="safe-bottom fixed inset-x-0 bottom-0 z-30 px-3">
          <div className="mr-[4.75rem] mb-3 flex items-center gap-1 rounded-card border border-line bg-surface-raised pl-3 shadow-lg shadow-black/20">
            <button
              type="button"
              onClick={undoLastBuy}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left text-body font-semibold text-brand-ink"
            >
              <UiIcon name="undo" size={16} className="flex-none" />
              <span className="truncate">
                {undoable.bought ? "Ångra köp" : "Ångra"} — {undoable.name}
              </span>
            </button>
            {/* Dismissible, because without a timer the offer would otherwise
                outstay its welcome — and dismissing is the user saying "yes, I
                meant that", which no timeout can tell you. */}
            <button
              type="button"
              onClick={() => setUndoable(null)}
              aria-label="Stäng ångra"
              className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-ink-faint"
            >
              <UiIcon name="close" size={18} />
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={actions.openScanner}
        aria-label="Skanna streckkod"
        // Neutral shadow, not a brand-tinted one: a green glow under a green
        // button reads as a neon halo in dark mode rather than as elevation.
        //
        // The inset is in `bottom`, not in `padding-bottom`. `.safe-bottom` sets
        // padding, and this button has a FIXED height — so on a border-box
        // element the padding ate the content box instead of moving the button:
        // measured with a 34px indicator, the circle still ended 16px from the
        // screen edge (18px inside the home indicator) and the glyph was pushed
        // 17px above the circle's centre. The undo strip beside it gets this
        // right because its inset lands on a wrapper with no height of its own.
        // Expressed in `bottom`, which is the one property that moves a sized
        // box. Its own 16px, not the strip's 12px — this keeps the gap the
        // button already had and adds the indicator to it.
        className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-40 flex h-14 w-14 items-center justify-center rounded-full bg-brand text-on-brand shadow-lg shadow-black/20 transition-transform duration-100 active:scale-95"
      >
        <UiIcon name="scan" size={24} />
      </button>

      {removingRecipe && (
        <RecipeRemovalSheet
          recipeTitle={removingRecipe.title}
          candidates={removingRecipe.candidates}
          onCancel={() => setRemovingRecipe(null)}
          onConfirm={(itemIds) => {
            actions.removeRecipe(removingRecipe.additionId);
            // `bought: false` throughout. Dropping a recipe is a change of
            // plan, not a shop, and recording it as one would teach the cadence
            // engine that you buy these things every time you change your mind.
            for (const itemId of itemIds) actions.removeItem(itemId, false);
            setRemovingRecipe(null);
          }}
        />
      )}

      {duplicateAsk && (
        <DuplicateAskSheet
          ask={duplicateAsk}
          onClose={() => setDuplicateAsk(null)}
          onKeepModifier={() => {
            actions.addItem(duplicateAsk.itemId, duplicateAsk.amountText);
            setDuplicateAsk(null);
          }}
          onSplit={() => {
            setSplitting({
              itemId: duplicateAsk.itemId,
              modifier: duplicateAsk.existingModifier,
              // The plain kind is exactly what was just asked for, so it stays.
              keepPlain: true,
              amountText: duplicateAsk.amountText,
            });
            setDuplicateAsk(null);
          }}
          onClearModifier={() => {
            actions.addItem(duplicateAsk.itemId, duplicateAsk.amountText);
            actions.setModifier(duplicateAsk.itemId, null);
            setDuplicateAsk(null);
          }}
        />
      )}

      {splitting && splitItem && (
        <SplitSortSheet
          baseName={splitItem.name}
          modifier={splitting.modifier}
          aisleName={categoryName.get(splitItem.categoryId) ?? "Övrigt"}
          note={
            splitting.keepPlain
              ? `${splitItem.name} blir kvar på listan som den vanliga sorten.`
              : splitViewHasRecipe
                ? `${splitItem.name} står kvar, eftersom ett recept vill ha den.`
                : `${splitItem.name} tas bort från listan — ingen har bett om den vanliga sorten.`
          }
          onConfirm={splitSort}
          onClose={() => setSplitting(null)}
        />
      )}

      {openItem && openView && (
        <EntrySheet
          // Same reason as the add sheet below: the amount and sort fields seed
          // their drafts on mount, so a reused instance would open on the last
          // vara's numbers.
          key={openItem.id}
          itemName={openItem.name}
          view={openView}
          mode={mode}
          // Withheld for a stand-in: `remove` would refuse to record the purchase
          // anyway, so the button would say "Markera som köpt" and then not mark
          // it bought. Absent beats dishonest — the same rule `onMove` follows
          // when there is nowhere to move to.
          onMarkBought={
            standIns.has(openItem.id)
              ? undefined
              : () => {
            // Identical to what a buy-mode tap does — marking it bought means you
            // have it, so it leaves the list. Reusing that op rather than adding a
            // purchase-only one keeps this shippable before any new op kind is on
            // every device.
                  remove(openItem.id, openItem.name, true);
                  setOpenEntry(null);
                }
          }
          onClose={() => setOpenEntry(null)}
          // None of the three close the sheet any more. They are fields now,
          // and a sheet that vanished the moment you finished typing an amount
          // would make setting a sort as well a second long-press.
          onSetModifier={(modifier) => actions.setModifier(openItem.id, modifier)}
          onSetNote={(note) => actions.setNote(openItem.id, note)}
          onSetPriority={(priority) => actions.setPriority(openItem.id, priority)}
          onSetAmount={(amount) => actions.setAmount(openItem.id, amount)}
          onRemoveRecipe={(id, title) => {
            setOpenEntry(null);
            const orphans = itemsOnlyWantedByRecipe(id, entries, contributions)
              .map((itemId) => byId.get(itemId))
              .filter((c): c is CatalogItem => Boolean(c))
              .map((c) => ({ id: c.id, name: c.name, iconRef: c.iconRef }));

            // Nothing would be left stranded, so there is nothing to ask about.
            if (orphans.length === 0) {
              actions.removeRecipe(id);
              return;
            }
            setRemovingRecipe({ additionId: id, title, candidates: orphans });
          }}
          // A navigation, so the sheet does not need closing — the page goes.
          //
          // Absent for a stand-in: `/varor` resolves `?vara=` by looking the id
          // up among the varor it holds, and a tombstoned one is not there — so
          // the link landed on a screen of everything with nothing open and
          // nothing said. A button whose only outcome is a dead end is worse
          // than no button, which is the same rule `onMove` already follows.
          onOpenVara={
            standIns.has(openItem.id)
              ? undefined
              : () =>
                  router.push(
                    `/varor?list=${encodeURIComponent(list.id)}&vara=${encodeURIComponent(openItem.id)}`,
                  )
          }
          // Withheld for a stand-in, like the two above and for the same reason:
          // its vara is tombstoned, so there is no aisle and no icon for a new
          // one to inherit and the split would file the household's own kind in
          // Övrigt with a box on it.
          onSplitModifier={
            standIns.has(openItem.id)
              ? undefined
              : () =>
                  setSplitting({
                    itemId: openItem.id,
                    modifier: openView.modifier ?? "",
                    // Nobody has asked for the plain kind here — the gesture
                    // says "this was always the ripe ones".
                    keepPlain: false,
                    amountText: "",
                  })
          }
          onMove={
            // Offered only when there is somewhere to move TO. With one list the
            // picker would open empty, which reads as a broken button.
            lists.length > 1
              ? () => {
                  setMoving(openItem.id);
                  setOpenEntry(null);
                }
              : undefined
          }
          onRemoveWithoutBuying={() => {
            remove(openItem.id, openItem.name, false);
            setOpenEntry(null);
          }}
        />
      )}

      {layoutOpen && (
        <ListLayoutSheet
          list={list}
          categories={categories}
          layout={layout}
          onLayoutChange={setLayout}
          onOrderChange={actions.setCategoryOrder}
          onClose={() => setLayoutOpen(false)}
        />
      )}

      {addingItem && (
        <AddDetailsSheet
          // Keyed, so a different vara can never inherit the last one's draft.
          // The fields seed their state from props on mount only — which is what
          // lets you type freely without a partner's edit yanking the caret —
          // and that is exactly the property that makes a reused instance show
          // the wrong amount.
          key={addingItem.id}
          item={addingItem}
          alreadyOnList={onListIds.has(addingItem.id)}
          aisleName={aisleOf(addingItem)}
          onClose={() => setAddingDetails(null)}
          // Straight through: this sheet has already collected the name, and
          // there is nothing on the original to tidy — a vara reached from the
          // catalog or from search either is not on the list, or is and stays
          // exactly as it was. The plain kind was never in question here.
          onAddAsOwnVara={({ name, amount, priority }) => {
            actions.createVaraLike({
              name,
              likeItem: addingItem,
              amount,
              priority,
            });
            setAddingDetails(null);
          }}
          onHide={() => {
            actions.setHidden(addingItem.id, true);
            setAddingDetails(null);
          }}
          onAdd={({ amount, modifier, priority }) => {
            // One act, in the order the reducer expects: the entry has to exist
            // before anything can be written against it. Each field is its own
            // op because each resolves against its own clock — bundling them
            // would make a stale phone's amount drag the sort back with it.
            actions.addItem(addingItem.id);
            if (amount) actions.setAmount(addingItem.id, amount);
            if (modifier) actions.setModifier(addingItem.id, modifier);
            if (priority !== "normal")
              actions.setPriority(addingItem.id, priority);
            setAddingDetails(null);
          }}
        />
      )}

      {movingItem && movingView && (
        <MoveSheet
          itemName={movingItem.name}
          view={movingView}
          from={list}
          lists={lists}
          onMove={(toListId) => {
            actions.moveItem(movingItem.id, toListId);
            setMoving(null);
          }}
          onClose={() => setMoving(null)}
        />
      )}
    </div>
  );
}
