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
        "Apply a batch of ops, strictly in the order given. Idempotent per clientOpId — a retried op returns its original seq rather than re-applying. Partial success is normal: one op failing (e.g. a stale reference) does not abort the rest of the batch, and the caller should check each result individually.",
      request: { body: jsonBody(z.object({ ops: opSchema.array() })) },
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
      for (const op of ops) {
        try {
          const { seq } = await applyOpToDatabase(op as Op, actor);
          results.push({ clientOpId: op.clientOpId, seq });
        } catch (err) {
          results.push({
            clientOpId: op.clientOpId,
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
