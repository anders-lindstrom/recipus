"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { nextOpTimestamp } from "@/lib/client/op-clock";
import { useList } from "@/lib/client/use-list";
import type { Category, Id, List } from "@/lib/domain";
import type { Op } from "@/lib/sync";
import { normalizeName, slugify } from "@/lib/utils";
import { VarorScreen, type VarorScreenActions } from "./varor-screen";
import { buildRegistry, unplacedProducts } from "./varor-model";

/**
 * Wiring the registry screen to the sync layer.
 *
 * Every edit here is an ordinary op through the ordinary outbox, applied
 * optimistically by the same reducer the server runs. That is not a convenience:
 * unknown barcodes are met in a shop, offline, and the registry rides the op log
 * precisely so those are queued rather than dropped. Curating the result then
 * comes along for free — this screen renders entirely from `SyncState`, with no
 * endpoint of its own, and so it works with no signal.
 *
 * It deliberately does NOT hydrate from a server snapshot the way the list screen
 * does. `applySnapshot` rebuilds state wholesale from `emptyState()`, so passing
 * one here would mean a walk to this screen could wipe locally-known registry
 * rows the snapshot does not yet carry. The store's own `connect()` does the
 * right thing unaided: catch up over `/api/ops` when this device has hydrated
 * before, and bootstrap a full snapshot when it has not.
 */

/**
 * Written by `list-client.tsx` on every successful online load.
 *
 * Read rather than re-fetched so this screen has a list id and an actor when the
 * server is unreachable — the shell that renders offline is whatever the service
 * worker cached, which cannot be an auth-gated render. Only the two fields this
 * screen needs are picked out; the rest of the cached object is the list
 * screen's business.
 */
const SHELL_KEY = "recipus:shell";

interface CachedShell {
  listId: Id;
  actor: string;
  list: List;
  categories: Category[];
}

function readShell(): Partial<CachedShell> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SHELL_KEY);
    return raw ? (JSON.parse(raw) as Partial<CachedShell>) : {};
  } catch {
    return {};
  }
}

/**
 * An op minus the envelope this component fills in.
 *
 * Distributed over the union on purpose: a plain `Omit<Op, ...>` collapses the
 * variants into one intersection whose only shared keys are the envelope's, and
 * `patch` and friends stop existing.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type OpDraft = DistributiveOmit<Op, "clientOpId" | "actor" | "at">;

export interface VarorClientProps {
  /** Null when the server could not authenticate; the cached shell fills in. */
  listId: Id | null;
  actor: string | null;
  list: List | null;
  categories: Category[];
}

export function VarorClient({
  listId: serverListId,
  actor: serverActor,
  list: serverList,
  categories: serverCategories,
}: VarorClientProps) {
  // Read once, on first render, so the offline path has a list id before
  // anything async resolves.
  const [cached] = useState<Partial<CachedShell>>(() =>
    serverListId ? {} : readShell(),
  );

  const listId = serverListId ?? cached.listId ?? null;
  const actor = serverActor ?? cached.actor ?? null;
  const list = serverList ?? cached.list ?? null;
  const categories = serverCategories.length
    ? serverCategories
    : (cached.categories ?? []);

  const { state, status, dispatch: dispatchOp } = useList(
    listId ?? "__none__",
    actor ?? "__none__",
  );

  /**
   * Strictly increasing per session — see `nextOpTimestamp`.
   *
   * It matters more here than almost anywhere else: a split and a merge each
   * dispatch several ops in one tick, and two ops sharing a timestamp cannot be
   * ordered by last-write-wins, so the second silently loses. A merge whose
   * `update_product` tied with its own `merge_catalog_items` would leave the
   * products behind on a tombstoned vara.
   */
  const lastAt = useRef<string | null>(null);

  const dispatch = useCallback(
    (partial: OpDraft): void => {
      const at = nextOpTimestamp(lastAt.current, new Date());
      lastAt.current = at;
      const op = {
        ...partial,
        clientOpId: crypto.randomUUID(),
        actor: actor ?? "okand",
        at,
      } as Op;
      void dispatchOp(op).catch(() => toast.error("Kunde inte spara ändringen"));
    },
    [actor, dispatchOp],
  );

  const varor = useMemo(() => buildRegistry(state), [state]);
  const queue = useMemo(() => unplacedProducts(state), [state]);

  const listName = useCallback(
    // The store holds the lists it has heard of, which offline may be only this
    // one. Falling back to the id keeps the copy honest rather than blank.
    (id: Id) => state.lists[id]?.name ?? id,
    [state.lists],
  );

  if (!listId || !list) {
    return (
      <main className="grid min-h-dvh place-items-center p-6 text-center">
        <div>
          <p className="text-base font-bold text-ink">Inga varor sparade än</p>
          <p className="mt-2 text-sm text-ink-soft">
            Öppna Recipus en gång med täckning, så finns katalogen kvar i
            telefonen även utan nät.
          </p>
        </div>
      </main>
    );
  }

  const actions: VarorScreenActions = {
    /**
     * The review queue's whole job, and a one-op change.
     *
     * `catalogItemId` is the product's mapping to a vara, and it has its own
     * clock so that placing one does not disturb a concurrent correction to its
     * name or brand. Null puts it back in the queue, which is the same op —
     * placing has to be reversible, because an auto-map is a guess.
     */
    placeProduct: (productId, catalogItemId) =>
      dispatch({ kind: "update_product", productId, patch: { catalogItemId } }),

    createVaraAndPlace: (productId, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const id = slugify(trimmed);
      dispatch({
        kind: "create_catalog_item",
        item: {
          id,
          name: trimmed,
          nameNorm: normalizeName(trimmed),
          // Unsorted until somebody says otherwise, exactly as the add bar does
          // it — guessing an aisle sends you to the wrong end of the shop.
          categoryId: "ovrigt",
          iconRef: "1F4E6",
          isCustom: true,
          hasAtHome: false,
          useCount: 0,
          lastUsedAt: null,
        },
      });
      dispatch({
        kind: "update_product",
        productId,
        patch: { catalogItemId: id },
      });
    },

    /**
     * A rename carries `nameNorm` with it, always.
     *
     * They are one fact in two columns and the reducer moves both clocks
     * together; sending only the display name would leave search and recipe
     * matching comparing against the old word — the vara would be renamed
     * everywhere except in the one place that decides whether a recipe line
     * finds it.
     */
    renameVara: (varaId, name) =>
      dispatch({
        kind: "update_catalog_item",
        itemId: varaId,
        patch: { name, nameNorm: normalizeName(name) },
      }),

    /**
     * Split: a new vara, then the products the human ticked. No third op kind.
     *
     * The new vara inherits the source's aisle and icon, because a split is a
     * refinement of one word rather than an unrelated new one — "osaltat smör"
     * belongs on the butter shelf with the butter picture. The source vara stays
     * exactly as it was; only the ticked products move.
     */
    splitVara: (varaId, newName, productIds) => {
      const source = state.catalog[varaId];
      if (!source) return;
      const id = slugify(newName);
      dispatch({
        kind: "create_catalog_item",
        item: {
          id,
          name: newName,
          nameNorm: normalizeName(newName),
          categoryId: source.categoryId,
          iconRef: source.iconRef,
          isCustom: true,
          hasAtHome: false,
          useCount: 0,
          lastUsedAt: null,
        },
      });
      for (const productId of productIds) {
        dispatch({
          kind: "update_product",
          productId,
          patch: { catalogItemId: id },
        });
      }
    },

    /**
     * Merge: move the products across FIRST, then tombstone the word.
     *
     * The reducer's merge case only tombstones and records the alias — it must
     * never rewrite rows, or the merge stops converging. So re-pointing the
     * products is the caller's job, dispatched as ordinary `update_product` ops
     * exactly as the split does. Leaving them behind would strand them on a
     * tombstoned vara: not in the queue, not under any word, invisible on this
     * screen entirely — a worse outcome than the duplicate the merge came to fix.
     *
     * `aliasNorm` is the merged-away vara's own `nameNorm`, which is the string
     * `matchIngredient` compares against. It is what keeps every recipe line
     * already written against the old word resolving afterwards.
     */
    mergeVaror: (fromId, toId, productIds) => {
      const from = state.catalog[fromId];
      if (!from) return;
      for (const productId of productIds) {
        dispatch({
          kind: "update_product",
          productId,
          patch: { catalogItemId: toId },
        });
      }
      dispatch({
        kind: "merge_catalog_items",
        fromItemId: fromId,
        toItemId: toId,
        aliasNorm: from.nameNorm,
      });
    },

    deleteVara: (varaId) =>
      dispatch({ kind: "delete_catalog_item", itemId: varaId }),

    /**
     * `bought: false`, always, and the reason is the whole point of this screen
     * keeping its hands off the shopping list.
     *
     * Taking something off a list from the registry is administration, not a
     * shop. Recording it as a purchase would teach the cadence engine that you
     * buy this every time you tidy your taxonomy.
     */
    takeOffList: (targetListId, catalogItemId) =>
      dispatch({
        kind: "remove_item",
        listId: targetListId,
        catalogItemId,
        bought: false,
      }),
  };

  return (
    <VarorScreen
      varor={varor}
      queue={queue}
      catalog={state.catalog}
      categories={categories}
      categoryOrder={list.categoryOrder}
      listName={listName}
      sync={{ online: status.online, pendingCount: status.pendingCount }}
      actions={actions}
    />
  );
}
