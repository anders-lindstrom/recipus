"use client";

import { useMemo, useState } from "react";
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
import { AddBar } from "./add-bar";
import { EntrySheet } from "./entry-sheet";
import { ItemTile, SectionHeading, TileGrid } from "./item-tile";

/**
 * The list screen.
 *
 * Two zones: what you need to buy, and everything you ever buy. There are no
 * checkboxes — an item is on the list or it isn't, and one tap moves it between
 * the two. That is the entire core loop, and its speed is the product.
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

  const openItem = openEntry ? byId.get(openEntry) : undefined;
  const openView = openEntry ? views.get(openEntry) : undefined;

  return (
    <div className="min-h-dvh pb-24">
      <header className="safe-top sticky top-0 z-30 bg-brand text-white">
        <div className="flex items-center gap-2 px-4 py-3">
          <button
            type="button"
            onClick={actions.switchList}
            className="flex items-center gap-1.5"
          >
            <span className="text-[16.5px] font-bold tracking-tight">
              {list.name}
            </span>
            <span aria-hidden className="text-[11px] opacity-75">
              ▼
            </span>
          </button>
          <div className="flex-1" />
          {members.map((m) => (
            <span
              key={m.id}
              title={m.id}
              className="-ml-1.5 flex h-[23px] w-[23px] items-center justify-center rounded-full border-[1.5px] border-brand text-[10px] font-bold text-white"
              style={{ background: m.color }}
            >
              {m.initials}
            </span>
          ))}
        </div>

        {/* Only ever appears when there is something to say. Never a modal,
            never a spinner over the list. */}
        {(sync.signedOut || !sync.online || sync.pendingCount > 0) && (
          <div className="flex items-center gap-2 bg-black/20 px-4 py-1.5 text-[11.5px]">
            {sync.signedOut ? (
              <>
                <span className="flex-1">Inloggningen har gått ut</span>
                <button
                  type="button"
                  onClick={onReauthenticate}
                  className="font-bold underline"
                >
                  Logga in igen
                </button>
              </>
            ) : (
              <span>
                {sync.online ? "Synkar" : "Offline"}
                {sync.pendingCount > 0 &&
                  ` · ${sync.pendingCount} ändringar väntar`}
              </span>
            )}
          </div>
        )}
      </header>

      <AddBar
        catalog={catalog}
        onListItemIds={onListIds}
        onPick={(itemId, amountText) => actions.addItem(itemId, amountText)}
        onCreate={actions.createItem}
      />

      <section className="px-3">
        <SectionHeading count={live.length}>Att handla</SectionHeading>

        {live.length === 0 ? (
          <p className="px-1 py-6 text-center text-[13px] text-ink-faint">
            Listan är tom. Sök eller tryck på en vara nedan.
          </p>
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

        {catalogByCategory.map((group) => (
          <div key={group.categoryId}>
            <SectionHeading tone="brand">
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
        className="safe-bottom fixed right-4 bottom-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-brand text-xl text-white shadow-lg"
      >
        ▣
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
