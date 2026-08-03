import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyState, entryId } from "@/lib/domain";
import type { ListSnapshot } from "@/lib/services/list-data";
import type { Op } from "@/lib/sync";
import { entryKey } from "@/lib/sync";
import { deleteDb, loadState, saveMeta, saveState, STATE_VERSION } from "./db";
import { createListStore, type EventSourceLike } from "./store";

afterEach(async () => {
  await deleteDb();
});

const LIST = "hemkop";
const MILK = "mjolk";

function addItem(clientOpId: string): Op {
  return {
    clientOpId,
    actor: "anders",
    at: "2026-03-12T10:00:00.000Z",
    kind: "add_item",
    listId: LIST,
    catalogItemId: MILK,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(status = 200): Response {
  return new Response("<html>logga in igen</html>", {
    status,
    headers: { "content-type": "text/html" },
  });
}

function emptySnapshot(listId: string, seq = Number.MAX_SAFE_INTEGER): ListSnapshot {
  return {
    // Fresh by default, so every existing test keeps meaning what it meant:
    // they are all about what a hydrate DOES, not about whether it is refused.
    // The staleness cases pass an explicit seq.
    seq,
    list: { id: listId, name: "Hemköp", icon: "1F6D2", position: 0, categoryOrder: [] },
    categories: [],
    catalog: [],
    entries: [],
    contributions: [],
    products: [],
    aliases: [],
    barcodes: [],
    recipeAdditions: {},
    recipeTitles: {},
    meta: {},
    suggestions: [],
    purchaseStats: {},
  };
}

/**
 * Handles the snapshot GET, the catch-up GET, and the post-ops POST with sane
 * defaults, matching src/api/routes/{lists,ops}.ts's real response shapes.
 */
function makeFetchMock(
  overrides: Partial<{
    onPost: (ops: Op[]) => Response;
    onCatchUp: () => Response;
    onSnapshot: () => Response;
  }> = {},
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { ops: Op[] };
      return overrides.onPost
        ? overrides.onPost(body.ops)
        : jsonResponse({
            results: body.ops.map((o) => ({ clientOpId: o.clientOpId, seq: 1 })),
          });
    }
    if (String(input).includes("/snapshot")) {
      return overrides.onSnapshot ? overrides.onSnapshot() : jsonResponse(emptySnapshot(LIST));
    }
    return overrides.onCatchUp ? overrides.onCatchUp() : jsonResponse([]);
  }) as unknown as typeof fetch;
}

class FakeEventSource implements EventSourceLike {
  onOp: ((event: { data: string }) => void) | null = null;
  onError: ((event: unknown) => void) | null = null;
  closed = false;
  close(): void {
    this.closed = true;
  }
}

/**
 * A fetch mock whose promise only settles when the test says so — used to
 * prove dispatch() doesn't wait on the network. Always resolved before the
 * test ends: outbox.ts's re-entrancy guard is module-level (by design — there
 * is exactly one outbox for the whole app), so a fetch left hanging forever
 * would wedge every later test's flush() calls too.
 */
function deferredFetch(): {
  fetch: typeof fetch;
  resolve: (r: Response) => void;
  called: () => boolean;
} {
  let resolveFn: ((r: Response) => void) | undefined;
  const mock = vi.fn(() => new Promise<Response>((r) => (resolveFn = r)));
  return {
    fetch: mock as unknown as typeof fetch,
    // The promise executor above only runs once the mock is actually called,
    // so resolving before then would resolve nothing — callers must await
    // `called()` first.
    resolve: (r) => resolveFn?.(r),
    called: () => mock.mock.calls.length > 0,
  };
}

describe("dispatch", () => {
  it("applies locally and resolves without waiting on the network", async () => {
    const deferred = deferredFetch();
    const store = createListStore(LIST, "anders", {
      fetch: deferred.fetch,
      createEventSource: () => new FakeEventSource(),
    });
    await store.ready();

    // If dispatch awaited the network this would hang, since the injected
    // fetch has not been told to resolve yet.
    await store.dispatch(addItem("op-1"));

    expect(store.getState().entries[entryId(LIST, MILK)]).toBeDefined();
    expect(store.status().pendingCount).toBe(1);

    // Let the flush dispatch() kicked off settle so it doesn't leak into
    // later tests via outbox.ts's module-level re-entrancy guard.
    await vi.waitFor(() => expect(deferred.called()).toBe(true));
    deferred.resolve(jsonResponse({ results: [{ clientOpId: "op-1", seq: 1 }] }));
    await vi.waitFor(() => expect(store.status().pendingCount).toBe(0));
  });

  it("posts and acks the outbox afterwards, driving pendingCount to zero", async () => {
    const store = createListStore(LIST, "anders", {
      fetch: makeFetchMock(),
      createEventSource: () => new FakeEventSource(),
    });
    await store.ready();

    await store.dispatch(addItem("op-1"));
    expect(store.status().pendingCount).toBe(1);

    await vi.waitFor(() => expect(store.status().pendingCount).toBe(0));
  });
});

describe("persistence across a reload", () => {
  it("an op survives a reload: a fresh store instance loads what the last one persisted", async () => {
    // Held un-flushed for the whole test (deps shared with storeB, and the
    // outbox itself is one shared queue) so the fire-and-forget flush that
    // dispatch() kicks off can't race the assertions below.
    const deferred = deferredFetch();
    const deps = {
      fetch: deferred.fetch,
      createEventSource: () => new FakeEventSource(),
    };

    const storeA = createListStore(LIST, "anders", deps);
    await storeA.ready();
    await storeA.dispatch(addItem("op-1"));

    // A fresh in-memory instance, same IndexedDB behind it — this is what
    // "reload" means from the store's point of view.
    const storeB = createListStore(LIST, "anders", deps);
    await storeB.ready();

    expect(storeB.getState().entries[entryId(LIST, MILK)]).toBeDefined();
    expect(storeB.status().pendingCount).toBe(1);

    await vi.waitFor(() => expect(deferred.called()).toBe(true));
    deferred.resolve(jsonResponse({ results: [{ clientOpId: "op-1", seq: 1 }] }));
    await vi.waitFor(() => expect(storeA.status().pendingCount).toBe(0));
  });
});

describe("Authelia lapse handling", () => {
  it("a 401 sets signedOut and preserves both state and the outbox", async () => {
    const store = createListStore(LIST, "anders", {
      fetch: makeFetchMock({ onPost: () => new Response(null, { status: 401 }) }),
      createEventSource: () => new FakeEventSource(),
    });
    await store.ready();

    await store.dispatch(addItem("op-1"));
    await vi.waitFor(() => expect(store.status().signedOut).toBe(true));

    // Never thrown away: the tile is still there, the op is still queued.
    expect(store.getState().entries[entryId(LIST, MILK)]).toBeDefined();
    expect(store.status().pendingCount).toBe(1);
  });

  it("an HTML response where JSON was expected is treated exactly like a 401", async () => {
    const store = createListStore(LIST, "anders", {
      fetch: makeFetchMock({ onPost: () => htmlResponse() }),
      createEventSource: () => new FakeEventSource(),
    });
    await store.ready();

    await store.dispatch(addItem("op-1"));
    await vi.waitFor(() => expect(store.status().signedOut).toBe(true));

    expect(store.getState().entries[entryId(LIST, MILK)]).toBeDefined();
    expect(store.status().pendingCount).toBe(1);
  });
});

describe("reconnect ordering", () => {
  it("bootstraps from the snapshot, then catch-up, then attaches the stream", async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/snapshot")) {
        order.push("snapshot");
        return jsonResponse(emptySnapshot(LIST));
      }
      order.push("catch-up");
      return jsonResponse([]);
    }) as unknown as typeof fetch;
    const createEventSource = vi.fn(() => {
      order.push("stream");
      return new FakeEventSource();
    });

    // A store that has never hydrated (no persisted syncMeta, no explicit
    // hydrate() call) must bootstrap from the full snapshot before it can
    // trust catch-up alone: ops is a 30-day log, not the source of truth.
    const store = createListStore(LIST, "anders", { fetch: fetchMock, createEventSource });
    store.connect();

    await vi.waitFor(() => expect(createEventSource).toHaveBeenCalled());
    expect(order).toEqual(["snapshot", "catch-up", "stream"]);
  });

  it("skips the snapshot bootstrap once hydrate() has already run", async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/snapshot")) order.push("snapshot");
      else order.push("catch-up");
      return jsonResponse([]);
    }) as unknown as typeof fetch;
    const createEventSource = vi.fn(() => {
      order.push("stream");
      return new FakeEventSource();
    });

    const store = createListStore(LIST, "anders", { fetch: fetchMock, createEventSource });
    await store.hydrate(emptySnapshot(LIST));
    store.connect();

    await vi.waitFor(() => expect(createEventSource).toHaveBeenCalled());
    expect(order).toEqual(["catch-up", "stream"]);
  });
});

describe("stream echoes", () => {
  it("does not re-apply a stream echo of an op this tab originated", async () => {
    let captured: FakeEventSource | null = null;
    const store = createListStore(LIST, "anders", {
      fetch: makeFetchMock(),
      createEventSource: () => {
        captured = new FakeEventSource();
        return captured;
      },
    });
    // Hydrated up front (as the hook does) so connect() below goes straight
    // to catch-up/stream — no snapshot bootstrap racing the dispatch below.
    await store.hydrate(emptySnapshot(LIST));

    const op = addItem("op-1");
    await store.dispatch(op);

    store.connect();
    await vi.waitFor(() => expect(captured?.onOp).toBeTruthy());

    const before = store.getState();
    captured!.onOp!({ data: JSON.stringify({ seq: 1, op }) });

    // Same reference: the echo was recognised and skipped, not reapplied.
    expect(store.getState()).toBe(before);
  });

  it("applies a genuinely new op arriving over the stream", async () => {
    let captured: FakeEventSource | null = null;
    const store = createListStore(LIST, "anders", {
      fetch: makeFetchMock(),
      createEventSource: () => {
        captured = new FakeEventSource();
        return captured;
      },
    });
    store.connect();
    await vi.waitFor(() => expect(captured?.onOp).toBeTruthy());

    const fromMaria: Op = {
      clientOpId: "maria-op-1",
      actor: "maria",
      at: "2026-03-12T10:05:00.000Z",
      kind: "add_item",
      listId: LIST,
      catalogItemId: "gradde",
    };
    captured!.onOp!({ data: JSON.stringify({ seq: 1, op: fromMaria }) });

    await vi.waitFor(() =>
      expect(store.getState().entries[entryId(LIST, "gradde")]).toBeDefined(),
    );
  });
});

describe("online reachability", () => {
  it("goes false after a failed round trip and true again after a successful one — not just navigator.onLine", async () => {
    // In this (Node) test environment navigator.onLine is unavailable, so
    // isOnline() defaults to true — meaning status().online here is driven
    // entirely by consecutive network failures, exactly the signal
    // navigator.onLine itself can't provide (an up interface, a dead server).
    let shouldFail = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/snapshot")) return jsonResponse(emptySnapshot(LIST));
      if (shouldFail) throw new Error("network down");
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    const store = createListStore(LIST, "anders", {
      fetch: fetchMock,
      createEventSource: () => new FakeEventSource(),
    });
    // Hydrated up front so the reconnect cycle goes straight to catch-up
    // (the thing about to fail) rather than the snapshot bootstrap.
    await store.hydrate(emptySnapshot(LIST));

    store.connect();
    await vi.waitFor(() => expect(store.status().online).toBe(false));
    expect(store.status().signedOut).toBe(false); // a plain network error, not a lapse

    shouldFail = false;
    // Force an immediate retry rather than waiting out the real backoff timer.
    store.disconnect();
    store.connect();

    await vi.waitFor(() => expect(store.status().online).toBe(true));
  });
});

describe("state version tripwire", () => {
  /**
   * A device whose cached state was written by an older build.
   *
   * That build dropped any op kind it did not recognise — correct, it is what
   * keeps it from crashing — but it still advanced its cursor, so those ops are
   * never re-fetched and its state is permanently missing a fact. The version
   * stamp is how the newer build notices and repairs itself, and the repair has
   * to be a full snapshot rather than a log replay.
   */
  it("re-hydrates from a snapshot when the cached state predates this build", async () => {
    await saveMeta({
      listId: LIST,
      cursor: 42,
      lastHydratedAt: "2026-03-12T09:00:00.000Z",
      stateVersion: STATE_VERSION - 1,
    });

    const onSnapshot = vi.fn(() => jsonResponse(emptySnapshot(LIST)));
    const store = createListStore(LIST, "anders", {
      fetch: makeFetchMock({ onSnapshot }),
      createEventSource: () => new FakeEventSource(),
    });
    await store.ready();
    store.connect();

    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalled());
    store.disconnect();
  });

  it("does not re-hydrate when the cached state is current", async () => {
    await saveMeta({
      listId: LIST,
      cursor: 42,
      lastHydratedAt: "2026-03-12T09:00:00.000Z",
      stateVersion: STATE_VERSION,
    });

    const onSnapshot = vi.fn(() => jsonResponse(emptySnapshot(LIST)));
    const store = createListStore(LIST, "anders", {
      fetch: makeFetchMock({ onSnapshot }),
      createEventSource: () => new FakeEventSource(),
    });
    await store.ready();
    store.connect();

    // Give the reconnect cycle room to have taken a snapshot if it were going to.
    await vi.waitFor(() => expect(store.status().online).toBe(true));
    expect(onSnapshot).not.toHaveBeenCalled();
    store.disconnect();
  });
});

describe("retention", () => {
  /**
   * Tombstones are pruned when the app opens, not left to grow forever.
   *
   * The meta map is re-serialised to IndexedDB on every single tap, so a
   * tombstone that never leaves costs a little more work on every interaction
   * for the rest of the install's life. `pruneTombstones` was written for this
   * and then had no caller anywhere; this is the caller.
   */
  it("drops tombstones past the retention window when it loads", async () => {
    const old = entryId(LIST, "gammalt");
    const recent = entryId(LIST, MILK);
    const now = Date.now();
    const daysAgo = (n: number) =>
      new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

    const state = emptyState();
    state.entries[old] = {
      id: old,
      listId: LIST,
      catalogItemId: "gammalt",
      createdAt: daysAgo(90),
      createdBy: "anders",
      removedAt: daysAgo(60),
      priority: "normal",
      updatedAt: daysAgo(60),
      updatedBy: "anders",
    };
    state.entries[recent] = {
      id: recent,
      listId: LIST,
      catalogItemId: MILK,
      createdAt: daysAgo(10),
      createdBy: "anders",
      removedAt: daysAgo(2),
      priority: "normal",
      updatedAt: daysAgo(2),
      updatedBy: "anders",
    };
    state.meta[entryKey(old)] = { at: daysAgo(60), by: "anders", deleted: true };
    state.meta[entryKey(recent)] = { at: daysAgo(2), by: "anders", deleted: true };
    await saveState(LIST, state);

    const store = createListStore(LIST, "anders", { fetch: makeFetchMock() });
    await store.ready();

    expect(store.getState().entries[old]).toBeUndefined();
    expect(store.getState().meta[entryKey(old)]).toBeUndefined();
    // Still inside the window: a straggler could yet arrive arguing about it.
    expect(store.getState().entries[recent]).toBeDefined();

    // And the pruning is written back, or it happens again on every open and
    // the stored blob never actually shrinks.
    const reloaded = await loadState(LIST);
    expect(reloaded!.entries[old]).toBeUndefined();
  });
});

describe("hydrating the registry", () => {
  /**
   * The same fresh-literal hazard as `pruneTombstones`, one layer further along.
   *
   * `applySnapshot` rebuilds `SyncState` from `emptyState()` and populates it map
   * by map, BY NAME — so a map the server started sending is simply not read, and
   * the failure is silent: /varor renders an empty registry after every hydrate,
   * which looks exactly like a household that has not scanned anything yet.
   *
   * Worth a test rather than a careful reading, because the snapshot and the
   * state are two shapes that have to be mapped explicitly; there is no
   * structural trick that makes a new field carry itself here.
   */
  it("reads products, aliases and barcodes out of the snapshot", async () => {
    const snapshot = emptySnapshot(LIST);
    snapshot.products = [
      {
        id: "prod:7310865004703",
        name: "Arla Standardmjölk",
        brand: "Arla",
        catalogItemId: MILK,
        defaultSize: { value: 1.5, unit: "l" },
        sourceSizeText: "1,5 l",
        imageUrl: null,
        createdAt: "2026-03-12T10:00:00.000Z",
        createdBy: "anders",
      },
    ];
    snapshot.aliases = [
      {
        aliasNorm: "kottfars",
        catalogItemId: "notfars",
        createdAt: "2026-03-12T10:00:00.000Z",
        createdBy: "anders",
      },
    ];
    snapshot.barcodes = [
      {
        ean: "7310865004703",
        productId: "prod:7310865004703",
        source: "off",
      },
    ];

    const store = createListStore(LIST, "anders", { fetch: makeFetchMock() });
    await store.hydrate(snapshot);

    const state = store.getState();
    expect(state.products["prod:7310865004703"]?.catalogItemId).toBe(MILK);
    expect(state.aliases["kottfars"]?.catalogItemId).toBe("notfars");
    expect(state.barcodes["7310865004703"]?.productId).toBe("prod:7310865004703");
  });
});

/**
 * The cold open that used to eat the other phone's additions.
 *
 * `applySnapshot` rebuilds from `emptyState()` and replays only the OUTBOX on
 * top. That is right when the snapshot is fresh and destructive when it is not
 * — and the service worker guarantees it sometimes is not, because it caches
 * the rendered document and a cold open in a shop replays whatever server
 * render was cached.
 *
 * Anything that arrived over SSE is NOT in this device's outbox, because those
 * are not this device's ops. So they were rebuilt away, and the cursor was
 * never lowered, so catch-up asked for ops after a seq they were already behind
 * and the server had nothing to send. The list simply lost them, silently.
 */
describe("a stale snapshot cannot overwrite live local state", () => {
  it("keeps changes that arrived over the stream after the snapshot was built", async () => {
    let captured: FakeEventSource | null = null;
    const store = createListStore(LIST, "anders", {
      fetch: makeFetchMock(),
      createEventSource: () => {
        captured = new FakeEventSource();
        return captured;
      },
    });

    await store.hydrate(emptySnapshot(LIST, 10));
    store.connect();
    await vi.waitFor(() => expect(captured?.onOp).toBeTruthy());

    // The partner adds milk at home. It arrives here over SSE, so it lands in
    // local state and in NO outbox — which is exactly what made it fragile.
    captured!.onOp!({ data: JSON.stringify({ seq: 42, op: addItem("from-partner") }) });
    await vi.waitFor(() =>
      expect(store.getState().entries[`${LIST}:${MILK}`]).toBeTruthy(),
    );

    // Now the shop, offline: the service worker serves a document rendered
    // before any of that happened.
    await store.hydrate(emptySnapshot(LIST, 10));

    expect(store.getState().entries[`${LIST}:${MILK}`]).toBeTruthy();
  });

  it("still rebuilds from a snapshot that is genuinely newer", async () => {
    // The guard must not turn into "never hydrate again". A fresh snapshot is
    // still the authoritative bootstrap.
    const store = createListStore(LIST, "anders", { fetch: makeFetchMock() });
    await store.hydrate(emptySnapshot(LIST, 10));

    const withMilk = emptySnapshot(LIST, 99);
    withMilk.entries = [
      {
        id: `${LIST}:${MILK}`,
        listId: LIST,
        catalogItemId: MILK,
        createdAt: "2026-03-12T10:00:00.000Z",
        createdBy: "anders",
        removedAt: null,
        priority: "normal",
        priorityUpdatedAt: null,
        priorityUpdatedBy: null,
      },
    ];
    await store.hydrate(withMilk);

    expect(store.getState().entries[`${LIST}:${MILK}`]).toBeTruthy();
  });

  it("carries the cursor forward to what the snapshot already contains", async () => {
    // So catch-up asks for what comes AFTER the snapshot rather than re-walking
    // a window it has covered. Raised, never lowered.
    const seen: string[] = [];
    const store = createListStore(LIST, "anders", {
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") return jsonResponse({ results: [] });
        if (url.includes("/snapshot")) return jsonResponse(emptySnapshot(LIST, 77));
        seen.push(url);
        return jsonResponse([]);
      }) as unknown as typeof fetch,
      createEventSource: () => new FakeEventSource(),
    });

    await store.hydrate(emptySnapshot(LIST, 77));
    store.connect();

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.some((u) => u.includes("since=77"))).toBe(true);
  });
});
