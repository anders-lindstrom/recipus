import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entryId } from "@/lib/domain";
import type { ListSnapshot } from "@/lib/services/list-data";
import type { Op } from "@/lib/sync";
import { deleteDb } from "./db";
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

function emptySnapshot(listId: string): ListSnapshot {
  return {
    list: { id: listId, name: "Hemköp", icon: "1F6D2", position: 0, categoryOrder: [] },
    categories: [],
    catalog: [],
    entries: [],
    contributions: [],
    recipeAdditions: {},
    suggestions: [],
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
