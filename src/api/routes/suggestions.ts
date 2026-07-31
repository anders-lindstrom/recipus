import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  dismissSuggestion,
  restoreSuggestion,
} from "@/lib/services/suggestion-dismissals";
import type { ApiEnv } from "..";
import { errorSchema, jsonBody, jsonRes } from "../schemas";

/**
 * "Inte den här gången".
 *
 * Plain endpoints rather than ops, deliberately. A dismissal is append-only and
 * commutative — the primary key is (item, day), so two devices declining the
 * same suggestion write the same row and there is nothing for last-write-wins to
 * resolve. That is the same reasoning that keeps `purchases` out of the reducer.
 * Putting these through the op log would buy conflict resolution for a value
 * that cannot conflict, and would leave a permanent entry in the catch-up log
 * for something that is meaningless by tomorrow.
 *
 * The consequence, stated so nobody has to rediscover it: dismissing needs the
 * network. The client hides the tile optimistically so the gesture always feels
 * like it worked, and the worst case offline is that the suggestion is back
 * after the next hydrate.
 *
 * Dismissals are HOUSEHOLD-WIDE — no actor is recorded and none is wanted. Two
 * people shopping from one list should not each have to decline the same thing.
 */

const dismissalBody = z
  .object({ catalogItemId: z.string().min(1) })
  .openapi("SuggestionDismissal");

export function suggestionsRoutes() {
  const app = new OpenAPIHono<ApiEnv>();

  app.openapi(
    createRoute({
      method: "post",
      path: "/dismissals",
      tags: ["suggestions"],
      description:
        "Silence one cadence suggestion for the rest of the local day, for the whole household. Idempotent: dismissing twice, or from two devices, writes the same row.",
      request: { body: jsonBody(dismissalBody) },
      responses: {
        204: { description: "Dismissed" },
        401: jsonRes(errorSchema, "Not authenticated"),
      },
    }),
    async (c) => {
      const { catalogItemId } = c.req.valid("json");
      // Server clock, not the client's. Unlike an op's `at` — which is the
      // client's on purpose, so an offline edit does not lose every comparison —
      // "the rest of today" is a question about the household's day as the
      // server reckons it, and a phone with a wrong date would otherwise silence
      // a suggestion on a day nobody is living in.
      await dismissSuggestion(catalogItemId, new Date());
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/dismissals/{catalogItemId}",
      tags: ["suggestions"],
      description:
        "Undo a dismissal made today. Safe to call for something that was never dismissed — the outcome is the same either way, which is what lets the client's Ångra be tapped twice.",
      request: {
        params: z.object({
          catalogItemId: z
            .string()
            .min(1)
            .openapi({ param: { name: "catalogItemId", in: "path" } }),
        }),
      },
      responses: {
        204: { description: "Restored" },
        401: jsonRes(errorSchema, "Not authenticated"),
      },
    }),
    async (c) => {
      const { catalogItemId } = c.req.valid("param");
      await restoreSuggestion(catalogItemId, new Date());
      return c.body(null, 204);
    },
  );

  return app;
}
