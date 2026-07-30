"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  Amount,
  CatalogItem,
  Category,
  Contribution,
  Id,
  List,
  ListEntry,
} from "@/lib/domain";
import {
  activeEntries,
  buildEntryView,
  groupByCategory,
  shouldGroupByAisle,
  type EntryView,
  type RecipeAdditionInfo,
} from "@/lib/services/entries";
import { useSustained } from "@/lib/client/use-sustained";
import { AddBar, type AddBarHandle } from "./add-bar";
import { AisleRail } from "./aisle-rail";
import { EntrySheet } from "./entry-sheet";
import { ItemTile, SectionHeading, TileGrid } from "./item-tile";
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
   */
  addItem: (catalogItemId: Id, amountText?: string) => void;
  /** `bought` false means "changed my mind" and must not record a purchase. */
  removeItem: (catalogItemId: Id, bought: boolean) => void;
  setAmount: (catalogItemId: Id, amount: Amount | null) => void;
  createItem: (name: string, amountText: string) => void;
  removeRecipe: (recipeAdditionId: Id) => void;
  openScanner: () => void;
  switchList: () => void;
}

export interface ListScreenProps {
  list: List;
  categories: Category[];
  catalog: CatalogItem[];
  entries: ListEntry[];
  contributions: Contribution[];
  recipeAdditions: Record<Id, RecipeAdditionInfo>;
  suggestions: Array<{ catalogItemId: Id; reason: string }>;
  members: Array<{ id: string; initials: string; color: string }>;
  sync: { online: boolean; pendingCount: number; signedOut: boolean };
  onReauthenticate?: () => void;
  actions: ListScreenActions;
}

export function ListScreen({
  list,
  categories,
  catalog,
  entries,
  contributions,
  recipeAdditions,
  suggestions,
  members,
  sync,
  onReauthenticate,
  actions,
}: ListScreenProps) {
  const [openEntry, setOpenEntry] = useState<Id | null>(null);
  const addBar = useRef<AddBarHandle>(null);

  // Ops normally drain in tens of milliseconds. Only say anything once one has
  // been waiting long enough that the delay is the story.
  const syncIsSlow = useSustained(sync.pendingCount > 0, {
    delayMs: 1200,
    dwellMs: 900,
  });

  const byId = useMemo(
    () => new Map(catalog.map((c) => [c.id, c])),
    [catalog],
  );
  const live = useMemo(() => activeEntries(entries), [entries]);
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

  function tapOnList(item: CatalogItem) {
    actions.removeItem(item.id, true);
    toast(`${item.name} köpt`, {
      action: {
        label: "Ångra",
        // Undo re-adds. The item is also sitting right below in its category,
        // so this is belt and braces rather than the only way back.
        onClick: () => actions.addItem(item.id),
      },
    });
  }

  const grouped = shouldGroupByAisle(live.length);

  const toBuyTiles = live
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

  const focusSearch = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    addBar.current?.focus();
  }, []);

  const openItem = openEntry ? byId.get(openEntry) : undefined;
  const openView = openEntry ? views.get(openEntry) : undefined;

  return (
    <div className="min-h-dvh pb-28">
      {/* Opaque, not frosted. A translucent bar let high-contrast tile labels
          ghost through it in dark mode, and `backdrop-filter` on a bar pinned
          over a 341-tile scroller costs a GPU repaint every frame on exactly
          the hardware this has to stay smooth on. */}
      <header className="safe-top sticky top-0 z-30 border-b border-line bg-surface">
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

          {/* The only way into the recipe screens. Everything else up here is
              about the list you are standing in front of, so recipes get one
              quiet icon rather than a nav bar competing with the tiles. */}
          <Link
            href="/recept"
            aria-label="Recept"
            className="ml-1.5 flex h-9 w-9 items-center justify-center rounded-full text-ink-soft"
          >
            <UiIcon name="recipes" size={20} />
          </Link>
        </div>

        {/* Only ever appears when there is something to say. Never a modal,
            never a spinner over the list.

            "Something to say" excludes an op that is merely in flight — see
            `useSustained`. Being offline or signed out shows at once, because
            those are states you stay in rather than blips: the banner appears
            once and the list settles under it. */}
        {(sync.signedOut || !sync.online || syncIsSlow) && (
          <div className="flex items-center gap-2 border-t border-line bg-warn-tint px-3 py-1.5 text-caption text-warn">
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
      </header>

      <div className="px-3">
        <AddBar
          ref={addBar}
          catalog={catalog}
          onListItemIds={onListIds}
          onPick={(itemId, amountText) => actions.addItem(itemId, amountText)}
          onCreate={actions.createItem}
        />

        <SectionHeading count={live.length > 0 ? live.length : undefined}>
          Att handla
        </SectionHeading>

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

        {suggestions.length > 0 && (
          <>
            <SectionHeading tone="warn">Föreslås</SectionHeading>
            <TileGrid>
              {suggestions.map((s) => {
                const item = byId.get(s.catalogItemId);
                if (!item) return null;
                return (
                  <ItemTile
                    key={item.id}
                    name={item.name}
                    iconRef={item.iconRef}
                    reason={s.reason}
                    onTap={() => actions.addItem(item.id)}
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
        <AisleRail aisles={aisles} onSearch={focusSearch} />

        {catalogByCategory.map((group) => (
          <div key={group.categoryId}>
            <SectionHeading id={`aisle-${group.categoryId}`} tone="brand">
              {categoryName.get(group.categoryId) ?? "Övrigt"}
            </SectionHeading>
            <TileGrid>
              {group.items.map((item) => (
                <ItemTile
                  key={item.id}
                  name={item.name}
                  iconRef={item.iconRef}
                  onTap={() => actions.addItem(item.id)}
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

      {openItem && openView && (
        <EntrySheet
          itemName={openItem.name}
          view={openView}
          onClose={() => setOpenEntry(null)}
          onEditAmount={() => setOpenEntry(null)}
          onRemoveRecipe={(id) => {
            actions.removeRecipe(id);
            setOpenEntry(null);
          }}
          onRemoveWithoutBuying={() => {
            actions.removeItem(openItem.id, false);
            setOpenEntry(null);
          }}
        />
      )}
    </div>
  );
}
