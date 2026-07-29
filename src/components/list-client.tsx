"use client";

import { useCallback, useState, useTransition } from "react";
import { toast } from "sonner";
import { submitOps } from "@/app/(app)/actions";
import {
  applyOps,
  type Op,
} from "@/lib/sync";
import {
  emptyState,
  type Amount,
  type Id,
  type SyncState,
} from "@/lib/domain";
import type { ListSnapshot } from "@/lib/services/list-data";
import { parseAmount } from "@/lib/units";
import { normalizeName, slugify } from "@/lib/utils";
import { ListScreen } from "./list-screen";
import { Scanner } from "./scanner";

/**
 * Wiring the list screen to the sync layer.
 *
 * Optimistic by construction: every action applies its op locally through the
 * same reducer the server runs, then posts it. The UI never waits on a round
 * trip, which is the whole point — a tap that waits is a tap that fails in a
 * shop.
 *
 * This holds state in memory. The IndexedDB-backed store replaces it without
 * touching this file's shape: same ops, same reducer, same optimistic timing —
 * it just survives a reload and a dead network too.
 */

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

function hydrate(snapshot: ListSnapshot): SyncState {
  const state = emptyState();
  state.lists[snapshot.list.id] = snapshot.list;
  for (const c of snapshot.catalog) state.catalog[c.id] = c;
  for (const e of snapshot.entries) {
    state.entries[e.id] = e;
    state.meta[`entry:${e.id}`] = { at: e.updatedAt, by: e.updatedBy };
  }
  for (const c of snapshot.contributions) state.contributions[c.id] = c;
  return state;
}

export interface ListClientProps {
  snapshot: ListSnapshot;
  actor: string;
  members: Array<{ id: string; initials: string; color: string }>;
}

export function ListClient({ snapshot, actor, members }: ListClientProps) {
  const [state, setState] = useState<SyncState>(() => hydrate(snapshot));
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [pending, setPending] = useState(0);
  const [, startTransition] = useTransition();

  const dispatch = useCallback(
    (partial: OpDraft) => {
      const op = {
        ...partial,
        clientOpId: crypto.randomUUID(),
        actor,
        at: new Date().toISOString(),
      } as Op;

      // Local first, always. The network is a detail that happens afterwards.
      setState((prev) => applyOps(prev, [op]));
      setPending((n) => n + 1);

      startTransition(async () => {
        try {
          await submitOps([op]);
          setSignedOut(false);
        } catch (err) {
          // A lapsed Authelia session must never cost you the list. Flag it,
          // keep the local state, and let the banner offer a way back.
          const message = err instanceof Error ? err.message : String(err);
          if (/401|unauthor|auth/i.test(message)) setSignedOut(true);
          else toast.error("Kunde inte synka ändringen");
        } finally {
          setPending((n) => Math.max(0, n - 1));
        }
      });
    },
    [actor],
  );

  const listId = snapshot.list.id;

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
    switchList: () => toast("Fler listor kommer i nästa steg"),
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
        list={snapshot.list}
        categories={snapshot.categories}
        catalog={Object.values(state.catalog)}
        entries={Object.values(state.entries)}
        contributions={Object.values(state.contributions)}
        recipeAdditions={snapshot.recipeAdditions}
        suggestions={snapshot.suggestions}
        members={members}
        sync={{ online: true, pendingCount: pending, signedOut }}
        onReauthenticate={() => location.reload()}
        actions={actions}
      />
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
