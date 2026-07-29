import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { loadLists, loadListSnapshot } from "@/lib/services/list-data";
import type { ApiEnv } from "..";
import { errorSchema, jsonRes, listSchema, listSnapshotSchema } from "../schemas";

const idParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

export function listsRoutes() {
  const app = new OpenAPIHono<ApiEnv>();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["lists"],
      description: "All lists, in their display order.",
      responses: { 200: jsonRes(listSchema.array(), "Lists") },
    }),
    async (c) => {
      const rows = await loadLists();
      return c.json(rows, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/{id}/snapshot",
      tags: ["lists"],
      description:
        "The client's hydration payload for one list: the list itself, categories, catalog, entries, contributions, live recipe additions, and ranked cadence suggestions.",
      request: { params: idParam },
      responses: {
        200: jsonRes(listSnapshotSchema, "Snapshot"),
        404: jsonRes(errorSchema, "Not found"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const snapshot = await loadListSnapshot(id, new Date());
      if (!snapshot) return c.json({ error: "Not found" }, 404);
      return c.json(snapshot, 200);
    },
  );

  return app;
}
