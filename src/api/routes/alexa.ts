import { OpenAPIHono } from "@hono/zod-openapi";
import {
  SkillRequestSignatureVerifier,
  TimestampVerifier,
} from "ask-sdk-express-adapter";
import {
  NoSuchListError,
  ingestUtterance,
} from "@/lib/services/voice-ingest";
import { speakResult } from "@/lib/voice/speech";

/**
 * The Alexa skill endpoint.
 *
 * Read the constraints before changing anything here, because two of them are
 * platform facts rather than choices:
 *
 * **Alexa cannot speak Swedish.** Custom skills support 17 locales — ar-SA,
 * de-DE, en-AU/CA/GB/IN/US, es-ES/MX/US, fr-CA/FR, hi-IN, it-IT, ja-JP, nl-NL,
 * pt-BR — and sv-SE is not one of them. Amazon says so in the product name on
 * amazon.se ("Swedish language not available"). Putting Swedish words in a
 * custom slot does not help either: the acoustic model is English and
 * transcribes Swedish phonemes into English words BEFORE slot resolution runs.
 * So this endpoint receives English, and English reaches the Swedish catalog
 * through `catalog_item_aliases` — the same mechanism that keeps a merged-away
 * word resolving, seeded with English for the household's varor.
 *
 * **The intuitive version was deleted.** "Alexa, add milk to the shopping list"
 * — with the app subscribed to Alexa's own list — worked through the List
 * Management REST API and list events, both of which Amazon shut off on
 * 1 July 2024. There is no replacement. What remains is an invocation name:
 * "Alexa, tell <name> to add milk". That is worse, it is not fixable from here,
 * and it is why Home Assistant carries the Swedish half of this feature.
 *
 * Mounted outside the Authelia gate, because the caller is Amazon. It is
 * therefore guarded by a signature check that must not be skipped or reordered:
 * verification happens against the RAW body, before anything parses it.
 */

/** Amazon's own tolerance, and the reason a slow home server fails closed. */
const SKILL_ID_ENV = "ALEXA_SKILL_ID";

interface AlexaEnvelope {
  version?: string;
  session?: { user?: { userId?: string } };
  context?: {
    System?: {
      application?: { applicationId?: string };
      user?: { userId?: string };
      person?: { personId?: string };
    };
  };
  request?: {
    type?: string;
    intent?: {
      name?: string;
      slots?: Record<string, { name?: string; value?: string }>;
    };
  };
}

function speak(text: string, endSession = true) {
  return {
    version: "1.0",
    response: {
      outputSpeech: { type: "PlainText", text },
      shouldEndSession: endSession,
    },
  };
}

/**
 * Rebuild a sentence from the skill's slots.
 *
 * The interaction model uses one `AMAZON.SearchQuery` slot, because that is the
 * only built-in that accepts arbitrary words — and Amazon forbids combining it
 * with any other slot in a sample utterance, so quantity cannot arrive
 * separately. Handing the whole phrase to `interpretUtterance` is therefore not
 * a shortcut: it is the only shape available, and it happens to be the one that
 * keeps both adapters on one parser.
 */
function phraseFrom(envelope: AlexaEnvelope): string | null {
  const slots = envelope.request?.intent?.slots;
  if (!slots) return null;
  for (const key of ["item", "items", "query", "SearchQuery"]) {
    const value = slots[key]?.value;
    if (value && value.trim()) return value.trim();
  }
  // Any single filled slot, so renaming it in the interaction model does not
  // silently stop the skill working.
  for (const slot of Object.values(slots)) {
    if (slot?.value && slot.value.trim()) return slot.value.trim();
  }
  return null;
}

export function alexaRoutes() {
  const app = new OpenAPIHono();

  app.post("/", async (c) => {
    const skillId = process.env[SKILL_ID_ENV];
    if (!skillId) {
      // Same rule as VOICE_INGEST_SECRET next door: an unconfigured guard is a
      // closed door, never an open one.
      return c.json(
        { error: `Alexa is not configured (${SKILL_ID_ENV}).` },
        503,
      );
    }

    // RAW body, captured before anything parses it. The signature is over the
    // exact bytes Amazon sent, so a framework that JSON-parses first breaks
    // verification in a way that looks like a key problem.
    const rawBody = await c.req.text();

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    try {
      // Certificate chain, SANs, and the signature itself. Hand-rolling this is
      // how SSRF gets introduced via SignatureCertChainUrl, so it uses Amazon's
      // own verifier.
      await new SkillRequestSignatureVerifier().verify(rawBody, headers);
      // Replay window — Amazon documents a maximum tolerance of 150 seconds.
      await new TimestampVerifier().verify(rawBody);
    } catch (err) {
      console.error("[api/alexa] rejected an unverified request", err);
      return c.json({ error: "Invalid request signature." }, 401);
    }

    let envelope: AlexaEnvelope;
    try {
      envelope = JSON.parse(rawBody) as AlexaEnvelope;
    } catch {
      return c.json({ error: "Malformed request." }, 400);
    }

    /*
     * The applicationId check, which the verifiers deliberately do NOT do.
     *
     * Without it, any Alexa skill in the world could point its endpoint at this
     * URL and write to the household's list: the request would be genuinely
     * signed by Amazon, so the signature check above passes on its own.
     */
    const presentedSkillId =
      envelope.context?.System?.application?.applicationId;
    if (presentedSkillId !== skillId) {
      console.error("[api/alexa] wrong skill id", presentedSkillId);
      return c.json({ error: "Unknown skill." }, 401);
    }

    const type = envelope.request?.type;

    if (type === "LaunchRequest") {
      // Kept open, so "Alexa, open <name>" is usable rather than a dead end.
      return c.json(
        speak("What should I add to the shopping list?", false),
      );
    }

    if (type === "SessionEndedRequest") {
      return c.json({ version: "1.0", response: {} });
    }

    const intent = envelope.request?.intent?.name;

    if (intent === "AMAZON.HelpIntent") {
      return c.json(
        speak(
          "Say something like: add milk and bread. Your list is in Swedish, so I'll match English words to your Swedish items.",
          false,
        ),
      );
    }

    if (intent === "AMAZON.CancelIntent" || intent === "AMAZON.StopIntent") {
      return c.json(speak("Okay."));
    }

    const phrase = phraseFrom(envelope);
    if (!phrase) {
      return c.json(speak("I didn't catch what to add. Try: add milk.", false));
    }

    /*
     * Identity. Alexa's userId is stable per skill per Amazon account, but it
     * is NOT permanent — disabling and re-enabling the skill mints a new one —
     * so it is not used as a key for anything. The actor is configured, because
     * an op's actor must name a real household member for attribution to mean
     * anything, and a household speaker is a household, not a person.
     */
    const actor = process.env.ALEXA_ACTOR ?? process.env.VOICE_ACTOR ?? "alexa";

    try {
      const result = await ingestUtterance({
        phrase,
        actor,
        listId: process.env.ALEXA_LIST_ID || undefined,
      });
      // English reply, Swedish vara names — the names are what the screen will
      // show in the shop, so translating them back would name something the
      // list does not contain.
      return c.json(speak(speakResult(result, "en")));
    } catch (err) {
      if (err instanceof NoSuchListError) {
        return c.json(speak("I couldn't find a shopping list to add that to."));
      }
      console.error("[api/alexa] ingest failed", err);
      // Never a cheerful confirmation on failure: the list is only read in the
      // shop, so a false "added" is discovered at the worst possible moment.
      return c.json(speak("Something went wrong saving that. Please try again."));
    }
  });

  return app;
}
