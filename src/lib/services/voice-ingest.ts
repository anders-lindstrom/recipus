import { asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { catalogItems, lists } from "@/db/schema";
import type { Amount, Id } from "@/lib/domain";
import { nextOpTimestamp } from "@/lib/client/op-clock";
import type { Op } from "@/lib/sync";
import { interpretUtterance } from "@/lib/voice/interpret";
import { dedupeResolutions, resolveSpokenItems } from "@/lib/voice/resolve";
import { applyOpToDatabase } from "./apply-op";
import { loadMatchCandidates } from "./match-candidates";

/**
 * Putting something on the list by saying it out loud.
 *
 * One ingest path, two adapters in front of it. Home Assistant sends Swedish
 * text from a self-hosted Whisper pipeline; the Alexa skill sends English,
 * because Alexa has no Swedish locale and cannot be given one. Neither adapter
 * gets logic of its own — a second reading of "what did they ask for" would
 * drift from this one, and only one of them would have tests.
 *
 * What this deliberately does NOT do is create varor. The add bar already
 * refuses to let a fuzzy match decide that a word is new, on the grounds that a
 * typo which silently resolves is recoverable and one that silently creates a
 * 343rd catalog item is not. Speech is a much noisier channel than a thumb —
 * English ASR asked to transcribe Swedish grocery words returns near-garbage —
 * and there is no screen to catch it on. So an unmatched phrase comes back
 * unmatched and gets said out loud, which is the only honest answer.
 */

export interface VoiceAdded {
  catalogItemId: Id;
  /** The household's own word, for saying back — not what was heard. */
  name: string;
  amount: Amount | null;
}

export interface VoiceIngestResult {
  listId: Id;
  listName: string;
  added: VoiceAdded[];
  /** Phrases that reached no vara, verbatim as heard. */
  unresolved: string[];
  /** True when the utterance carried no instruction at all. */
  heardNothing: boolean;
}

/**
 * Which list a spoken add lands on.
 *
 * The household has one list per shop and no notion of a "primary" one, so
 * lowest `position` is the answer — the same order the switcher draws, which
 * means the default is whatever sits at the top of that sheet rather than an
 * invisible preference set somewhere else. A caller may name a list outright;
 * an unknown name is refused rather than silently redirected, because putting
 * milk on Bauhaus because "Hemköp" was misheard is worse than saying no.
 */
async function resolveList(listId?: Id): Promise<{ id: Id; name: string } | null> {
  if (listId) {
    const [named] = await db
      .select({ id: lists.id, name: lists.name })
      .from(lists)
      .where(eq(lists.id, listId))
      .limit(1);
    return named ?? null;
  }

  const [first] = await db
    .select({ id: lists.id, name: lists.name })
    .from(lists)
    .where(isNull(lists.deletedAt))
    .orderBy(asc(lists.position))
    .limit(1);
  return first ?? null;
}

export class NoSuchListError extends Error {
  constructor(listId?: string) {
    super(listId ? `Ingen lista med id ${listId}` : "Hushållet har ingen lista");
    this.name = "NoSuchListError";
  }
}

/**
 * Read an utterance, put what it names on a list, and report what happened.
 *
 * Ops are applied one at a time through `applyOpToDatabase`, exactly as the
 * `/api/ops` route does, so a spoken add is indistinguishable downstream from a
 * tapped one: same reducer, same purchase side effects, same catch-up log, same
 * SSE fan-out to every phone in the house.
 */
export async function ingestUtterance(opts: {
  phrase: string;
  actor: string;
  listId?: Id;
  now?: Date;
}): Promise<VoiceIngestResult> {
  const now = opts.now ?? new Date();
  const spoken = interpretUtterance(opts.phrase);

  const list = await resolveList(opts.listId);
  if (!list) throw new NoSuchListError(opts.listId);

  if (spoken.length === 0) {
    return {
      listId: list.id,
      listName: list.name,
      added: [],
      unresolved: [],
      heardNothing: true,
    };
  }

  const candidates = await loadMatchCandidates();
  const resolutions = dedupeResolutions(resolveSpokenItems(spoken, candidates));

  const matched = resolutions.filter((r) => r.status === "matched");
  const unresolved = resolutions
    .filter((r) => r.status === "unknown")
    .map((r) => r.spoken.said);

  // The household's own words for what was matched, so the confirmation says
  // "mjölk" rather than repeating the English that reached it through an alias.
  const names = new Map<Id, string>();
  if (matched.length > 0) {
    const rows = await db
      .select({ id: catalogItems.id, name: catalogItems.name })
      .from(catalogItems)
      .where(
        inArray(
          catalogItems.id,
          matched.map((m) => m.catalogItemId),
        ),
      );
    for (const row of rows) names.set(row.id, row.name);
  }

  const added: VoiceAdded[] = [];
  // Strictly increasing, through the same helper the client uses. Two ops
  // sharing a timestamp cannot be ordered by last-write-wins, so the second
  // would silently lose — and an utterance naming four things dispatches
  // several ops inside one millisecond.
  let lastAt: string | null = null;
  const stamp = (partial: Omit<Op, "clientOpId" | "actor" | "at">): Op => {
    lastAt = nextOpTimestamp(lastAt, now);
    return {
      ...partial,
      clientOpId: `voice:${crypto.randomUUID()}`,
      actor: opts.actor,
      at: lastAt,
    } as Op;
  };

  for (const m of matched) {
    await applyOpToDatabase(
      stamp({
        kind: "add_item",
        listId: list.id,
        catalogItemId: m.catalogItemId,
      } as Omit<Op, "clientOpId" | "actor" | "at">),
      opts.actor,
    );

    if (m.spoken.amount) {
      await applyOpToDatabase(
        stamp({
          kind: "set_amount",
          listId: list.id,
          catalogItemId: m.catalogItemId,
          amount: m.spoken.amount,
        } as Omit<Op, "clientOpId" | "actor" | "at">),
        opts.actor,
      );
    }

    added.push({
      catalogItemId: m.catalogItemId,
      name: names.get(m.catalogItemId) ?? m.spoken.name,
      amount: m.spoken.amount,
    });
  }

  return {
    listId: list.id,
    listName: list.name,
    added,
    unresolved,
    heardNothing: false,
  };
}
