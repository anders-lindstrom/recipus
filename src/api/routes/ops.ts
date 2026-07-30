import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, gt, isNull, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { ops as opsTable } from "@/db/schema";
import { applyOpToDatabase } from "@/lib/services/apply-op";
import type { Op } from "@/lib/sync";
import type { ApiEnv } from "..";
import { jsonBody, jsonRes, opEnvelopeSchema, opResultSchema, opSchema } from "../schemas";

/**
 * The WHERE clause for "ops after `since`, relevant to `listId`" — shared by
 * the catch-up route below and by the SSE stream's own internal backfill
 * (routes/stream.ts), so the two can never quietly disagree about what counts
 * as "relevant". Household-wide catalog ops (list_id IS NULL) always count,
 * since every open list needs to see catalog changes too.
 */
export function opsCatchUpWhere(since: number, listId?: string): SQL | undefined {
  const base = gt(opsTable.seq, since);
  if (!listId) return base;
  return and(base, or(eq(opsTable.listId, listId), isNull(opsTable.listId)));
}

export function opsRoutes() {
  const app = new OpenAPIHono<ApiEnv>();

  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["ops"],
      description:
        "Apply a batch of ops, strictly in the order given. Idempotent per clientOpId — a retried op returns its original seq rather than re-applying. Partial success is normal: one op failing (e.g. a stale reference, or a kind this server does not know) does not abort the rest of the batch, and the caller should check each result individually.",
      // Loose on the envelope, strict per op.
      //
      // This used to validate `opSchema.array()`, which rejected the WHOLE body
      // if any single op failed to parse. A client running a newer build than
      // the server — an image rollback is enough — therefore had its entire
      // outbox 400'd, acked nothing, and re-posted the same batch forever. The
      // route already documents partial success as normal; validating the batch
      // as a unit meant that promise could never be kept.
      //
      // `clientOpId` and `kind` are still required, because a result has to name
      // the op it answers for. Everything else is checked op by op below.
      request: {
        body: jsonBody(
          z.object({
            ops: z
              .looseObject({ clientOpId: z.string(), kind: z.string() })
              .array(),
          }),
        ),
      },
      responses: {
        200: jsonRes(z.object({ results: opResultSchema.array() }), "Per-op results"),
      },
    }),
    async (c) => {
      const actor = c.get("actor");
      const { ops } = c.req.valid("json");

      const results: Array<{ clientOpId: string; seq?: number; error?: string }> = [];
      // Sequential, not parallel: a client that creates a catalog item and
      // adds it to a list in the same flush relies on the create committing
      // before the add is attempted (list_entries.catalog_item_id is a real
      // FK). Running the batch concurrently would let that race either way.
      for (const raw of ops) {
        // Per-op parse. An op this server does not understand becomes one
        // `error` result and nothing more: the client can then ack it as
        // permanently rejected and stop retrying, instead of the whole batch
        // failing and the outbox looping.
        const parsed = opSchema.safeParse(raw);
        if (!parsed.success) {
          results.push({
            clientOpId: raw.clientOpId,
            error: `Ogiltig operation (${raw.kind}): ${parsed.error.issues[0]?.message ?? "kunde inte tolkas"}`,
          });
          continue;
        }

        try {
          const { seq } = await applyOpToDatabase(parsed.data as Op, actor);
          results.push({ clientOpId: raw.clientOpId, seq });
        } catch (err) {
          // Logged server-side as well as returned. The client only ever saw a
          // one-line message, so the cause of a refused op — which is now a
          // thing the client counts and eventually gives up on — was invisible
          // to whoever had to diagnose it.
          console.error("[api/ops] op failed", raw.kind, raw.clientOpId, err);
          results.push({
            clientOpId: raw.clientOpId,
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }
      return c.json({ results }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["ops"],
      description:
        "Ops after `since`, ascending — the reconnect catch-up. Call this BEFORE attaching /api/stream so nothing falls through the gap between the two (see that route's comment for exactly why that order is safe).",
      request: {
        query: z.object({
          since: z.coerce.number().int().min(0),
          listId: z.string().optional(),
        }),
      },
      responses: { 200: jsonRes(opEnvelopeSchema.array(), "Ops, oldest first") },
    }),
    async (c) => {
      const { since, listId } = c.req.valid("query");
      const rows = await db
        .select({ seq: opsTable.seq, payload: opsTable.payload })
        .from(opsTable)
        .where(opsCatchUpWhere(since, listId))
        .orderBy(asc(opsTable.seq));
      return c.json(
        rows.map((r) => ({ seq: r.seq, op: r.payload as Op })),
        200,
      );
    },
  );

  return app;
}
