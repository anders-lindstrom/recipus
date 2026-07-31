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
  type EntryView,
  type RecipeAdditionInfo,
} from "@/lib/services/entries";
import type { ShopMode } from "@/lib/client/use-mode";
import { cn } from "@/lib/utils";
import { useOnce } from "@/lib/client/use-once";
import { useSustained } from "@/lib/client/use-sustained";
import { AddBar } from "./add-bar";
import { AddDetailsSheet } from "./add-details-sheet";
import { AisleRail, aisleAnchorId } from "./aisle-rail";
import { EntrySheet } from "./entry-sheet";
import { MoveSheet } from "./move-sheet";
import { ItemTile, SectionHeading, TileGrid } from "./item-tile";
import {
  DuplicateAskSheet,
  type DuplicateAsk,
} from "./duplicate-ask-sheet";
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

/**
 * How long "Ångra" stays offered after a purchase.
 *
 * Longer than the toast it replaces, because it costs nothing to leave up: it
 * sits in the heading's own row rather than floating over the controls.
 */
const UNDO_WINDOW_MS = 8000;

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
  const [removingRecipe, setRemovingRecipe] = useState<{
    additionId: Id;
    title: string;
    candidates: RecipeRemovalCandidate[];
  } | null>(null);
  /** The item whose "which list?" picker is open. */
  const [moving, setMoving] = useState<Id | null>(null);
  /** A catalog item being given details before it goes on the list. */
  const [addingDetails, setAddingDetails] = useState<Id | null>(null);
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
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressHint = useOnce("recipus:hint:longpress");

  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    [],
  );

  // Ops normally drain in tens of milliseconds. Only say anything once one has
  // been waiting long enough that the delay is the story.
  const syncIsSlow = useSustained(sync.pendingCount > 0, {
    delayMs: 1200,
    dwellMs: 900,
  });

  const live = useMemo(() => activeEntries(entries), [entries]);
  // Stand-ins included, so an entry whose vara was merged or deleted away is a
  // tile you can tap off rather than a row nothing can draw. See `tileVaror`.
  const byId = useMemo(() => tileVaror(catalog, live), [catalog, live]);
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
    const clientOpId = actions.removeItem(id, bought);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndoable({ id, name, clientOpId, bought });
    undoTimer.current = setTimeout(() => setUndoable(null), UNDO_WINDOW_MS);
  }

  function undoLastBuy() {
    if (!undoable) return;
    // Two halves, and the second one used to be missing: put the item back, and
    // retract the purchase the removal recorded. Re-adding alone left "bought"
    // permanently including things the user had just said they had not bought.
    actions.addItem(undoable.id, undefined, undoable.clientOpId);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndoable(null);
  }

  const grouped = shouldGroupByAisle(live.length);

  // Urgent first, convenient last — and crucially WITHIN whatever grouping is
  // already in force, so aisle walking order survives. A stable sort keeps
  // everything else exactly where it was, which is what makes the reordering
  // read as emphasis rather than as the list rearranging itself.
  const toBuyTiles = live
    .slice()
    .sort((a, b) => {
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
        onTap={() => tapOnList(item)}
        onLongPress={() => setOpenEntry(item.id)}
      />
    );
  }

  const catalogByCategory = useMemo(
    () =>
      groupByCategory(
        // Anything already on the list is shown above; repeating it below is
        // just a second place to tap the same thing.
        catalog.filter((c) => !onListIds.has(c.id)),
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

  const visibleSuggestions = useMemo(
    () => suggestions.filter((s) => !dismissed.has(s.catalogItemId)),
    [suggestions, dismissed],
  );

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

  return (
    <div className="min-h-dvh pb-28">
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
        <div className="flex h-12 items-center gap-1 px-3">
          <button
            type="button"
            onClick={actions.switchList}
            className="-ml-1 flex items-center gap-1 rounded-control px-1 py-1"
          >
            <span className="text-title text-ink">{list.name}</span>
            <UiIcon name="chevronDown" size={16} className="text-ink-faint" />
          </button>

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => onModeChange(mode === "buy" ? "plan" : "buy")}
            aria-label={
              mode === "buy" ? "Byt till planeringsläge" : "Byt till handla-läge"
            }
            className={cn(
              "mr-1 flex h-8 flex-none items-center gap-1.5 rounded-full px-2.5",
              "text-caption font-semibold transition-colors duration-150",
              mode === "buy"
                ? "bg-mode-buy-line text-white"
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
            className="ml-1 flex flex-none items-center"
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
          <Link
            href="/varor"
            aria-label="Varor"
            className="ml-1.5 flex h-9 w-9 items-center justify-center rounded-full text-ink-soft"
          >
            <UiIcon name="allAisles" size={20} />
          </Link>

          <Link
            href="/recept"
            aria-label="Recept"
            className="flex h-9 w-9 items-center justify-center rounded-full text-ink-soft"
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
          categoryNames={categoryName}
        />

        <SectionHeading
          id={aisleAnchorId("__top__")}
          count={live.length > 0 ? live.length : undefined}
          action={
            undoable && (
              <button
                type="button"
                onClick={undoLastBuy}
                className="flex items-center gap-1 rounded-full bg-brand-tint px-2.5 py-1 text-caption font-semibold text-brand-ink normal-case"
              >
                <UiIcon name="undo" size={13} />
                {undoable.bought ? "Ångra köp" : "Ångra"} {undoable.name}
              </button>
            )
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
            thing a brand-new list says. */}
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
                    onTap={() => actions.addItem(item.id)}
                    // Long-press ACTS here rather than opening a sheet, which is
                    // a departure from every other tile. A suggestion has only
                    // two possible answers — yes and not today — and a sheet
                    // containing one button is ceremony. The safety valve is the
                    // Ångra above, exactly as it is for buying.
                    onLongPress={() => dismissSuggestion(item.id, item.name)}
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
            <UiIcon name="allAisles" size={14} />
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
                  onTap={() => actions.addItem(item.id)}
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

      <button
        type="button"
        onClick={actions.openScanner}
        aria-label="Skanna streckkod"
        // Neutral shadow, not a brand-tinted one: a green glow under a green
        // button reads as a neon halo in dark mode rather than as elevation.
        className="safe-bottom fixed right-4 bottom-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-brand text-on-brand shadow-lg shadow-black/20 transition-transform duration-100 active:scale-95"
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
          onClearModifier={() => {
            actions.addItem(duplicateAsk.itemId, duplicateAsk.amountText);
            actions.setModifier(duplicateAsk.itemId, null);
            setDuplicateAsk(null);
          }}
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
          onMarkBought={() => {
            // Identical to what a buy-mode tap does — marking it bought means you
            // have it, so it leaves the list. Reusing that op rather than adding a
            // purchase-only one keeps this shippable before any new op kind is on
            // every device.
            remove(openItem.id, openItem.name, true);
            setOpenEntry(null);
          }}
          onClose={() => setOpenEntry(null)}
          // None of the three close the sheet any more. They are fields now,
          // and a sheet that vanished the moment you finished typing an amount
          // would make setting a sort as well a second long-press.
          onSetModifier={(modifier) => actions.setModifier(openItem.id, modifier)}
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
          onOpenVara={() =>
            router.push(
              `/varor?list=${encodeURIComponent(list.id)}&vara=${encodeURIComponent(openItem.id)}`,
            )
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
          onClose={() => setAddingDetails(null)}
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
