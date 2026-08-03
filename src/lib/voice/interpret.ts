import type { Amount } from "@/lib/domain";
import { splitQuery } from "@/lib/services/search";
import { parseAmount, parseQuantityPrefix } from "@/lib/units";

/**
 * What a person said, read as a list of things to buy.
 *
 * Pure, and deliberately knows nothing about the catalog. Turning "mjölk" into
 * a vara is a database question answered downstream by `matchIngredient`
 * against `loadMatchCandidates`, which is the only matcher that consults
 * aliases — and aliases are the whole reason an English-speaking Echo can reach
 * a Swedish catalog at all. This layer's single job is to get from a sentence
 * to the words that name things, and it is separate so that job can be argued
 * about in a test rather than in a kitchen.
 *
 * Both adapters come through here. Home Assistant hands over Swedish free text
 * from Whisper; the Alexa adapter reassembles its slots into the same shape
 * ("2 l milk") rather than getting a parser of its own, because two readings of
 * "what did they ask for" would drift and only one of them would be tested.
 */

export interface SpokenItem {
  /** The words naming the thing, with any quantity peeled off. */
  name: string;
  /** The quantity heard, or null for "some, unspecified" — right for bread. */
  amount: Amount | null;
  /** The part as heard, kept verbatim so a failure can be repeated back. */
  said: string;
}

/**
 * Ways of saying "put this on the list", in both languages the household uses.
 *
 * Stripped rather than matched, because a carrier phrase is the one part of the
 * sentence that carries no information: every utterance reaching this endpoint
 * is already an instruction to add something. Leaving them in would send "add
 * milk" to the matcher, where "add" is four characters from "ägg" and well
 * inside the fuzzy budget for a query that long.
 *
 * Longest first, so a short prefix never wins over the longer one containing
 * it — "lägg" must not strip out of "lägg till" and leave "till" behind.
 */
const CARRIER_PREFIXES = [
  // Swedish — what gets said to Home Assistant.
  "kan du lägga till",
  "skulle du kunna lägga till",
  "jag behöver",
  "vi behöver",
  "vi måste köpa",
  "lägga till",
  "lägg till",
  "skriv upp",
  "sätt upp",
  "handla",
  // Both forms, longest first: "jag behöver köpa mjölk" strips to "köpa mjölk",
  // and an infinitive that only matched "köp" would leave a stray "a".
  "köpa",
  "köp",
  // English — what gets said to Alexa, which cannot speak Swedish.
  "could you please add",
  "could you add",
  "please add",
  "i need to buy",
  "we need to buy",
  "i need",
  "we need",
  "remind me to buy",
  "add",
  "buy",
  "get",
  "put",
];

/**
 * Ways of naming the list at the end of a sentence.
 *
 * Removed for the same reason as the prefixes, and separately because Alexa's
 * own phrasing puts it here: "add milk to the shopping list" arrives with four
 * words of destination that would otherwise be read as part of the vara.
 */
const CARRIER_SUFFIXES = [
  "på inköpslistan",
  "på handlingslistan",
  "på handlelistan",
  "till inköpslistan",
  "till handlingslistan",
  "till listan",
  "på listan",
  "to the shopping list",
  "to my shopping list",
  "to the grocery list",
  "to my grocery list",
  "to the list",
  "to my list",
  "on the shopping list",
  "on the list",
];

/**
 * Where one thing ends and the next begins.
 *
 * "och" is safe to split on because no vara in the catalog contains it — the
 * seed data was checked. `resolvePair` next door already reads "salt och
 * peppar" as two varor for the add bar, but only ever as a bare PAIR; someone
 * talking to a speaker says three or four things in one breath, and the
 * remainder would simply be lost.
 */
const SEPARATORS = /\s*,\s*|\s+(?:och|and|samt|plus)\s+/i;

function stripOnce(text: string, phrases: readonly string[], where: "start" | "end"): string | null {
  const lower = text.toLowerCase();
  for (const phrase of phrases) {
    if (where === "start") {
      // The space matters: "add" must not strip the front off "addera".
      if (lower === phrase) return "";
      if (lower.startsWith(`${phrase} `)) return text.slice(phrase.length + 1).trim();
    } else {
      if (lower === phrase) return "";
      if (lower.endsWith(` ${phrase}`)) return text.slice(0, text.length - phrase.length - 1).trim();
    }
  }
  return null;
}

/**
 * Peel every carrier phrase off, not just the first.
 *
 * "kan du lägga till mjölk på inköpslistan" carries one at each end, and
 * "please add milk to the list" carries one of each in English. Looped because
 * stripping one can expose another — "jag behöver köpa mjölk" is two prefixes
 * stacked — and bounded so a pathological input cannot spin.
 */
function stripCarriers(raw: string): string {
  let text = raw.trim().replace(/\s+/g, " ");
  for (let i = 0; i < 4; i++) {
    const withoutPrefix = stripOnce(text, CARRIER_PREFIXES, "start");
    if (withoutPrefix !== null) {
      text = withoutPrefix;
      continue;
    }
    const withoutSuffix = stripOnce(text, CARRIER_SUFFIXES, "end");
    if (withoutSuffix !== null) {
      text = withoutSuffix;
      continue;
    }
    break;
  }
  return (
    text
      .replace(/[.!?]+$/, "")
      // A conjunction left hanging at the end — "mjölk och" — is someone who
      // trailed off, or a transcriber that caught the start of a word the
      // speaker abandoned. SEPARATORS needs whitespace on both sides, so this
      // would otherwise survive into the vara name.
      .replace(/\s+(?:och|and|samt|plus)$/i, "")
      .trim()
  );
}

/**
 * Read an utterance as the things it asks for.
 *
 * Returns an empty array when nothing survives — an utterance that was pure
 * carrier phrase ("add something to the list"), or silence. The caller says so
 * out loud rather than guessing, because the one unrecoverable outcome for a
 * voice assistant is cheerfully confirming an add that never happened.
 */
export function interpretUtterance(raw: string): SpokenItem[] {
  const stripped = stripCarriers(raw);
  if (!stripped) return [];

  const items: SpokenItem[] = [];
  for (const part of stripped.split(SEPARATORS)) {
    // A trailing "och" leaves an empty part, as does "milk,,bread".
    const said = part.trim();
    if (!said) continue;

    // The same splitter the add bar types into, so "2 l mjölk", "mjölk 2 l" and
    // "banan 3 st mogen" mean here exactly what they mean there. One
    // implementation of "2 l" in the codebase, as the add bar's own comment
    // insists.
    const { name, amountText } = splitQuery(said);
    const trimmedName = name.trim();
    if (!trimmedName) continue;

    items.push({
      name: trimmedName,
      /*
       * Two readings, because `splitQuery` hands back the amount as TEXT and
       * some quantities only parse in place. "en gurka" splits into name
       * "gurka" and amountText "en", and `parseAmount("en")` is null — the word
       * form is only recognised by `parseQuantityPrefix`, which requires
       * something to follow it so that "en" alone, or the start of "energisk",
       * is not read as a quantity. Falling back to the whole phrase gives that
       * rule the context it needs.
       */
      amount: amountText
        ? (parseAmount(amountText) ?? parseQuantityPrefix(said).amount)
        : null,
      said,
    });
  }

  return items;
}
