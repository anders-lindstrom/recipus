"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useList } from "@/lib/client/use-list";
import type { Op } from "@/lib/sync";
import type { Amount, Id, List } from "@/lib/domain";
import type { ListSnapshot } from "@/lib/services/list-data";
import { parseAmount } from "@/lib/units";
import { normalizeName, slugify } from "@/lib/utils";
import { ListScreen } from "./list-screen";
import { ListSwitcher } from "./list-switcher";
import { Scanner } from "./scanner";

/**
 * Wiring the list screen to the sync layer.
 *
 * Optimistic by construction: every action applies its op locally through the
 * same reducer the server runs, then posts it. The UI never waits on a round
 * trip, which is the whole point — a tap that waits is a tap that fails in a
 * shop.
 *
 * It also has to survive being opened with no server at all. The service worker
 * caches this shell, so the page that renders offline is whatever HTML was
 * cached — which cannot be an auth-gated server render, or a lapsed session
 * gets baked into the cache and served forever. So the shell is auth-agnostic:
 * it renders from IndexedDB and from a small "shell context" (list name,
 * category names) stashed in localStorage on each successful online load, and
 * treats being signed out as a banner rather than a different page.
 */

const SHELL_KEY = "recipus:shell";

/** The bits ListScreen needs that do not live in SyncState. */
interface ShellContext {
  listId: Id;
  actor: string;
  list: ListSnapshot["list"];
  categories: ListSnapshot["categories"];
  recipeTitles: Record<Id, string>;
}

function readShellContext(): ShellContext | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SHELL_KEY);
    return raw ? (JSON.parse(raw) as ShellContext) : null;
  } catch {
    return null;
  }
}

/**
 * An op minus the envelope this component fills in.
 *
 * The distribution over the union matters: a plain `Omit<Op, ...>` collapses the
 * twelve op variants into one intersection whose only shared keys are the
 * envelope's, so `listId` and friends stop existing.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type OpDraft = DistributiveOmit<Op, "clientOpId" | "actor" | "at">;

export interface ListClientProps {
  /** Null when the server could not authenticate — the client falls back to IndexedDB. */
  snapshot: ListSnapshot | null;
  /** Every list in the household, for the switcher. Empty when offline. */
  lists: List[];
  actor: string | null;
  members: Array<{ id: string; initials: string; color: string }>;
}

export function ListClient({ snapshot, lists, actor, members }: ListClientProps) {
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  // Read once, on first render, so the offline path has a list name and
  // category names before anything async resolves.
  const [cached] = useState<ShellContext | null>(() =>
    snapshot ? null : readShellContext(),
  );

  // Remember enough to render the shell next time the server is unreachable.
  useEffect(() => {
    if (!snapshot || !actor) return;
    try {
      const ctx: ShellContext = {
        listId: snapshot.list.id,
        actor,
        list: snapshot.list,
        categories: snapshot.categories,
        recipeTitles: snapshot.recipeTitles,
      };
      window.localStorage.setItem(SHELL_KEY, JSON.stringify(ctx));
    } catch {
      // A full or disabled localStorage costs offline chrome, nothing more.
    }
  }, [snapshot, actor]);

  const listId = snapshot?.list.id ?? cached?.listId ?? null;
  const effectiveActor = actor ?? cached?.actor ?? null;
  const list = snapshot?.list ?? cached?.list ?? null;
  const categories = snapshot?.categories ?? cached?.categories ?? [];
  const recipeTitles = snapshot?.recipeTitles ?? cached?.recipeTitles ?? {};

  // The store owns state, persistence and sync. It applies each op locally
  // before the network hears about it, keeps everything in IndexedDB, and
  // drains its outbox when a connection comes back — so the list opens and
  // works in a shop with no signal.
  const { state, status, dispatch: dispatchOp } = useList(
    listId ?? "__none__",
    effectiveActor ?? "__none__",
    snapshot ?? undefined,
  );

  // Titles come from the snapshot; scale factors from live state, so a recipe
  // added since hydration still labels its tiles correctly.
  const recipeAdditionInfo = useMemo(() => {
    const out: Record<Id, { recipeTitle: string; scaleFactor: number }> = {};
    for (const addition of Object.values(state.recipeAdditions)) {
      out[addition.id] = {
        recipeTitle: recipeTitles[addition.recipeId] ?? "Recept",
        scaleFactor: addition.scaleFactor,
      };
    }
    return out;
  }, [state.recipeAdditions, recipeTitles]);

  const dispatch = useCallback(
    (partial: OpDraft) => {
      const op = {
        ...partial,
        clientOpId: crypto.randomUUID(),
        actor: effectiveActor ?? "okand",
        at: new Date().toISOString(),
      } as Op;
      void dispatchOp(op).catch(() =>
        // A lapsed session is reported through status.signedOut, not thrown —
        // anything reaching here is a genuine failure worth surfacing.
        toast.error("Kunde inte spara ändringen"),
      );
    },
    [effectiveActor, dispatchOp],
  );


  // Nothing cached and no server: the very first launch has to happen with a
  // connection. Say so plainly instead of rendering an empty list that looks
  // like everything was lost.
  if (!list || !listId) {
    return (
      <main className="grid min-h-dvh place-items-center p-6 text-center">
        <div>
          <p className="text-base font-bold text-ink">Ingen lista sparad än</p>
          <p className="mt-2 text-sm text-ink-soft">
            Öppna Recipus en gång med täckning, så finns listan kvar i telefonen
            även utan nät.
          </p>
        </div>
      </main>
    );
  }

  const actions = {
    addItem: (catalogItemId: Id, amountText?: string) => {
      dispatch({ kind: "add_item", listId, catalogItemId });
      if (amountText) {
        const amount = parseAmount(amountText);
        if (amount) dispatch({ kind: "set_amount", listId, catalogItemId, amount });
      }
    },
    removeItem: (catalogItemId: Id, bought: boolean) =>
      dispatch({ kind: "remove_item", listId, catalogItemId, bought }),
    setAmount: (catalogItemId: Id, amount: Amount | null) =>
      dispatch({ kind: "set_amount", listId, catalogItemId, amount }),
    createItem: (name: string, amountText: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const id = slugify(trimmed);
      dispatch({
        kind: "create_catalog_item",
        item: {
          id,
          name: trimmed,
          nameNorm: normalizeName(trimmed),
          // Unsorted until you say otherwise — better than guessing an aisle
          // and sending you to the wrong end of the shop.
          categoryId: "ovrigt",
          iconRef: "1F4E6",
          isCustom: true,
          hasAtHome: false,
          useCount: 0,
          lastUsedAt: null,
        },
      });
      actions.addItem(id, amountText);
    },
    removeRecipe: (recipeAdditionId: Id) =>
      dispatch({ kind: "remove_recipe", listId, recipeAdditionId }),
    openScanner: () => {
      setScanResult(null);
      setScanning(true);
    },
    switchList: () => setSwitching(true),
  };

  async function handleScan(ean: string) {
    try {
      const res = await fetch(`/api/barcode/${encodeURIComponent(ean)}`);
      if (!res.ok) {
        setScanResult(`Okänd streckkod ${ean}`);
        return;
      }
      const { catalogItemId, productName } = await res.json();
      if (!catalogItemId) {
        setScanResult(productName ? `${productName} — välj vara` : "Välj vara");
        return;
      }

      const item = state.catalog[catalogItemId];
      const entry = state.entries[`${listId}:${catalogItemId}`];
      // Bidirectional, acting on the list you currently have open: already on
      // it means you just picked it up, otherwise you just ran out.
      if (entry && entry.removedAt === null) {
        actions.removeItem(catalogItemId, true);
        setScanResult(`${item?.name ?? "Varan"} avbockad`);
      } else {
        actions.addItem(catalogItemId);
        setScanResult(`${item?.name ?? "Varan"} tillagd`);
      }
    } catch {
      setScanResult("Kunde inte slå upp streckkoden");
    }
  }

  return (
    <>
      <ListScreen
        list={list}
        categories={categories}
        catalog={Object.values(state.catalog)}
        entries={Object.values(state.entries)}
        contributions={Object.values(state.contributions)}
        recipeAdditions={recipeAdditionInfo}
        suggestions={snapshot?.suggestions ?? []}
        members={members}
        sync={{
          online: status.online,
          pendingCount: status.pendingCount,
          signedOut: status.signedOut,
        }}
        onReauthenticate={() => location.reload()}
        actions={actions}
      />
      {switching && (
        <ListSwitcher
          // Offline the server sent no lists, but the one you are looking at is
          // always a valid choice — better than an empty sheet.
          lists={lists.length ? lists : [list]}
          currentId={listId}
          onSelect={(id) => {
            setSwitching(false);
            if (id !== listId) window.location.href = `/?list=${encodeURIComponent(id)}`;
          }}
          onCreate={(name) => {
            const id = slugify(name);
            dispatch({
              kind: "create_list",
              listId: id,
              name,
              icon: "1F6D2",
              position: lists.length,
              categoryOrder: list.categoryOrder,
            });
            setSwitching(false);
            window.location.href = `/?list=${encodeURIComponent(id)}`;
          }}
          onClose={() => setSwitching(false)}
        />
      )}
      {scanning && (
        <Scanner
          onScan={handleScan}
          onClose={() => setScanning(false)}
          lastResult={scanResult}
        />
      )}
    </>
  );
}
