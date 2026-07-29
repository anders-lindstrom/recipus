"use server";

import { headers } from "next/headers";
import { authenticate } from "@/lib/auth";
import { applyOpToDatabase } from "@/lib/services/apply-op";
import type { Op } from "@/lib/sync";

/**
 * The mutation entry point.
 *
 * Every op is authenticated here rather than trusted from the client, and the
 * actor is taken from the proxy header — never from the request body. A client
 * that could name its own actor could attribute a purchase to anyone, which
 * would quietly poison the cadence engine's per-household history.
 */
export async function submitOps(
  ops: Op[],
): Promise<{ results: Array<{ clientOpId: string; seq: number }> }> {
  const user = authenticate(await headers());

  const results = [];
  for (const op of ops) {
    // Ops are applied in the order the client queued them. They are individually
    // order-independent by construction, but preserving submission order keeps
    // the op log readable when something needs debugging later.
    const result = await applyOpToDatabase({ ...op, actor: user.autheliaUser });
    results.push({ clientOpId: result.clientOpId, seq: result.seq });
  }
  return { results };
}
