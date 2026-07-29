import type { Op } from "@/lib/sync";
import { getDb } from "./db";

/**
 * The outbox: a FIFO queue of ops waiting to reach the server.
 *
 * `dispatch()` in store.ts enqueues here the instant a tap happens, before it
 * ever touches the network. `flush()` is what drains it — called after every
 * dispatch, on reconnect, and on visibility change. Ops carry their own
 * `clientOpId`, so a duplicate post is survivable server-side, but re-entrancy
 * here still matters: every extra POST is a request a phone in a shop with one
 * bar of signal cannot spare.
 */

export async function enqueue(op: Op): Promise<void> {
  const db = await getDb();
  await db.add("outbox", { clientOpId: op.clientOpId, op });
}

/** FIFO: `getAll` on an autoIncrement store returns rows in ascending key order. */
export async function pending(): Promise<Op[]> {
  const db = await getDb();
  const rows = await db.getAll("outbox");
  return rows.map((row) => row.op);
}

export async function ack(clientOpIds: string[]): Promise<void> {
  if (clientOpIds.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("outbox", "readwrite");
  const index = tx.store.index("by-clientOpId");
  await Promise.all(
    clientOpIds.map(async (id) => {
      const key = await index.getKey(id);
      if (key !== undefined) await tx.store.delete(key);
    }),
  );
  await tx.done;
}

// Module-level guard making `flush` re-entrant-safe: two triggers landing at
// the same instant (a `visibilitychange` firing right as `online` fires) must
// not both start posting, or the same batch goes out twice. The second caller
// joins the first's in-flight promise instead of starting its own.
let inFlight: Promise<void> | null = null;
// If a caller arrives while a flush is already running, its ops may not have
// existed yet when that flush read `pending()`. Rather than drop them until
// the next external trigger, the running flush loops once more before it lets
// go of the guard.
let rerun = false;

export async function flush(
  post: (ops: Op[]) => Promise<{ clientOpId: string }[]>,
): Promise<void> {
  if (inFlight) {
    rerun = true;
    return inFlight;
  }
  inFlight = run(post).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(
  post: (ops: Op[]) => Promise<{ clientOpId: string }[]>,
): Promise<void> {
  for (;;) {
    rerun = false;
    const ops = await pending();
    if (ops.length === 0) return;
    // If `post` rejects (offline, server error, session lapsed) this throws
    // out of `run`, the guard above releases, and every op is still in the
    // outbox — nothing was acked, so nothing is lost.
    const accepted = await post(ops);
    await ack(accepted.map((a) => a.clientOpId));
    if (!rerun) return;
  }
}
