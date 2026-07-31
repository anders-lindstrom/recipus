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

/**
 * How many times an op the server actively refuses is re-sent before it is given
 * up on.
 *
 * A refusal is not the same as a failure to deliver. If `post` throws — offline,
 * lapsed session, 500 — nothing is acked and everything stays queued, which is
 * right. But when the server answers with a per-op `error` it has seen the op
 * and declined it, and some of those refusals are permanent: an op kind this
 * server is too old to understand, or a reference to a row that will never
 * exist. Left alone, one of those sits at the head of the queue forever, so
 * `pendingCount` never reaches zero, the sync banner never clears, and every
 * flush re-posts a batch that grows for the rest of the install's life.
 *
 * A few retries first, because some refusals genuinely are transient — the
 * route applies a batch sequentially and an `add_item` can legitimately fail
 * once against a `create_catalog_item` that has not committed yet.
 */
const MAX_ATTEMPTS = 5;

/**
 * Count a server-side refusal against each op, and drop the ones out of chances.
 *
 * Returns the ops that were given up on, so the caller can make noise about
 * them. Dropping a user's edit is genuinely bad and this is the lesser of two
 * bads — the alternative is a queue that never drains.
 */
export async function recordRefusals(clientOpIds: string[]): Promise<Op[]> {
  if (clientOpIds.length === 0) return [];
  const db = await getDb();
  const tx = db.transaction("outbox", "readwrite");
  const index = tx.store.index("by-clientOpId");
  const abandoned: Op[] = [];

  await Promise.all(
    clientOpIds.map(async (id) => {
      const key = await index.getKey(id);
      if (key === undefined) return;
      const row = await tx.store.get(key);
      if (!row) return;

      const attempts = (row.attempts ?? 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        abandoned.push(row.op);
        await tx.store.delete(key);
        return;
      }
      // No explicit key: this store keys in-line off `localSeq` (see db.ts), so
      // passing one is a DataError. `row` already carries its own key, and
      // spreading it keeps the FIFO position the ascending key encodes.
      await tx.store.put({ ...row, attempts });
    }),
  );

  await tx.done;
  return abandoned;
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

/**
 * What the server said about a batch.
 *
 * `refused` is the ops it saw and declined, which is a different thing from a
 * batch that never arrived — see MAX_ATTEMPTS.
 */
export interface PostOutcome {
  accepted: string[];
  refused: string[];
}

export type PostFn = (ops: Op[]) => Promise<PostOutcome>;

export async function flush(post: PostFn): Promise<void> {
  if (inFlight) {
    rerun = true;
    return inFlight;
  }
  inFlight = run(post).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(post: PostFn): Promise<void> {
  for (;;) {
    rerun = false;
    const ops = await pending();
    if (ops.length === 0) return;
    // If `post` rejects (offline, server error, session lapsed) this throws
    // out of `run`, the guard above releases, and every op is still in the
    // outbox — nothing was acked, so nothing is lost.
    const { accepted, refused } = await post(ops);
    await ack(accepted);

    const abandoned = await recordRefusals(refused);
    for (const op of abandoned) {
      // Loud, because this is the one path that discards a user's edit. It is
      // still better than the alternative it replaces: a refused op used to sit
      // at the head of the queue forever, so the outbox never drained and the
      // sync banner never cleared.
      console.error(
        `[outbox] giving up on ${op.kind} after ${MAX_ATTEMPTS} refusals`,
        op,
      );
    }

    // A batch of nothing but refusals would otherwise spin: `pending()` still
    // returns rows, so the loop would re-post them until the cap ran out in one
    // tight burst rather than across separate flushes.
    if (!rerun || accepted.length === 0) return;
  }
}
