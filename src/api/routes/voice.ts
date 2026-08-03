import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { timingSafeEqual } from "@/lib/auth";
import {
  NoSuchListError,
  ingestUtterance,
} from "@/lib/services/voice-ingest";
import { speakResult } from "@/lib/voice/speech";
import { errorSchema, jsonBody, jsonRes } from "../schemas";

/**
 * Adding to the list by voice, for Home Assistant.
 *
 * Mounted OUTSIDE the Authelia gate and authenticated by a bearer token of its
 * own, because the caller is a machine on the LAN with no browser session and
 * no way to complete a 2FA challenge. That makes this the one door into the app
 * that Authelia does not stand in front of, so it carries its own lock and
 * refuses to exist without one: a missing `VOICE_INGEST_SECRET` is a 503 rather
 * than an open endpoint. The same reasoning as `authenticate()` refusing to
 * start without `PROXY_AUTH_SECRET` — a secret whose absence silently disables
 * auth is discovered by somebody else finding your shopping list.
 *
 * Home Assistant is the Swedish half of the voice story. Alexa cannot be:
 * Amazon supports 17 custom-skill locales and Swedish is not among them, and
 * an English acoustic model transcribes Swedish grocery words into English ones
 * before any slot resolution runs. So a self-hosted Whisper pipeline is the
 * only route by which "lägg till mjölk" reaches this app as those words.
 */

const utteranceBody = z
  .object({
    /** What was heard, as one sentence. May name several things. */
    phrase: z.string().min(1).max(500),
    /** Which list. Omitted means the household's first one — see `resolveList`. */
    listId: z.string().min(1).optional(),
    /**
     * Who is speaking, if the pipeline knows.
     *
     * Optional because HA's own speaker identification is not something to
     * depend on. Falls back to `VOICE_ACTOR`, which must name a real household
     * member: ops carry an actor for attribution, and "who added the milk" is a
     * question the entry sheet answers out loud.
     */
    speaker: z.string().min(1).max(64).optional(),
    /** Language for the spoken reply. The vara names stay Swedish either way. */
    locale: z.enum(["sv", "en"]).default("sv"),
  })
  .openapi("VoiceUtterance");

const utteranceResult = z
  .object({
    /** Ready to be spoken by the caller's TTS, in the requested locale. */
    speech: z.string(),
    listId: z.string(),
    listName: z.string(),
    added: z
      .array(
        z.object({
          catalogItemId: z.string(),
          name: z.string(),
          amount: z
            .object({ value: z.number(), unit: z.string() })
            .nullable(),
        }),
      )
      .describe("What actually went on the list, in the household's own words"),
    unresolved: z
      .array(z.string())
      .describe("Phrases that reached no vara, verbatim as heard"),
  })
  .openapi("VoiceUtteranceResult");

/**
 * The shared secret, or null when the deployment has not set one.
 *
 * Read per request rather than at module load so a container that starts before
 * its environment is complete fails loudly on use rather than caching an empty
 * string and comparing everything against it.
 */
function ingestSecret(): string | null {
  const secret = process.env.VOICE_INGEST_SECRET;
  return secret && secret.length > 0 ? secret : null;
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

export function voiceRoutes() {
  const app = new OpenAPIHono();

  app.openapi(
    createRoute({
      method: "post",
      path: "/utterance",
      tags: ["voice"],
      description:
        "Add what a sentence names to a list. Authenticated with a bearer token rather than through Authelia, because the caller is Home Assistant rather than a browser. Never creates a vara: an unmatched phrase comes back in `unresolved` and is spoken aloud.",
      request: { body: jsonBody(utteranceBody) },
      responses: {
        200: jsonRes(utteranceResult, "What was added, and what was not"),
        401: jsonRes(errorSchema, "Bad or missing bearer token"),
        404: jsonRes(errorSchema, "No such list"),
        503: jsonRes(errorSchema, "VOICE_INGEST_SECRET is not configured"),
      },
    }),
    async (c) => {
      const secret = ingestSecret();
      if (!secret) {
        // Refusing loudly rather than falling back to "no auth needed". An
        // unconfigured secret must never mean an open write endpoint.
        return c.json(
          { error: "Röstinmatning är inte konfigurerad (VOICE_INGEST_SECRET)." },
          503,
        );
      }

      const presented = bearer(c.req.header("authorization"));
      if (!presented || !timingSafeEqual(presented, secret)) {
        return c.json({ error: "Fel eller saknad nyckel." }, 401);
      }

      const { phrase, listId, speaker, locale } = c.req.valid("json");
      const actor = speaker ?? process.env.VOICE_ACTOR ?? "rost";

      try {
        const result = await ingestUtterance({ phrase, actor, listId });
        return c.json(
          {
            speech: speakResult(result, locale),
            listId: result.listId,
            listName: result.listName,
            added: result.added,
            unresolved: result.unresolved,
          },
          200,
        );
      } catch (err) {
        if (err instanceof NoSuchListError) {
          return c.json({ error: err.message }, 404);
        }
        throw err;
      }
    },
  );

  return app;
}
