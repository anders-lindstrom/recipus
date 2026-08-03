import { formatAmount } from "@/lib/units";
import type { VoiceIngestResult } from "@/lib/services/voice-ingest";

/**
 * What the speaker says back.
 *
 * Kept pure and out of the routes because the wording IS the feature. A voice
 * assistant has no screen, so the reply is the only evidence the household gets
 * that anything happened, and the one unrecoverable outcome is a cheerful
 * "added!" for something that did not go on the list — discovered in the shop,
 * which is the worst possible moment.
 *
 * So: every reply names what landed, and every reply names what did not. There
 * is deliberately no short "OK" path.
 */

export type SpeechLocale = "sv" | "en";

/** "mjölk, bröd och ägg" / "milk, bread and eggs". */
function joinNames(names: string[], locale: SpeechLocale): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  const and = locale === "sv" ? "och" : "and";
  return `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`;
}

/** "2 l mjölk" when a quantity was heard, plain "mjölk" when it was not. */
function withAmount(added: VoiceIngestResult["added"][number]): string {
  return added.amount ? `${formatAmount(added.amount)} ${added.name}` : added.name;
}

/**
 * The whole reply, in the language the device speaks.
 *
 * Both locales exist because the two adapters cannot share one: Home Assistant
 * runs a Swedish pipeline and Alexa physically cannot, so the same result has
 * to be sayable either way. The vara NAMES stay Swedish in both — they are the
 * household's own words and what is written on the list you will read in the
 * shop, so translating them back into English would name something the screen
 * does not show.
 */
export function speakResult(result: VoiceIngestResult, locale: SpeechLocale): string {
  const sv = locale === "sv";

  if (result.heardNothing) {
    return sv
      ? "Jag uppfattade inget att lägga till."
      : "I didn't catch anything to add.";
  }

  const added = result.added.map(withAmount);
  const parts: string[] = [];

  if (added.length > 0) {
    const names = joinNames(added, locale);
    parts.push(
      sv
        ? `La till ${names} på ${result.listName}.`
        : `Added ${names} to ${result.listName}.`,
    );
  }

  if (result.unresolved.length > 0) {
    const names = joinNames(result.unresolved, locale);
    // Named rather than counted, and never folded into the success sentence.
    // "I added 2 of 3 things" leaves the household to work out which one is
    // missing, and they will work it out in the shop.
    parts.push(
      sv
        ? `Jag hittade ingen vara för ${names}.`
        : `I couldn't find ${names} in your list.`,
    );
  }

  if (parts.length === 0) {
    return sv
      ? "Jag uppfattade inget att lägga till."
      : "I didn't catch anything to add.";
  }

  return parts.join(" ");
}
