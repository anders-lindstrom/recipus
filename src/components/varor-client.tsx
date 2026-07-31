"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { nextOpTimestamp } from "@/lib/client/op-clock";
import { useList } from "@/lib/client/use-list";
import type { Category, Id, List } from "@/lib/domain";
import type { Op } from "@/lib/sync";
import { normalizeName, slugify } from "@/lib/utils";
import { VarorScreen, type VarorScreenActions } from "./varor-screen";
import { buildRegistry, mergeVaraOps, unplacedProducts } from "./varor-model";

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
  openVaraId?: Id | null;
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
  /**
   * A vara to open on arrival, from `?vara=` — how the list screen hands you
   * straight to the thing you long-pressed rather than to a screen of everything.
   */
  openVaraId?: Id | null;
  categories: Category[];
}

export function VarorClient({
  listId: serverListId,
  actor: serverActor,
  list: serverList,
  categories: serverCategories,
  openVaraId = null,
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

  /*
   * The registry's half of the same dead end — see the long note in
   * `list-client.tsx`, which this deliberately mirrors rather than restates.
   *
   * One thing is this screen's own: it is a sub-screen, so being stranded here
   * also means being stranded with no way back to the list. That is worth a link
   * even when the list is in the same state, because it lands you on the screen
   * that owns the problem rather than on the one that merely inherited it.
   */
  if (!listId || !list) {
    const unknownUser = !actor;
    return (
      <main className="grid min-h-dvh place-items-center p-6 text-center">
        <div className="max-w-xs">
          {/* A heading, for the same reason as on the list screen: this page has
              no header of its own, so the sentence naming the problem is the
              only thing a screen reader could navigate to. */}
          <h1 className="text-title text-ink">
            {unknownUser ? "Vi vet inte vem du är" : "Ingen lista än"}
          </h1>
          <p className="mt-2 text-body-sm text-ink-soft">
            {unknownUser
              ? "Sessionen kan ha gått ut, eller så saknades nätet första gången appen öppnades. Ladda om, så skickas du till inloggningen om det behövs."
              : "Registret hämtas genom en lista, och hushållet har ingen ännu."}
          </p>
          <div className="mt-5 flex flex-col items-stretch gap-2">
            <button
              type="button"
              onClick={() => location.reload()}
              className="inline-flex min-h-11 items-center justify-center rounded-control bg-brand px-4 text-body font-semibold text-on-brand"
            >
              Försök igen
            </button>
            <Link
              href="/"
              className="inline-flex min-h-11 items-center justify-center rounded-control border border-line px-4 text-body font-semibold text-ink-soft"
            >
              Till listan
            </Link>
          </div>
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
    /**
     * Each of these patches ONE fact, and that is not stylistic.
     *
     * `update_catalog_item` resolves every field against its own clock, so a
     * patch naming only the category leaves the name's clock untouched — two
     * people tidying the catalog on a Sunday can re-file and rename the same
     * vara without either edit outranking the other. Bundling unrelated fields
     * into one patch would throw that away for no gain.
     */
    recategorizeVara: (varaId: Id, categoryId: Id) => {
      const item = state.catalog[varaId];
      const from = categories.find((c) => c.id === item?.categoryId);
      const to = categories.find((c) => c.id === categoryId);

      /**
       * The icon follows the aisle, unless somebody chose one.
       *
       * Every category carries an icon, and a vara created from the add bar has
       * never had one picked for it — it simply inherited Övrigt's box. Re-filing
       * such a vara into Bröd and leaving it as a box would make the default per
       * category a fiction: correct at creation, wrong forever after.
       *
       * "Was never chosen" is detected as "still equal to the OLD category's
       * icon", which is exactly what inheriting means. An icon the household
       * actually picked differs from it and is left alone — re-filing must not
       * quietly undo a deliberate choice.
       *
       * Both facts in one patch, and that is not a contradiction of the
       * one-field rule below: this single act genuinely asserts both, so both
       * clocks should move. What the rule forbids is stamping a clock for a
       * field the act said nothing about.
       */
      const inherited = Boolean(from && item && item.iconRef === from.icon);
      dispatch({
        kind: "update_catalog_item",
        itemId: varaId,
        patch:
          inherited && to
            ? { categoryId, iconRef: to.icon }
            : { categoryId },
      });
    },

    setVaraIcon: (varaId: Id, iconRef: string) =>
      dispatch({
        kind: "update_catalog_item",
        itemId: varaId,
        patch: { iconRef },
      }),

    setHasAtHome: (varaId: Id, hasAtHome: boolean) =>
      dispatch({
        kind: "update_catalog_item",
        itemId: varaId,
        patch: { hasAtHome },
      }),

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
     * Merge: hand the whole plan to `mergeVaraOps` and dispatch it in order.
     *
     * The plan is pure and lives in `varor-model.ts` — the products it re-points,
     * the shopping it carries across to the survivor, and the tombstone last — so
     * that the cases worth arguing about can be asserted in a test instead of in
     * a browser. Ordering matters and `nextOpTimestamp` provides it: every op
     * here gets a strictly later clock than the one before, so the tombstone
     * cannot tie with the moves that have to precede it.
     */
    mergeVaror: (fromId, toId, productIds) => {
      for (const op of mergeVaraOps(state, fromId, toId, productIds)) {
        dispatch(op);
      }
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
      openVaraId={openVaraId}
      actions={actions}
    />
  );
}
