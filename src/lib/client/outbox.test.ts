import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Op } from "@/lib/sync";
import { deleteDb } from "./db";
import { ack, enqueue, flush, pending } from "./outbox";

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

    const post = vi.fn(async (ops: Op[]) =>
      ops.map((o) => ({ clientOpId: o.clientOpId })),
    );

    await flush(post);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0].map((o) => o.clientOpId)).toEqual(["op-1", "op-2"]);
    expect(await pending()).toEqual([]);
  });

  it("does nothing when the outbox is empty", async () => {
    const post = vi.fn(async () => []);
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

    let resolvePost!: (value: { clientOpId: string }[]) => void;
    const post = vi.fn(
      () =>
        new Promise<{ clientOpId: string }[]>((resolve) => {
          resolvePost = resolve;
        }),
    );

    const first = flush(post);
    const second = flush(post); // fires while the first is still in flight

    // `pending()` itself is an async IndexedDB read, so give the first run a
    // tick to reach `post` before asserting — the guard against a second
    // POST is synchronous (see below); this is only waiting for the first.
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    resolvePost([{ clientOpId: "op-1" }]);

    await Promise.all([first, second]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(await pending()).toEqual([]);
  });

  it("a flush that joins an in-flight one still picks up ops enqueued in between", async () => {
    await enqueue(addItem("op-1"));

    let resolveFirstPost!: (value: { clientOpId: string }[]) => void;
    let callCount = 0;
    const post = vi.fn((ops: Op[]) => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<{ clientOpId: string }[]>((resolve) => {
          resolveFirstPost = resolve;
        });
      }
      return Promise.resolve(ops.map((o) => ({ clientOpId: o.clientOpId })));
    });

    // First flush reads [op-1] and is now awaiting the (still-pending) post.
    const first = flush(post);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    // A second op lands — e.g. another dispatch() — while that post is in flight.
    await enqueue(addItem("op-2"));
    // A second trigger (e.g. visibilitychange) arrives; it must join the
    // in-flight run rather than post op-1 again, but must not lose op-2.
    const second = flush(post);

    resolveFirstPost([{ clientOpId: "op-1" }]);
    await Promise.all([first, second]);

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][0].map((o) => o.clientOpId)).toEqual(["op-2"]);
    expect(await pending()).toEqual([]);
  });
});
