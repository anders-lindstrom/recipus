import { emptyState, type Id, type SyncState } from "@/lib/domain";
import { applyOp, applyOps, type Op } from "@/lib/sync";
import type { ListSnapshot } from "@/lib/services/list-data";
import { loadMeta, loadState, saveMeta, saveState, type SyncMeta } from "./db";
import * as outbox from "./outbox";

/**
 * The client-side state machine for one list.
 *
 * This is what makes the app usable in a shop with no signal: every mutation
 * applies to `state` synchronously, in memory, before anything asks the
 * network for permission. The network is something this module tries to
 * reach — never something the UI waits on.
 */

export interface StoreStatus {
  online: boolean;
  pendingCount: number;
  signedOut: boolean;
}

export interface ListStore {
  getState(): SyncState;
  subscribe(fn: () => void): () => void;
  /** Optimistic: apply, persist, enqueue, try to flush. Never awaits the network. */
  dispatch(op: Op): Promise<void>;
  hydrate(snapshot: ListSnapshot): Promise<void>;
  connect(): void;
  disconnect(): void;
  status(): StoreStatus;
  /**
   * Resolves once persisted local state (if any) has loaded from IndexedDB.
   * Not part of the original interface sketch, added because every other
   * method needs to await this internally anyway, and tests need a way to
   * observe "loaded" without reaching into internals.
   */
  ready(): Promise<void>;
}

export interface EventSourceLike {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export interface ListStoreDeps {
  /** Injected so tests never touch the real network. */
  fetch?: typeof fetch;
  /** Injected so tests can drive and observe SSE without a real connection. */
  createEventSource?: (url: string) => EventSourceLike;
}

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Must match reducer.ts's private `entryKey` exactly (`entry:<id>`) — that
 * module doesn't export its key helpers. Duplicated here on purpose; if
 * reducer.ts's format ever changes, this has to change with it.
 */
const entryMetaKey = (id: Id): string => `entry:${id}`;

class AutheliaLapseError extends Error {
  constructor() {
    super("Authelia session lapsed");
    this.name = "AutheliaLapseError";
  }
}

function isOnline(): boolean {
  if (typeof navigator === "undefined" || !("onLine" in navigator)) return true;
  return navigator.onLine;
}

function defaultCreateEventSource(url: string): EventSourceLike {
  if (typeof EventSource === "undefined") {
    throw new Error("EventSource is not available in this environment");
  }
  const es = new EventSource(url);
  // A thin adapter, not a direct cast: the real EventSource's onmessage
  // handler is typed to receive a full MessageEvent, which is not what
  // EventSourceLike promises its caller.
  const adapter: EventSourceLike = {
    onmessage: null,
    onerror: null,
    close: () => es.close(),
  };
  es.onmessage = (event) => adapter.onmessage?.({ data: event.data });
  es.onerror = (event) => adapter.onerror?.(event);
  return adapter;
}

/**
 * Every API call goes through this. It exists for one reason: Authelia's
 * session lapse shows up two ways — a plain 401, or (because fetch follows
 * redirects by default) a *followed* redirect to the login portal, arriving
 * as a 200 whose body is the login page's HTML, not JSON. Both mean the same
 * thing here and get the same treatment: never a thrown-away list, never a
 * navigation, just a signal the store turns into `signedOut`.
 */
async function apiFetch(
  fetchImpl: typeof fetch,
  input: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetchImpl(input, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (
    response.status === 401 ||
    response.redirected ||
    contentType.includes("text/html")
  ) {
    throw new AutheliaLapseError();
  }
  if (!response.ok) {
    throw new Error(`${input} responded with ${response.status}`);
  }
  return response.json();
}

interface CatchUpResponse {
  ops: Op[];
  cursor: number;
}

interface PostOpsResponse {
  accepted: Array<{ clientOpId: string }>;
}

// The three network shapes below are a placeholder pending confirmation from
// the API-layer agent building src/api/**. Isolated into these three small
// functions (plus `apiFetch` above) so the real contract, once confirmed, is
// a small local patch rather than a rewrite.
async function fetchCatchUp(
  fetchImpl: typeof fetch,
  listId: Id,
  since: number,
): Promise<CatchUpResponse> {
  return (await apiFetch(
    fetchImpl,
    `/api/lists/${listId}/ops?since=${since}`,
  )) as CatchUpResponse;
}

async function postOps(
  fetchImpl: typeof fetch,
  listId: Id,
  ops: Op[],
): Promise<Array<{ clientOpId: string }>> {
  const body = (await apiFetch(fetchImpl, `/api/lists/${listId}/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ops }),
  })) as PostOpsResponse;
  return body.accepted;
}

function streamUrl(listId: Id): string {
  return `/api/lists/${listId}/stream`;
}

export function createListStore(
  listId: Id,
  actor: string,
  deps: ListStoreDeps = {},
): ListStore {
  const fetchImpl = deps.fetch ?? fetch;
  const createEventSource = deps.createEventSource ?? defaultCreateEventSource;

  let state: SyncState = emptyState();
  let syncMeta: SyncMeta = { listId, cursor: null, lastHydratedAt: null };
  const listeners = new Set<() => void>();

  let pendingCount = 0;
  let signedOut = false;
  let cachedStatus: StoreStatus = {
    online: isOnline(),
    pendingCount: 0,
    signedOut: false,
  };

  // Every clientOpId this tab has dispatched, so a stream echo of our own op
  // can be recognised and skipped. Re-applying it would still be *correct* —
  // the reducer is idempotent — but skipping avoids a redundant IndexedDB
  // write on every single tap. Never pruned within a session: unbounded but
  // small for a shopping list's realistic op volume.
  const originatedClientOpIds = new Set<string>();

  let connected = false;
  let eventSource: EventSourceLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = BASE_BACKOFF_MS;
  let loadPromise: Promise<void> | null = null;

  function emit(): void {
    for (const fn of listeners) fn();
  }

  function updateStatus(): void {
    const next: StoreStatus = { online: isOnline(), pendingCount, signedOut };
    if (
      next.online === cachedStatus.online &&
      next.pendingCount === cachedStatus.pendingCount &&
      next.signedOut === cachedStatus.signedOut
    ) {
      return;
    }
    // Cached and only replaced on real change: `status()` is read through
    // `useSyncExternalStore`, which needs a stable reference to avoid
    // re-rendering (or looping) on every call.
    cachedStatus = next;
    emit();
  }

  /**
   * IndexedDB is touched lazily, only from here. `createListStore` itself
   * must stay side-effect free: Next.js still renders a "use client"
   * component's hooks on the server for the initial HTML, and `indexedDB`
   * does not exist there. `ensureLoaded` is only ever invoked from
   * dispatch/hydrate/connect, which only run once the component has mounted
   * on the client.
   */
  function ensureLoaded(): Promise<void> {
    if (!loadPromise) {
      loadPromise = (async () => {
        if (typeof indexedDB === "undefined") return;
        const [savedState, savedMeta, outboxOps] = await Promise.all([
          loadState(listId),
          loadMeta(listId),
          outbox.pending(),
        ]);
        if (savedState) state = savedState;
        if (savedMeta) syncMeta = savedMeta;
        pendingCount = outboxOps.length;
        for (const op of outboxOps) originatedClientOpIds.add(op.clientOpId);
        updateStatus();
        emit();
      })();
    }
    return loadPromise;
  }

  async function dispatch(op: Op): Promise<void> {
    await ensureLoaded();

    // Apply first, synchronously in memory. A tap that waits on a round trip
    // is a tap that fails in a shop with no signal.
    state = applyOp(state, op);
    originatedClientOpIds.add(op.clientOpId);
    emit();

    await Promise.all([saveState(listId, state), outbox.enqueue(op)]);
    pendingCount += 1;
    updateStatus();

    // Fire-and-forget: dispatch's own promise never waits on the network.
    void attemptFlush();
  }

  async function hydrate(snapshot: ListSnapshot): Promise<void> {
    await ensureLoaded();

    const base = emptyState();
    base.lists[snapshot.list.id] = snapshot.list;
    for (const item of snapshot.catalog) base.catalog[item.id] = item;
    for (const entry of snapshot.entries) {
      base.entries[entry.id] = entry;
      // A ListEntry's own updatedAt/updatedBy IS valid last-write-wins meta —
      // it's exactly what applyOp would have recorded had it processed the
      // op that produced this row. Seeding it protects the outbox replay
      // below from a stale local op beating a fresher server value.
      base.meta[entryMetaKey(entry.id)] = {
        at: entry.updatedAt,
        by: entry.updatedBy,
      };
    }
    // Contributions carry no timestamp of their own in the domain model, so
    // no equivalent meta can be reconstructed for them here — a stale pending
    // set_amount/set_note replayed below could in principle beat a fresher
    // server value. A known, narrow gap (see report), not fixable from this
    // module without a domain change.
    for (const contribution of snapshot.contributions) {
      base.contributions[contribution.id] = contribution;
    }
    // `recipes` and full `recipeAdditions` cannot be reconstructed from a
    // ListSnapshot — it carries only display info (title + scale factor),
    // not the shape the reducer needs — and are left empty. Any
    // add_recipe/remove_recipe op, whether replayed from the outbox below or
    // arriving later via catch-up/stream, still applies correctly regardless.

    // Local edits made since this client last synced must survive a fresh
    // snapshot rather than being silently discarded.
    const outboxOps = await outbox.pending();
    state = applyOps(base, outboxOps);

    syncMeta = { ...syncMeta, lastHydratedAt: new Date().toISOString() };
    await Promise.all([saveState(listId, state), saveMeta(syncMeta)]);
    emit();
  }

  async function attemptFlush(): Promise<void> {
    if (signedOut) return;
    try {
      await outbox.flush((ops) => postOps(fetchImpl, listId, ops));
      const remaining = await outbox.pending();
      pendingCount = remaining.length;
      resetBackoff();
      updateStatus();
    } catch (err) {
      if (err instanceof AutheliaLapseError) {
        signedOut = true;
        updateStatus();
        return;
      }
      scheduleRetry();
    }
  }

  async function tryCatchUp(): Promise<boolean> {
    try {
      const since = syncMeta.cursor ?? 0;
      const { ops, cursor } = await fetchCatchUp(fetchImpl, listId, since);
      if (!connected) return false; // disconnect() ran while this was in flight

      // Reapplying ops already reflected in our state is always safe — the
      // reducer is idempotent and commutative by design — so an imprecise or
      // stale cursor costs a little redundant work, never correctness.
      state = applyOps(state, ops);
      syncMeta = { ...syncMeta, cursor };
      emit();
      await Promise.all([saveState(listId, state), saveMeta(syncMeta)]);
      resetBackoff();
      return true;
    } catch (err) {
      if (!connected) return false;
      if (err instanceof AutheliaLapseError) {
        signedOut = true;
        updateStatus();
        return false;
      }
      scheduleRetry();
      return false;
    }
  }

  function attachStream(): void {
    const es = createEventSource(streamUrl(listId));
    eventSource = es;

    es.onmessage = (event) => {
      const incoming = JSON.parse(event.data) as Op & { seq: number };
      if (!originatedClientOpIds.has(incoming.clientOpId)) {
        state = applyOp(state, incoming);
        emit();
      }
      syncMeta = {
        ...syncMeta,
        cursor: Math.max(syncMeta.cursor ?? 0, incoming.seq),
      };
      void (async () => {
        try {
          await Promise.all([saveState(listId, state), saveMeta(syncMeta)]);
        } catch {
          // Best-effort: the next successful write, or the next catch-up,
          // reconciles IndexedDB with in-memory state regardless.
        }
      })();
    };

    es.onerror = () => {
      es.close();
      if (eventSource !== es) return; // superseded by a later attach/disconnect
      eventSource = null;
      if (!connected || signedOut) return;
      scheduleRetry();
    };
  }

  async function reconnectCycle(): Promise<void> {
    if (!connected) return;
    // Catch-up MUST finish before the stream attaches. Attaching first would
    // leave a gap — anything the server processed between the catch-up
    // response and the stream opening — that neither call would ever cover.
    // This looks like a pointless ordering constraint. It is not.
    const caughtUp = await tryCatchUp();
    if (!caughtUp || !connected) return;
    attachStream();
    void attemptFlush();
  }

  function resetBackoff(): void {
    backoffMs = BASE_BACKOFF_MS;
  }

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry(): void {
    if (!connected || signedOut) return;
    clearRetryTimer();
    const delay = backoffMs;
    // Never a tight retry loop: each failure backs off further, capped, so a
    // dead connection in a shop does not flatten the battery.
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void reconnectCycle();
    }, delay);
  }

  function handleOnline(): void {
    updateStatus();
    if (signedOut) return;
    resetBackoff();
    if (eventSource) {
      void attemptFlush();
    } else {
      void reconnectCycle();
    }
  }

  function handleOffline(): void {
    updateStatus();
  }

  function handleVisibility(): void {
    if (typeof document === "undefined" || document.visibilityState !== "visible") {
      return;
    }
    handleOnline();
  }

  function connect(): void {
    if (connected) return;
    connected = true;
    // A fresh connect() is exactly the "try again" the signed-out banner
    // offers — it deserves a clean attempt, not a wall from the last lapse.
    signedOut = false;
    resetBackoff();
    updateStatus();

    if (typeof window !== "undefined") {
      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    void ensureLoaded().then(() => reconnectCycle());
  }

  function disconnect(): void {
    connected = false;
    clearRetryTimer();
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", handleVisibility);
    }
  }

  function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function getState(): SyncState {
    return state;
  }

  function status(): StoreStatus {
    return cachedStatus;
  }

  function ready(): Promise<void> {
    return ensureLoaded();
  }

  // `actor` is accepted (matching the given factory signature) for the
  // caller's ops to be attributed to, and is available here for any future
  // use (e.g. tagging the stream connection); dispatch() itself trusts the
  // actor already stamped on the Op it's given rather than re-deriving it.
  void actor;

  return { getState, subscribe, dispatch, hydrate, connect, disconnect, status, ready };
}
