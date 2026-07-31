import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Op } from "@/lib/sync";
import { deleteDb } from "./db";
import { ack, enqueue, flush, pending, type PostOutcome } from "./outbox";

/** The server accepted everything it was sent. */
function allAccepted(ops: Op[]): PostOutcome {
  return { accepted: ops.map((o) => o.clientOpId), refused: [] };
}

afterEach(async () => {
  await deleteDb();
});

function addItem(clientOpId: string): Op {
  return {
    clientOpId,
    actor: "anders",
    at: "2026-03-12T10:00:00.000Z",
    kind: "add_item",
    listId: "hemkop",
    catalogItemId: "mjolk",
  };
}

describe("enqueue / pending / ack", () => {
  it("is empty until something is enqueued", async () => {
    expect(await pending()).toEqual([]);
  });

  it("returns enqueued ops in FIFO order", async () => {
    await enqueue(addItem("op-1"));
    await enqueue(addItem("op-2"));
    await enqueue(addItem("op-3"));

    const ops = await pending();
    expect(ops.map((o) => o.clientOpId)).toEqual(["op-1", "op-2", "op-3"]);
  });

  it("ack removes only the acknowledged ops, preserving order of the rest", async () => {
    await enqueue(addItem("op-1"));
    await enqueue(addItem("op-2"));
    await enqueue(addItem("op-3"));

    await ack(["op-2"]);

    const ops = await pending();
    expect(ops.map((o) => o.clientOpId)).toEqual(["op-1", "op-3"]);
  });

  it("acking an unknown clientOpId is a no-op", async () => {
    await enqueue(addItem("op-1"));
    await ack(["never-enqueued"]);
    expect(await pending()).toHaveLength(1);
  });
});

describe("flush", () => {
  it("posts all pending ops in one batch and acks what the server accepted", async () => {
    await enqueue(addItem("op-1"));
    await enqueue(addItem("op-2"));

    const post = vi.fn(async (ops: Op[]) => allAccepted(ops));

    await flush(post);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0].map((o) => o.clientOpId)).toEqual(["op-1", "op-2"]);
    expect(await pending()).toEqual([]);
  });

  it("does nothing when the outbox is empty", async () => {
    const post = vi.fn(async () => ({ accepted: [], refused: [] }));
    await flush(post);
    expect(post).not.toHaveBeenCalled();
  });

  it("a failed flush keeps every op queued", async () => {
    await enqueue(addItem("op-1"));
    const post = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(flush(post)).rejects.toThrow("offline");
    expect(await pending()).toHaveLength(1);
  });

  it("two concurrent flushes post the batch exactly once", async () => {
    await enqueue(addItem("op-1"));

    let resolvePost!: (value: PostOutcome) => void;
    const post = vi.fn(
      () =>
        new Promise<PostOutcome>((resolve) => {
          resolvePost = resolve;
        }),
    );

    const first = flush(post);
    const second = flush(post); // fires while the first is still in flight

    // `pending()` itself is an async IndexedDB read, so give the first run a
    // tick to reach `post` before asserting — the guard against a second
    // POST is synchronous (see below); this is only waiting for the first.
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    resolvePost({ accepted: ["op-1"], refused: [] });

    await Promise.all([first, second]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(await pending()).toEqual([]);
  });

  it("a flush that joins an in-flight one still picks up ops enqueued in between", async () => {
    await enqueue(addItem("op-1"));

    let resolveFirstPost!: (value: PostOutcome) => void;
    let callCount = 0;
    const post = vi.fn((ops: Op[]) => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<PostOutcome>((resolve) => {
          resolveFirstPost = resolve;
        });
      }
      return Promise.resolve(allAccepted(ops));
    });

    // First flush reads [op-1] and is now awaiting the (still-pending) post.
    const first = flush(post);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    // A second op lands — e.g. another dispatch() — while that post is in flight.
    await enqueue(addItem("op-2"));
    // A second trigger (e.g. visibilitychange) arrives; it must join the
    // in-flight run rather than post op-1 again, but must not lose op-2.
    const second = flush(post);

    resolveFirstPost({ accepted: ["op-1"], refused: [] });
    await Promise.all([first, second]);

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][0].map((o) => o.clientOpId)).toEqual(["op-2"]);
    expect(await pending()).toEqual([]);
  });
});

describe("server refusals", () => {
  /**
   * A refusal is not a delivery failure.
   *
   * Before this, an op the server actively declined was logged and skipped but
   * left in the outbox, so it was re-sent on every flush for the lifetime of the
   * install: `pendingCount` never returned to zero, the sync banner stayed up
   * blaming the network, and each batch grew. Now a refusal is counted, retried
   * a few times in case it was transient, then given up on so the queue drains.
   */
  function refuseAll(ops: Op[]): PostOutcome {
    return { accepted: [], refused: ops.map((o) => o.clientOpId) };
  }

  it("keeps a refused op queued, so a transient refusal is retried", async () => {
    await enqueue(addItem("op-1"));
    const post = vi.fn(async (ops: Op[]) => refuseAll(ops));

    await flush(post);

    // Still there: an add_item can legitimately fail once against a
    // create_catalog_item that has not committed yet.
    expect(await pending()).toHaveLength(1);
  });

  it("gives up after repeated refusals so the queue cannot wedge forever", async () => {
    await enqueue(addItem("op-1"));
    const post = vi.fn(async (ops: Op[]) => refuseAll(ops));

    // Each flush is one attempt; MAX_ATTEMPTS is 5.
    for (let i = 0; i < 5; i++) await flush(post);

    expect(await pending()).toEqual([]);
  });

  it("gives up on the refused op without taking accepted ones with it", async () => {
    await enqueue(addItem("op-good"));
    await enqueue(addItem("op-bad"));

    const post = vi.fn(async (ops: Op[]) => ({
      accepted: ops.filter((o) => o.clientOpId !== "op-bad").map((o) => o.clientOpId),
      refused: ops.filter((o) => o.clientOpId === "op-bad").map((o) => o.clientOpId),
    }));

    await flush(post);
    expect((await pending()).map((o) => o.clientOpId)).toEqual(["op-bad"]);

    for (let i = 0; i < 4; i++) await flush(post);
    expect(await pending()).toEqual([]);
  });

  it("does not count a delivery failure as a refusal", async () => {
    await enqueue(addItem("op-1"));
    const offline = vi.fn(async () => {
      throw new Error("offline");
    });

    // Ten failed deliveries must not burn through the refusal budget — being
    // offline for a while is the normal case this whole app is built around.
    for (let i = 0; i < 10; i++) {
      await expect(flush(offline)).rejects.toThrow("offline");
    }
    expect(await pending()).toHaveLength(1);
  });
});
