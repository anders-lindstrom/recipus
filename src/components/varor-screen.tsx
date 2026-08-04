"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogItem, Category, Id, Product } from "@/lib/domain";
import { groupByCategory } from "@/lib/services/entries";
import { cn } from "@/lib/utils";
import { ItemIcon } from "./icon";
import { SectionHeading } from "./item-tile";
import { ScreenHeader } from "./screen-header";
import { UiIcon } from "./ui-icon";
import { VarorItemSheet } from "./varor-item-sheet";
import { VarorMergeSheet } from "./varor-merge-sheet";
import { VarorPlaceSheet } from "./varor-place-sheet";
import { VarorSplitSheet } from "./varor-split-sheet";
import {
  filterProducts,
  filterVaror,
  productSubtitle,
  type VaraView,
} from "./varor-model";

/**
 * The registry — the household's own words, and the things on shelves that hang
 * off them.
 *
 * Deliberately not a grid of tiles. The list screen is a grid because it is read
 * at arm's length while walking and every tap means "buy this"; this is a screen
 * you sit down with, and tiles here would say "tap me to add it", which is the
 * one thing tapping must not do. Rows with hairlines, the app's existing pattern
 * for things that are all the same kind at the same level.
 *
 * Green is almost absent, and that is the rule rather than restraint: green means
 * "on the list" and nothing else, so the only green on this screen marks a vara
 * that is on today's list — which is also, not coincidentally, the thing that
 * blocks deleting it.
 *
 * The review queue sits at the top because it is the screen's reason to exist.
 * Scanned purchases attribute to a PRODUCT, and a product with no vara counts
 * towards nothing until a human places it; the queue is what makes the numbers
 * true, so it advertises the debt rather than waiting to be found.
 */

/**
 * How long "Ångra" stays offered after a placement.
 *
 * Same window as the list screen's, for the same reason: a mis-tap in the queue
 * sends a product under the wrong word and it vanishes from the queue with no
 * trace, exactly as a mis-tapped tile drops back into an aisle you cannot see.
 */
const UNDO_WINDOW_MS = 8000;

export interface VarorScreenActions {
  /** Places a product on a vara — or back in the queue, when null. */
  placeProduct: (productId: Id, catalogItemId: Id | null) => void;
  /** Creates the vara, then places the product on it. */
  createVaraAndPlace: (productId: Id, name: string) => void;
  renameVara: (varaId: Id, name: string) => void;
  /** Re-file into another aisle — the edit that decides where you meet it in the shop. */
  recategorizeVara: (varaId: Id, categoryId: Id) => void;
  /** Staples, excluded by default when a recipe is added to a list. */
  setHasAtHome: (varaId: Id, hasAtHome: boolean) => void;
  setVaraIcon: (varaId: Id, iconRef: string) => void;
  /**
   * Out of search, the catalog well and "Vanligast" — and nothing else.
   *
   * This screen is where hiding stops being one-way. Nothing else lists a hidden
   * vara, so without a mark here and a way to reverse it the gesture would be a
   * delete wearing a gentler word.
   */
  setHidden: (varaId: Id, hidden: boolean) => void;
  /** Creates `newName`, then moves exactly `productIds` onto it. The source stays. */
  splitVara: (varaId: Id, newName: string, productIds: Id[]) => void;
  /** Moves the products across, then tombstones `fromId` and keeps its word as an alias. */
  mergeVaror: (fromId: Id, toId: Id, productIds: Id[]) => void;
  deleteVara: (varaId: Id) => void;
  /** Takes a vara off a shopping list WITHOUT recording a purchase. */
  takeOffList: (listId: Id, catalogItemId: Id) => void;
  /**
   * Puts a vara on a shopping list from here.
   *
   * This screen used to say in writing that it could not — "Inget läggs på
   * listan härifrån" — on the design position that the registry is where you
   * edit the word and the list is where you shop. It reads differently from
   * inside the errand: you are looking straight at mjölk, you want mjölk, and
   * the answer was to go back and type its name again.
   */
  addToList: (listId: Id, catalogItemId: Id) => void;
}

export interface VarorScreenProps {
  varor: VaraView[];
  /**
   * Opened on arrival, from `?vara=` on the URL.
   *
   * The list screen hands you straight here from an item you long-pressed, so
   * landing on a screen of everything and having to find it again would undo the
   * point of the link.
   */
  openVaraId?: Id | null;
  /** The list the household was last on — where "lägg till" puts things. */
  listId: Id;
  /** Products nobody has placed yet. The count is the debt. */
  queue: Product[];
  catalog: Record<Id, CatalogItem>;
  categories: Category[];
  /** This list's walking order, so aisles read the same here as in the shop. */
  categoryOrder: Id[];
  listName: (listId: Id) => string;
  sync: { online: boolean; pendingCount: number };
  actions: VarorScreenActions;
}

type OpenSheet =
  | { kind: "vara"; id: Id }
  | { kind: "place"; productId: Id }
  | { kind: "split"; id: Id }
  | { kind: "merge"; id: Id }
  | null;

export function VarorScreen({
  varor,
  openVaraId = null,
  listId,
  queue,
  catalog,
  categories,
  categoryOrder,
  listName,
  sync,
  actions,
}: VarorScreenProps) {
  const [query, setQuery] = useState("");
  const [sheet, setSheet] = useState<OpenSheet>(
    // Read once, as the initial value rather than in an effect: an effect would
    // render the screen and then pop the sheet over it, which reads as a glitch.
    openVaraId ? { kind: "vara", id: openVaraId } : null,
  );
  /** The one placement still offering "Ångra", in the queue's own heading. */
  const [undoable, setUndoable] = useState<{
    productId: Id;
    productName: string;
    /** Where it was before — null for "it was in the queue", which undo restores. */
    previous: Id | null;
  } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    [],
  );

  const trimmed = query.trim();
  const searching = trimmed.length > 0;

  const matchedVaror = useMemo(
    () => filterVaror(varor, trimmed),
    [varor, trimmed],
  );
  const matchedQueue = useMemo(
    () => filterProducts(queue, trimmed),
    [queue, trimmed],
  );

  const categoryName = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name])),
    [categories],
  );

  // Grouped by aisle in the list's own walking order, so the same word is in the
  // same place here as it is in the shop. Flattened while searching: three
  // results under three headings is more chrome than content.
  const grouped = useMemo(
    () =>
      groupByCategory(matchedVaror, (v) => v.item.categoryId, categoryOrder),
    [matchedVaror, categoryOrder],
  );

  const catalogList = useMemo(() => Object.values(catalog), [catalog]);

  const openVara =
    sheet?.kind === "vara" || sheet?.kind === "split" || sheet?.kind === "merge"
      ? varor.find((v) => v.item.id === sheet.id)
      : undefined;
  const openProduct =
    sheet?.kind === "place"
      ? // Looked up out of the CURRENT state rather than held in the sheet's own
        // state: placing a product re-renders this list, and a stale copy would
        // go on showing the vara it used to be on.
        queue.find((p) => p.id === sheet.productId) ??
        varor
          .flatMap((v) => v.products)
          .find((p) => p.id === sheet.productId)
      : undefined;

  function place(product: Product, catalogItemId: Id | null) {
    actions.placeProduct(product.id, catalogItemId);
    offerUndo(product);
    setSheet(null);
  }

  function offerUndo(product: Product) {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndoable({
      productId: product.id,
      productName: product.name,
      previous: product.catalogItemId,
    });
    undoTimer.current = setTimeout(() => setUndoable(null), UNDO_WINDOW_MS);
  }

  function undoPlacement() {
    if (!undoable) return;
    actions.placeProduct(undoable.productId, undoable.previous);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndoable(null);
  }

  return (
    <div className="min-h-dvh pb-16">
      <ScreenHeader
        title="Varor"
        backHref="/"
        backLabel="Till handlingslistan"
      />

      {/* What the screen is, said on the screen.
          Nothing said it, and the silence was expensive. The same three hundred
          things, with the same pictures and the same names, are tiles on the
          list — where a tap BUYS one — and rows here, where a tap opens a sheet
          that renames, re-files, splits, merges and deletes. Same object, same
          art, opposite verb, and the only words this screen had about itself
          were the heading "ALLA VAROR" and a count.
          The second sentence is the one that earns its place. Everything else
          here can be worked out by trying it, and trying it is exactly what
          nobody dares do while they suspect a tap might put ananas on tonight's
          shopping. It sits above the sync banner because it is what the screen
          IS rather than how it is feeling today. */}
      {/* "Inget läggs på listan härifrån" used to be the second sentence, and
          it was true rather than reassuring: you could stand here looking at
          mjölk, want mjölk, and be sent back to type its name. The sheet adds
          to the list now, so the copy says what a tap does instead of what it
          refuses to do. */}
      <p className="mx-3 mt-3 text-body-sm text-ink-soft">
        Era egna ord för allt ni brukar köpa — vad de heter, hur de ser ut och
        var de står. Tryck på en för att ändra den eller lägga den på listan.
      </p>

      {/* Same shape and same wording as the list screen's banner, because being
          offline means the same thing here: the edit landed, and it is queued.
          A raised card with a warn accent rather than a warn-tinted strip — that
          strip all but disappears against a warm background. */}
      {(!sync.online || sync.pendingCount > 0) && (
        <div className="mx-3 mt-2 flex items-center gap-2 rounded-control border-l-[3px] border-warn bg-surface-raised px-2.5 py-1.5 text-caption text-warn shadow-sm">
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
        </div>
      )}

      <div className="px-3">
        <div className="relative my-3">
          <div className="flex items-center gap-2.5 rounded-card border border-line bg-surface-raised px-3 py-2.5">
            <UiIcon
              name="search"
              size={18}
              className="flex-none text-ink-faint"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
              placeholder="Sök vara eller produkt…"
              aria-label="Sök vara eller produkt"
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-faint"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Rensa"
                className="-mr-1 flex h-7 w-7 flex-none items-center justify-center rounded-full text-ink-faint"
              >
                <UiIcon name="clear" size={16} />
              </button>
            )}
          </div>
        </div>

        {/* Kept mounted while an undo is still offered even with the queue
            emptied, so clearing the last one does not take the way to change
            your mind down with it. */}
        {(matchedQueue.length > 0 || undoable) && (
          <>
            <SectionHeading
              tone="warn"
              count={matchedQueue.length > 0 ? matchedQueue.length : undefined}
              action={
                undoable && (
                  <button
                    type="button"
                    onClick={undoPlacement}
                    className="flex items-center gap-1 rounded-full bg-warn-tint px-2.5 py-1 text-caption font-semibold text-ink normal-case"
                  >
                    <UiIcon name="undo" size={13} />
                    Ångra {undoable.productName}
                  </button>
                )
              }
            >
              Att placera
            </SectionHeading>

            {matchedQueue.length > 0 && (
              <>
                {/* The debt, said out loud. Everything about the two-level model
                    is defensible except leaving this implicit: these products'
                    purchases are recorded and are simply not counted yet, and
                    only a person can say which word they belong under. */}
                <p className="mx-0.5 -mt-1 mb-2 text-body-sm text-ink-soft">
                  {matchedQueue.length === 1
                    ? "En skannad produkt"
                    : `${matchedQueue.length} skannade produkter`}{" "}
                  väntar på en vara. Deras köp räknas inte förrän ni placerat
                  dem.
                </p>

                {/* Named for assistive tech, which needs to be told this is a
                    different kind of list from the varor below it — and named
                    rather than anonymous so a test can ask about the queue
                    without also matching the undo control in its heading. */}
                <ul
                  aria-label="Produkter att placera"
                  className="divide-y divide-line rounded-card border border-line bg-surface-raised px-3"
                >
                  {matchedQueue.map((product) => {
                    const subtitle = productSubtitle(product);
                    return (
                      <li key={product.id}>
                        <button
                          type="button"
                          onClick={() =>
                            setSheet({ kind: "place", productId: product.id })
                          }
                          className="flex w-full items-center gap-3 py-3 text-left transition-transform duration-100 active:scale-[0.99]"
                        >
                          <ItemIcon
                            iconRef="1F4E6"
                            className="text-xl opacity-70"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-body font-semibold text-ink">
                              {product.name}
                            </span>
                            {subtitle && (
                              <span className="block truncate text-caption text-ink-faint">
                                {subtitle}
                              </span>
                            )}
                          </span>
                          <span className="flex-none rounded-full bg-warn-tint px-3 py-1.5 text-caption font-bold text-warn">
                            Placera
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </>
        )}

        <SectionHeading
          tone="brand"
          count={matchedVaror.length > 0 ? matchedVaror.length : undefined}
        >
          {searching ? "Träffar" : "Alla varor"}
        </SectionHeading>

        {matchedVaror.length === 0 ? (
          <div className="rounded-card border border-dashed border-line-strong px-6 py-10 text-center">
            <p className="text-body font-semibold text-ink">
              {searching ? `Inget som heter "${trimmed}"` : "Inga varor än"}
            </p>
            <p className="mx-auto mt-1 max-w-[30ch] text-body-sm text-ink-soft">
              {searching
                ? "Varor får sina namn av er. Lägg till nya från sökrutan på handlingslistan."
                : "Öppna handlingslistan en gång med täckning, så finns katalogen kvar här också."}
            </p>
          </div>
        ) : searching ? (
          <VaraRows
            varor={matchedVaror}
            listName={listName}
            onOpen={(id) => setSheet({ kind: "vara", id })}
          />
        ) : (
          grouped.map((group) => (
            <div key={group.categoryId}>
              <SectionHeading tone="brand">
                {categoryName.get(group.categoryId) ?? "Övrigt"}
              </SectionHeading>
              <VaraRows
                varor={group.items}
                listName={listName}
                onOpen={(id) => setSheet({ kind: "vara", id })}
              />
            </div>
          ))
        )}
      </div>

      {openProduct && (
        <VarorPlaceSheet
          product={openProduct}
          catalog={catalogList}
          current={
            openProduct.catalogItemId
              ? (catalog[openProduct.catalogItemId] ?? null)
              : null
          }
          onPlace={(catalogItemId) => place(openProduct, catalogItemId)}
          onCreateAndPlace={(name) => {
            actions.createVaraAndPlace(openProduct.id, name);
            offerUndo(openProduct);
            setSheet(null);
          }}
          onUnplace={() => place(openProduct, null)}
          onClose={() => setSheet(null)}
        />
      )}

      {openVara && sheet?.kind === "vara" && (
        <VarorItemSheet
          vara={openVara}
          categoryName={
            categoryName.get(openVara.item.categoryId) ?? "Övrigt"
          }
          categories={categories}
          listName={listName}
          /*
           * None of the four edits closes this sheet, and that is one rule
           * rather than four coincidences.
           *
           * Naming a vara, filing it, giving it a picture and saying you always
           * have it are four facts about ONE thing, and they are wanted
           * together: you re-file surdegsbröd into Bröd and immediately want to
           * stop it being a cardboard box. Closing after each one dropped you on
           * a screen of three hundred other varor with this one to find again —
           * and when you had arrived from the shopping list via `?vara=`, it did
           * not even drop you back where you came from.
           *
           * The `hasAtHome` toggle already worked this way, for the reason that
           * covers all four: closing makes trying something feel like a commit.
           * The sub-editors collapse themselves instead — see the sheet.
           */
          onRename={(name) => actions.renameVara(openVara.item.id, name)}
          onRecategorize={(categoryId) =>
            actions.recategorizeVara(openVara.item.id, categoryId)
          }
          onSetHasAtHome={(hasAtHome) =>
            actions.setHasAtHome(openVara.item.id, hasAtHome)
          }
          onSetIcon={(iconRef) => actions.setVaraIcon(openVara.item.id, iconRef)}
          onSetHidden={(hidden) => actions.setHidden(openVara.item.id, hidden)}
          onSplit={() => setSheet({ kind: "split", id: openVara.item.id })}
          onMerge={() => setSheet({ kind: "merge", id: openVara.item.id })}
          onDelete={() => {
            actions.deleteVara(openVara.item.id);
            setSheet(null);
          }}
          onTakeOffList={(listId) =>
            actions.takeOffList(listId, openVara.item.id)
          }
          /**
           * Straight onto the list the household was last on.
           *
           * No list picker, deliberately, even for a household with several.
           * The registry is reached FROM a list — the header's back link says
           * "Till handlingslistan", and `?vara=` arrives from a tile on one —
           * so which list you mean is not in doubt while you are standing here.
           * A picker would charge every add a decision that has one plausible
           * answer. Moving it afterwards is one long-press away on the list
           * itself, which is where you can see the consequence.
           */
          targetListId={listId}
          onAddToList={() => actions.addToList(listId, openVara.item.id)}
          onUnplaceProducts={() => {
            for (const product of openVara.products) {
              actions.placeProduct(product.id, null);
            }
          }}
          onOpenProduct={(product) =>
            setSheet({ kind: "place", productId: product.id })
          }
          onClose={() => setSheet(null)}
        />
      )}

      {openVara && sheet?.kind === "split" && (
        <VarorSplitSheet
          vara={openVara}
          catalog={catalog}
          onSplit={(name, productIds) => {
            actions.splitVara(openVara.item.id, name, productIds);
            setSheet(null);
          }}
          onClose={() => setSheet({ kind: "vara", id: openVara.item.id })}
        />
      )}

      {openVara && sheet?.kind === "merge" && (
        <VarorMergeSheet
          vara={openVara}
          candidates={catalogList.filter((c) => c.id !== openVara.item.id)}
          listName={listName}
          onMerge={(toItemId) => {
            actions.mergeVaror(
              openVara.item.id,
              toItemId,
              openVara.products.map((p) => p.id),
            );
            setSheet(null);
          }}
          onClose={() => setSheet({ kind: "vara", id: openVara.item.id })}
        />
      )}
    </div>
  );
}

/**
 * The vara rows themselves.
 *
 * A row says four things and stops: what it is called, how much hangs off it,
 * whether it is on the list right now, and what tapping it will do. The counts
 * are what make the second level discoverable at all — nothing else on the
 * screen hints that "mjölk" has three products under it.
 *
 * The whole row is the tap target, and shrinking it to the glyph at the end was
 * considered and rejected. The confusion this screen suffers from is not "where
 * do I tap" but "what happens when I do", and a 16px target answers the wrong
 * question at the cost of the right-sized one — while a mis-tap here is cheap
 * and reversible (a sheet opens, you close it), unlike a mis-tap on the list,
 * where the same picture and the same name mean *buy this*. That asymmetry is
 * the argument for keeping the row big and making the verb loud instead.
 *
 * So the glyph is a pencil rather than a chevron. A chevron is honest — this
 * does open a detail — but it is the app's most neutral mark, and neutrality is
 * precisely what failed: it says "there is more this way" on a screen whose
 * whole problem was that people could not tell adding from editing. The pencil
 * is the app's own mark for "this changes the thing", stated once per row at
 * the moment of the tap. The visually-hidden verb is its other half: the pencil
 * is aria-hidden decoration, so without it the promise exists only for people
 * who can see it.
 */
function VaraRows({
  varor,
  listName,
  onOpen,
}: {
  varor: VaraView[];
  listName: (listId: Id) => string;
  onOpen: (id: Id) => void;
}) {
  return (
    <ul className="divide-y divide-line">
      {varor.map((vara) => {
        const lists = [...new Set(vara.onList.map((e) => e.listId))];
        const facts = [
          vara.products.length > 0
            ? `${vara.products.length} ${
                vara.products.length === 1 ? "produkt" : "produkter"
              }`
            : null,
          vara.aliases.length > 0
            ? `även ${vara.aliases.map((a) => a.aliasNorm).join(", ")}`
            : null,
        ].filter(Boolean) as string[];

        return (
          <li key={vara.item.id}>
            <button
              type="button"
              onClick={() => onOpen(vara.item.id)}
              className="flex w-full items-center gap-3 py-2.5 text-left transition-transform duration-100 active:scale-[0.99]"
            >
              <span className="sr-only">Ändra</span>
              <ItemIcon iconRef={vara.item.iconRef} className="text-2xl" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-semibold text-ink">
                  {vara.item.name}
                </span>
                {facts.length > 0 && (
                  <span className="block truncate text-caption text-ink-faint">
                    {facts.join(" · ")}
                  </span>
                )}
              </span>

              {/* Hidden varor are listed here exactly like any other, marked
                  rather than filtered or gathered into a section of their own.
                  This screen is the household's whole vocabulary — that is what
                  it says it is at the top — and a word missing from it, or
                  exiled to the bottom, is a word nobody will think to look for
                  when they want it back. */}
              {vara.item.hidden && (
                <span className="flex-none rounded-full bg-surface-sunken px-2.5 py-1 text-caption font-semibold text-ink-faint">
                  dold
                </span>
              )}

              {/* The only green on this screen, and it means exactly what green
                  means everywhere else in the app: this is on the list. */}
              {lists.length > 0 && (
                <span
                  className={cn(
                    "flex-none rounded-full bg-brand-tint px-2.5 py-1",
                    "text-caption font-semibold text-brand-ink",
                  )}
                >
                  {lists.length === 1 ? listName(lists[0]) : "på listan"}
                </span>
              )}

              <UiIcon name="edit" size={16} className="flex-none text-ink-faint" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
