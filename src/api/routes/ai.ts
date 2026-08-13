import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { parseForList } from "@/lib/services/ai-add";
import { takeSharedImage } from "@/lib/services/share-inbox";
import type { ApiEnv } from "..";
import { amountSchema, errorSchema, jsonBody, jsonRes } from "../schemas";

/**
 * Reading a photo, a paste or a spoken sentence as varor.
 *
 * Inside the Authelia gate, unlike `/api/voice` — the caller is a browser with
 * a session, so inventing a second secret would be inventing a second thing to
 * leak. And unlike `/api/voice`, this endpoint writes NOTHING. It answers a
 * dialog, and the dialog's own button writes the ops through the list's normal
 * optimistic path.
 */

/** ~8 MB of base64 is ~6 MB of JPEG; the client sends far less. See §3. */
const MAX_IMAGE_CHARS = 8_000_000;

const parseBody = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), text: z.string().min(1).max(8000) }),
    z.object({
      kind: z.literal("image"),
      data: z.string().min(1).max(MAX_IMAGE_CHARS),
      mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    }),
    z.object({ kind: z.literal("share"), token: z.string().min(1).max(128) }),
  ])
  .openapi("AiParseRequest");

const rowSchema = z.object({
  id: z.string(),
  said: z.string(),
  name: z.string(),
  amount: amountSchema.nullable(),
  catalogItemId: z.string().nullable(),
  group: z.enum(["list", "other"]),
});

const parseResult = z
  .object({
    rows: z.array(rowSchema),
    usedModel: z
      .boolean()
      .describe("False when text was read deterministically because the model was unavailable"),
  })
  .openapi("AiParseResult");

export function aiRoutes() {
  const app = new OpenAPIHono<ApiEnv>();

  app.openapi(
    createRoute({
      method: "post",
      path: "/parse",
      tags: ["ai"],
      description:
        "Read an image, a clump of text or a transcript as the varor it names. Writes nothing — the rows come back for review.",
      request: { body: jsonBody(parseBody) },
      responses: {
        200: jsonRes(parseResult, "What was understood"),
        404: jsonRes(errorSchema, "The shared image is gone"),
        503: jsonRes(errorSchema, "ANTHROPIC_API_KEY is not configured"),
      },
    }),
    async (c) => {
      const body = c.req.valid("json");

      if (body.kind === "share") {
        const image = takeSharedImage(body.token, c.get("actor"));
        if (!image) {
          return c.json(
            { error: "Den delade bilden är borta. Dela den igen." },
            404,
          );
        }
        if (!process.env.ANTHROPIC_API_KEY) {
          return c.json({ error: "Bildtolkning är inte konfigurerad (ANTHROPIC_API_KEY)." }, 503);
        }
        return c.json(await parseForList({ kind: "image", ...image }), 200);
      }

      if (body.kind === "image" && !process.env.ANTHROPIC_API_KEY) {
        // Text has a way through without a key; an image does not, and saying
        // which knob is missing beats an empty result that looks like a bug.
        return c.json({ error: "Bildtolkning är inte konfigurerad (ANTHROPIC_API_KEY)." }, 503);
      }

      return c.json(await parseForList(body), 200);
    },
  );

  return app;
}
