import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { ops as opsTable } from "@/db/schema";
import { opEvents, type OpAppliedEvent } from "@/lib/services/apply-op";
import type { Op } from "@/lib/sync";
import type { ApiEnv } from "..";
import { opsCatchUpWhere } from "./ops";

const HEARTBEAT_MS = 25_000;

/**
 * Live ops for one list, over SSE.
 *
 * Ordering guarantee: the live listener is attached FIRST, and the catch-up
 * query (same `since`/`listId` semantics as GET /api/ops) runs AFTER that. An
 * op that commits in the gap between the two is therefore delivered twice —
 * once by the catch-up query, once live — never zero times. Delivering it
 * twice is harmless: applyOp's own last-write-wins guard makes re-applying an
 * op the client has already seen a no-op (same `at`/`actor` never beats an
 * identical existing record — see reducer.ts's `wins`). Querying first and
 * subscribing second would instead risk delivering it ZERO times, which is
 * the actual failure this order rules out. Passing `since` (the client's
 * cursor from its last GET /api/ops call) closes the remaining gap: even if
 * the client's own two requests are seconds apart, this route re-does the
 * catch-up itself before going live, so nothing between "I asked for updates"
 * and "I'm listening" is lost.
 */
export function streamRoutes() {
  const app = new Hono<ApiEnv>();

  app.get("/", async (c) => {
    const listId = c.req.query("listId");
    if (!listId) return c.json({ error: "listId is required" }, 400);
    const since = Number(c.req.query("since") ?? "0");

    return streamSSE(c, async (stream) => {
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });

      const onOp = (event: OpAppliedEvent) => {
        if (event.listId !== null && event.listId !== listId) return;
        void stream.writeSSE({
          event: "op",
          data: JSON.stringify({ seq: event.seq, op: event.op }),
        });
      };
      // Subscribed before the backfill query below runs — see module comment.
      opEvents.on("op", onOp);

      try {
        const rows = await db
          .select({ seq: opsTable.seq, payload: opsTable.payload })
          .from(opsTable)
          .where(opsCatchUpWhere(since, listId))
          .orderBy(asc(opsTable.seq));

        for (const row of rows) {
          if (aborted) break;
          await stream.writeSSE({
            event: "op",
            data: JSON.stringify({ seq: row.seq, op: row.payload as Op }),
          });
        }

        // From here on, new ops arrive only via the listener above. This loop
        // just keeps the connection alive: a bare SSE comment line (ignored
        // by EventSource's onmessage) so an idle reverse proxy doesn't decide
        // the connection is dead and kill it. Cleanup on disconnect is
        // bounded by this interval — `aborted` is set immediately on abort,
        // but this loop only checks it once per tick.
        while (!aborted) {
          await stream.sleep(HEARTBEAT_MS);
          if (aborted) break;
          await stream.write(": heartbeat\n\n");
        }
      } finally {
        opEvents.off("op", onOp);
      }
    });
  });

  return app;
}
