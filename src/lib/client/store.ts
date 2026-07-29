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
  /** The server sends a named "op" SSE event, never the default "message". */
  onOp: ((event: { data: string }) => void) | null;
  onError: ((event: unknown) => void) | null;
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
  // A thin adapter, not a direct cast: the real EventSource's handlers are
  // typed to receive a full MessageEvent, which is not what EventSourceLike
  // promises its caller, and the server's payload arrives on a named "op"
  // event rather than the default "message".
  const adapter: EventSourceLike = {
    onOp: null,
    onError: null,
    close: () => es.close(),
  };
  es.addEventListener("op", (event) => {
    adapter.onOp?.({ data: (event as MessageEvent<string>).data });
  });
  es.addEventListener("error", (event) => adapter.onError?.(event));
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

/** Matches src/api/schemas.ts's opEnvelopeSchema. */
interface OpEnvelope {
  seq: number;
  op: Op;
}

/** Matches src/api/schemas.ts's opResultSchema. */
interface OpResult {
  clientOpId: string;
  seq?: number;
  error?: string;
}

async function fetchSnapshot(fetchImpl: typeof fetch, listId: Id): Promise<ListSnapshot> {
  return (await apiFetch(fetchImpl, `/api/lists/${listId}/snapshot`)) as ListSnapshot;
}

/**
 * GET /api/ops returns a bare array of envelopes, oldest first — no cursor of
 * its own. The client's cursor is just the highest `seq` seen; an empty
 * response means nothing new, so the cursor doesn't move.
 */
async function fetchCatchUp(
  fetchImpl: typeof fetch,
  listId: Id,
  since: number,
): Promise<{ ops: Op[]; cursor: number }> {
  const rows = (await apiFetch(
    fetchImpl,
    `/api/ops?since=${since}&listId=${encodeURIComponent(listId)}`,
  )) as OpEnvelope[];
  const cursor = rows.reduce((max, row) => Math.max(max, row.seq), since);
  return { ops: rows.map((row) => row.op), cursor };
}

/**
 * POST /api/ops applies the batch and reports a result per op — partial
 * success is normal (one stale reference doesn't abort the rest). Only ops
 * with a `seq` (accepted) are handed back to ack; a rejected op is left
 * queued and retried. A permanently-invalid op would then retry forever —
 * an accepted tradeoff here, since silently dropping the user's edit would
 * be worse.
 */
async function postOps(
  fetchImpl: typeof fetch,
  ops: Op[],
): Promise<Array<{ clientOpId: string }>> {
  const body = (await apiFetch(fetchImpl, `/api/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ops }),
  })) as { results: OpResult[] };

  const accepted: Array<{ clientOpId: string }> = [];
  for (const result of body.results) {
    if (result.error) {
      console.warn("[client-store] op rejected by server", result.clientOpId, result.error);
      continue;
    }
    accepted.push({ clientOpId: result.clientOpId });
  }
  return accepted;
}

function streamUrl(listId: Id, since: number): string {
  return `/api/stream?listId=${encodeURIComponent(listId)}&since=${since}`;
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

  /**
   * Turn a read-optimized ListSnapshot into the reducer-shaped SyncState this
   * store actually runs on, with local edits made since the last sync replayed
   * on top rather than discarded.
   */
  async function applySnapshot(snapshot: ListSnapshot): Promise<void> {
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

    const outboxOps = await outbox.pending();
    state = applyOps(base, outboxOps);

    syncMeta = { ...syncMeta, lastHydratedAt: new Date().toISOString() };
    await Promise.all([saveState(listId, state), saveMeta(syncMeta)]);
    emit();
  }

  async function hydrate(snapshot: ListSnapshot): Promise<void> {
    await ensureLoaded();
    await applySnapshot(snapshot);
  }

  async function attemptFlush(): Promise<void> {
    if (signedOut) return;
    try {
      await outbox.flush((ops) => postOps(fetchImpl, ops));
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
    // Pass the current cursor: the server's own stream handler re-does its
    // own backfill from `since` before going live (see routes/stream.ts), so
    // this closes the remaining gap between our catch-up response and the
    // stream opening even if the two calls are seconds apart. Any op it
    // therefore delivers twice is harmless — see the dedupe/idempotency notes
    // in this file and in reducer.ts's `wins`.
    const es = createEventSource(streamUrl(listId, syncMeta.cursor ?? 0));
    eventSource = es;

    es.onOp = (event) => {
      const envelope = JSON.parse(event.data) as OpEnvelope;
      if (!originatedClientOpIds.has(envelope.op.clientOpId)) {
        state = applyOp(state, envelope.op);
        emit();
      }
      syncMeta = {
        ...syncMeta,
        cursor: Math.max(syncMeta.cursor ?? 0, envelope.seq),
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

    es.onError = () => {
      es.close();
      if (eventSource !== es) return; // superseded by a later attach/disconnect
      eventSource = null;
      if (!connected || signedOut) return;
      scheduleRetry();
    };
  }

  /**
   * A device that has never hydrated this list needs the full snapshot, not
   * just catch-up: `ops` is a 30-day catch-up log, not the source of truth
   * (see design doc 3.2), so a list older than that would come back
   * incomplete if bootstrapped from ops alone. Skipped whenever `hydrate()`
   * has already run — from the hook's `initialSnapshot`, or from a previous
   * session's persisted `syncMeta` — so this only ever fires once per device.
   */
  async function tryBootstrapFromSnapshot(): Promise<boolean> {
    try {
      const snapshot = await fetchSnapshot(fetchImpl, listId);
      if (!connected) return false;
      await applySnapshot(snapshot);
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

  async function reconnectCycle(): Promise<void> {
    if (!connected) return;

    if (syncMeta.lastHydratedAt === null) {
      const bootstrapped = await tryBootstrapFromSnapshot();
      if (!bootstrapped || !connected) return;
    }

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
