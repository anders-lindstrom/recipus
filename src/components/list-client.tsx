"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useList } from "@/lib/client/use-list";
import { useMode } from "@/lib/client/use-mode";
import { nextOpTimestamp } from "@/lib/client/op-clock";
import { scanAction } from "@/lib/client/scan-action";
import type { Op } from "@/lib/sync";
import {
  entryId,
  manualContributionId,
  type Amount,
  type Id,
  type List,
  type Priority,
} from "@/lib/domain";
import type { ListSnapshot } from "@/lib/services/list-data";
import { parseAmount } from "@/lib/units";
import { normalizeName, slugify } from "@/lib/utils";
import { ListScreen } from "./list-screen";
import { ListSwitcher } from "./list-switcher";
import { Scanner, type ScanOutcome } from "./scanner";

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
  const [scanResult, setScanResult] = useState<ScanOutcome | null>(null);
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
  // Memoised, not a bare `?? {}`: that allocates a fresh object every render,
  // so the useMemo below would recompute on every render and never memoise
  // anything.
  const recipeTitles = useMemo(
    () => snapshot?.recipeTitles ?? cached?.recipeTitles ?? {},
    [snapshot?.recipeTitles, cached?.recipeTitles],
  );

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

  /**
   * Strictly increasing per session — see `nextOpTimestamp`. Two ops sharing a
   * timestamp cannot be ordered by last-write-wins, so the second silently loses.
   */
  const lastAt = useRef<string | null>(null);

  /** Returns the op's `clientOpId`, which undo needs to name what it retracts. */
  const dispatch = useCallback(
    (partial: OpDraft): string => {
      const clientOpId = crypto.randomUUID();
      const at = nextOpTimestamp(lastAt.current, new Date());
      lastAt.current = at;
      const op = {
        ...partial,
        clientOpId,
        actor: effectiveActor ?? "okand",
        at,
      } as Op;
      void dispatchOp(op).catch(() =>
        // A lapsed session is reported through status.signedOut, not thrown —
        // anything reaching here is a genuine failure worth surfacing.
        toast.error("Kunde inte spara ändringen"),
      );
      return clientOpId;
    },
    [effectiveActor, dispatchOp],
  );

  // Device-local, never synced and never an op: one of you is in the shop while
  // the other plans at home, so a shared mode would make the planner's taps
  // write purchases. See lib/client/use-mode.ts for the full argument.
  const { mode, setMode, touch } = useMode();

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
    addItem: (catalogItemId: Id, amountText?: string, undoesClientOpId?: string) => {
      dispatch({ kind: "add_item", listId, catalogItemId, undoesClientOpId });
      if (amountText) {
        const amount = parseAmount(amountText);
        if (amount) dispatch({ kind: "set_amount", listId, catalogItemId, amount });
      }
    },
    removeItem: (catalogItemId: Id, bought: boolean) => {
      // Buy mode's idle clock measures shopping, not staring at the screen, so
      // it is a removal that counts as activity — not a render or a scroll.
      if (bought) touch();
      return dispatch({ kind: "remove_item", listId, catalogItemId, bought });
    },
    setAmount: (catalogItemId: Id, amount: Amount | null) =>
      dispatch({ kind: "set_amount", listId, catalogItemId, amount }),
    setModifier: (catalogItemId: Id, modifier: string | null) =>
      dispatch({ kind: "set_modifier", listId, catalogItemId, modifier }),
    setPriority: (catalogItemId: Id, priority: Priority) =>
      dispatch({ kind: "set_priority", listId, catalogItemId, priority }),
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
    /**
     * The payload is read out of the store HERE, not in the reducer.
     *
     * `move_item` carries what it moves — priority, and the manual
     * amount/note/modifier — because a reducer that read the source instead
     * could not be order-independent, and two phones would settle on different
     * amounts at the destination. See the op's own comment. This is the one
     * place that read happens, on the device that is actually looking at the
     * item.
     */
    moveItem: (catalogItemId: Id, toListId: Id) => {
      const eid = entryId(listId, catalogItemId);
      const entry = state.entries[eid];
      const manual = state.contributions[manualContributionId(eid)];
      dispatch({
        kind: "move_item",
        fromListId: listId,
        toListId,
        catalogItemId,
        priority: entry?.priority ?? "normal",
        // Null when there is nothing of your own to take — which is different
        // from "all three fields are empty", and the reducer treats it as such:
        // it makes no claim about those fields at either end.
        manual: manual
          ? {
              amount: manual.amount,
              note: manual.note,
              modifier: manual.modifier,
            }
          : null,
      });
    },
    /**
     * Fire-and-forget, and deliberately not through the outbox.
     *
     * A dismissal cannot conflict — the server key is (item, day) — so it needs
     * neither an op nor last-write-wins. The screen has already hidden the tile
     * by the time this runs, so a failure costs nothing visible now: the
     * suggestion simply comes back after the next hydrate. Worth no toast, since
     * the user's instruction was "not this time", not "record this forever".
     */
    dismissSuggestion: (catalogItemId: Id) => {
      void fetch("/api/suggestions/dismissals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catalogItemId }),
      }).catch(() => {});
    },
    restoreSuggestion: (catalogItemId: Id) => {
      void fetch(
        `/api/suggestions/dismissals/${encodeURIComponent(catalogItemId)}`,
        { method: "DELETE" },
      ).catch(() => {});
    },
    openScanner: () => {
      setScanResult(null);
      setScanning(true);
    },
    switchList: () => setSwitching(true),
  };

  async function handleScan(ean: string) {
    // `listId` is guaranteed by the guard above, but this function is hoisted
    // out of that narrowing. The old code interpolated the id by hand, which
    // accepted null and would have produced a "null:banan" key; deriving it with
    // `entryId` closes the last place in the codebase that built an entry id
    // itself, at the cost of this one honest guard.
    if (!listId) return;
    try {
      const res = await fetch(`/api/barcode/${encodeURIComponent(ean)}`);
      if (!res.ok) {
        setScanResult({ text: `Okänd streckkod ${ean}` });
        return;
      }
      const { catalogItemId, productName } = await res.json();
      if (!catalogItemId) {
        setScanResult({
          text: productName ? `${productName} — välj vara` : "Välj vara",
        });
        return;
      }

      const item = state.catalog[catalogItemId];
      const name = item?.name ?? "Varan";
      const entry = state.entries[entryId(listId, catalogItemId)];
      const onList = Boolean(entry && entry.removedAt === null);

      // Which of the four things a scan means lives in `scanAction`, tested
      // there. This only turns the decision into ops and Swedish.
      switch (scanAction(mode, onList).kind) {
        case "buy": {
          const clientOpId = actions.removeItem(catalogItemId, true);
          setScanResult({
            text: `${name} köpt`,
            undo: () => {
              actions.addItem(catalogItemId, undefined, clientOpId);
              setScanResult({ text: `${name} tillbaka på listan` });
            },
          });
          return;
        }

        case "add_and_buy": {
          actions.addItem(catalogItemId);
          const clientOpId = actions.removeItem(catalogItemId, true);
          setScanResult({
            text: `${name} tillagd och köpt`,
            undo: () => {
              // Two halves: put it back so the purchase can be retracted against
              // the op that wrote it, then take it off again WITHOUT recording a
              // purchase — landing back where you were before the scan.
              actions.addItem(catalogItemId, undefined, clientOpId);
              actions.removeItem(catalogItemId, false);
              setScanResult({ text: `${name} ångrad` });
            },
          });
          return;
        }

        case "already_on_list": {
          // No op, and so no undo: there is nothing to take back. Saying so is
          // still worth a line — otherwise a scan that changed nothing looks
          // identical to one the camera never read.
          setScanResult({ text: `${name} finns redan på listan` });
          return;
        }

        case "add": {
          actions.addItem(catalogItemId);
          setScanResult({
            text: `${name} tillagd`,
            undo: () => {
              actions.removeItem(catalogItemId, false);
              setScanResult({ text: `${name} borttagen igen` });
            },
          });
          return;
        }
      }
    } catch {
      setScanResult({ text: "Kunde inte slå upp streckkoden" });
    }
  }

  return (
    <>
      <ListScreen
        list={list}
        // Offline the server sent no lists; the one you are on is still a valid
        // (and the only sensible) choice, matching the switcher's own fallback.
        lists={lists.length ? lists : [list]}
        categories={categories}
        catalog={Object.values(state.catalog)}
        // Filtered to this list, which matters only because of `move_item`: it
        // is the one op that writes an entry belonging to a DIFFERENT list, and
        // that entry is live. Unfiltered, moving an item left it sitting on the
        // source list exactly as before — a move that looked like it had done
        // nothing at all.
        entries={Object.values(state.entries).filter((e) => e.listId === listId)}
        contributions={Object.values(state.contributions)}
        recipeAdditions={recipeAdditionInfo}
        suggestions={snapshot?.suggestions ?? []}
        members={members}
        mode={mode}
        onModeChange={setMode}
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
