import { catalogOrderScore } from "@/lib/cadence";
import type { CatalogItem } from "@/lib/domain";
import { parseQuantityPrefix } from "@/lib/units";
import { normalizeName } from "@/lib/utils";

/**
 * Catalog search and inline quantity parsing for the add bar.
 *
 * Pure on purpose — this is the fast path onto the list, and its behaviour is
 * far easier to pin down in tests than in a browser.
 */

const MAX_SUGGESTIONS = 6;

/**
 * Score tiers, worst-to-best downwards. Floats because INFLECTION had to be
 * slotted between two tiers that already existed and renumbering them would
 * have rewritten every test that pins an ordering.
 */
const SCORE_EXACT = 0;
/** The catalog name starts with what was typed: "mj" -> "mjölk". */
const SCORE_PREFIX = 1;
/** What was typed starts with the catalog name: "tomater" -> "tomat". */
const SCORE_INFLECTION = 1.5;
/** A later word of the name starts with the query: "lök" -> "gul lök". */
const SCORE_WORD_PREFIX = 2;
/** The name merely contains the query: "mjölk" -> "havremjölk". */
const SCORE_CONTAINS = 3;
/** Nothing matched literally; this is a typo tolerance hit. */
const SCORE_FUZZY = 4;

/**
 * The endings a query may add to a catalog name and still be the same vara.
 *
 * Spelled out rather than capped by length, and the difference is not
 * pedantry: a plain "at most three more characters" rule reads *mjölk* as an
 * inflection of *mjöl*, so typing the most-bought item in the catalog suggests
 * flour second. Swedish plural and definite endings are a closed set, "k" is
 * not in it, and listing them costs one array.
 *
 * Longest first, so the check never stops at a shorter ending that happens to
 * be a suffix of the right one.
 */
const INFLECTIONS = [
  "orna",
  "erna",
  "arna",
  "rna",
  "ena",
  "er",
  "ar",
  "or",
  "en",
  "et",
  "na",
  "ns",
  "ts",
  "a",
  "n",
  "t",
  "s",
];

/** Is `q` the catalog name `n` with a Swedish plural or definite ending? */
function isInflectionOf(q: string, n: string): boolean {
  if (!q.startsWith(n) || q.length === n.length) return false;
  const ending = q.slice(n.length);
  return INFLECTIONS.includes(ending);
}

/**
 * Typo tolerance.
 *
 * Queries this short are not fuzzy-matched at all. At three characters almost
 * everything is one edit from everything else — "ost" reaches *ris*, *ris*
 * reaches *ros* — and the tier stops carrying information. The budget then
 * grows with the query, because a longer word both affords more slips and is
 * far less likely to collide by accident.
 */
const FUZZY_MIN_QUERY_LENGTH = 4;

function fuzzyBudget(queryLength: number): number {
  if (queryLength < FUZZY_MIN_QUERY_LENGTH) return 0;
  return queryLength <= 5 ? 1 : 2;
}

/**
 * Damerau-Levenshtein distance, abandoned as soon as it exceeds `max`.
 *
 * Transpositions count as one edit rather than two, which is the whole reason
 * this is not plain Levenshtein: "mjölk" typed with a thumb comes out "mjökl"
 * about as often as it comes out "mjök", and plain Levenshtein scores the
 * transposition twice as bad as the dropped letter. They are the same slip.
 *
 * Returns null rather than a number when the distance is over budget, so
 * callers cannot accidentally use a distance that was never fully computed.
 */
export function boundedEditDistance(
  a: string,
  b: string,
  max: number,
): number | null {
  if (max <= 0) return a === b ? 0 : null;
  // A length gap wider than the budget cannot be closed, and this prunes the
  // overwhelming majority of a catalog before any table is allocated.
  if (Math.abs(a.length - b.length) > max) return null;

  // Three rows: the one before last is what a transposition reaches back to.
  let beforePrev: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i++) {
    const row: number[] = new Array(b.length + 1);
    row[0] = i;
    let best = row[0];

    for (let j = 1; j <= b.length; j++) {
      const substitution = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, substitution);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, beforePrev[j - 2] + 1);
      }
      row[j] = value;
      if (value < best) best = value;
    }

    // Every cell in this row is already over budget, so every row below it will
    // be too — distances never decrease going down.
    if (best > max) return null;

    beforePrev = prev;
    prev = row;
  }

  return prev[b.length] <= max ? prev[b.length] : null;
}

/**
 * The closest a query gets to a catalog name, trying the whole name and each of
 * its words.
 *
 * Per-word matters for the multi-word names the registry produces: "gul lök"
 * should still be reachable from a fumbled "lok" even though the distance from
 * the full name is four.
 */
function fuzzyDistance(query: string, name: string, max: number): number | null {
  let best = boundedEditDistance(query, name, max);
  if (best === 0) return 0;

  for (const word of name.split(" ")) {
    if (word === name) continue;
    const d = boundedEditDistance(query, word, best === null ? max : best - 1);
    if (d !== null && (best === null || d < best)) best = d;
    if (best === 0) return 0;
  }
  return best;
}

interface Scored {
  item: CatalogItem;
  score: number;
  /** Edit distance for fuzzy hits; 0 for everything that matched literally. */
  distance: number;
}

/**
 * Rank catalog matches for a query.
 *
 * Prefix beats substring, because someone typing "mj" wants "mjölk" long before
 * "havremjölk". Beyond that it is the catalog's own recency/frequency ordering,
 * which is what makes the list feel like yours after a few shops.
 *
 * Two tiers sit outside that story and are worth knowing about:
 *
 * **Inflection**, because every literal tier asks whether the catalog name
 * contains the query and none asked the reverse — so "tomater", the way anyone
 * actually refers to the vegetable, reached *krossade tomater* and *passerade
 * tomater* but never plain *tomat*.
 *
 * **Fuzzy**, last and only ever last, because this is typed with one thumb
 * while walking. It cannot outrank anything that matched literally, and it
 * deliberately does not feed the "create a new item" decision — see
 * `resolveQuery`. A typo that silently resolves is a recoverable annoyance; a
 * typo that silently creates a 343rd catalog item is permanent.
 */
export function rankMatches(
  catalog: CatalogItem[],
  query: string,
  limit: number,
  now: Date,
): CatalogItem[] {
  const q = normalizeName(query);
  if (!q) return [];

  const budget = fuzzyBudget(q.length);
  const scored: Scored[] = [];

  for (const item of catalog) {
    const name = item.nameNorm;
    if (!name) continue;

    let score: number;
    if (name === q) score = SCORE_EXACT;
    else if (name.startsWith(q)) score = SCORE_PREFIX;
    else if (isInflectionOf(q, name)) score = SCORE_INFLECTION;
    // Start of any later word, so "lök" finds "gul lök".
    else if (name.split(" ").some((w) => w.startsWith(q))) score = SCORE_WORD_PREFIX;
    else if (name.includes(q)) score = SCORE_CONTAINS;
    else {
      if (budget === 0) continue;
      const distance = fuzzyDistance(q, name, budget);
      if (distance === null) continue;
      scored.push({ item, score: SCORE_FUZZY, distance });
      continue;
    }

    scored.push({ item, score, distance: 0 });
  }

  return scored
    .sort(
      (a, b) =>
        /*
         * Hidden varor sort BELOW everything, whatever they matched on.
         *
         * Demoted rather than dropped, and the difference is what keeps hiding
         * from being a trap. Filtering them out here would mean typing the exact
         * name of a vara you hid last month returns nothing and offers to create
         * it again — a second vara with the same word, and the first one's
         * purchase history stranded on the one you can no longer reach. Sorting
         * them last means the household never trips over them by accident and
         * can always still find one on purpose; the add bar draws them as
         * "dold" and taking one puts it straight back.
         */
        Number(a.item.hidden) - Number(b.item.hidden) ||
        a.score - b.score ||
        a.distance - b.distance ||
        /*
         * The catalog's own recency+frequency ordering, decayed — the SAME
         * function the catalog well is sorted by, deliberately.
         *
         * These two orderings sit inches apart on one screen over one set of
         * 341 varor, and a raw `useCount` here made them disagree in a way that
         * only ever got worse: usage counted forever, so a vara bought forty
         * times last winter outranked one bought eight times this month, and a
         * household that switched from lättmjölk to mellanmjölk went on being
         * offered lättmjölk first for the life of the install.
         *
         * `useCount` survives as the tie-break, and it fires in exactly one
         * situation rather than generally: `catalogOrderScore` returns 0 only
         * when `lastUsedAt` is null, and the two columns are written together
         * everywhere (`apply-op.ts`, `seed.ts`) with purchases never pruned — so
         * `useCount > 0` implies a non-null `lastUsedAt`. The scores are
         * therefore equal only when BOTH varor are untouched, which is the whole
         * seeded catalog on a fresh install. That is the case this exists for;
         * it is not a general "more-used wins" rule, and reading it as one would
         * be wrong.
         */
        catalogOrderScore(
          b.item.useCount,
          b.item.lastUsedAt ? new Date(b.item.lastUsedAt) : null,
          now,
        ) -
          catalogOrderScore(
            a.item.useCount,
            a.item.lastUsedAt ? new Date(a.item.lastUsedAt) : null,
            now,
          ) ||
        b.item.useCount - a.item.useCount ||
        a.item.name.localeCompare(b.item.name, "sv"),
    )
    .slice(0, limit)
    .map((s) => s.item);
}

/**
 * Split "mjölk 2 l" into a name and a trailing amount.
 *
 * The quantity may lead ("2 l mjölk") or trail ("mjölk 2 l") — people type both
 * — and whatever comes out goes through the same parser the recipe importer
 * uses, so there is exactly one implementation of "2 l" in the codebase.
 */
export function splitQuery(raw: string): { name: string; amountText: string } {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return { name: "", amountText: "" };

  // Leading quantity: "2 l mjölk".
  const lead = parseQuantityPrefix(trimmed);
  if (lead.amount && lead.rest && lead.rest !== trimmed) {
    return {
      name: lead.rest,
      amountText: trimmed.slice(0, trimmed.length - lead.rest.length).trim(),
    };
  }

  // Trailing quantity: "mjölk 2 l". Walk back from the end for the longest
  // suffix that is entirely an amount.
  const words = trimmed.split(" ");
  for (let i = words.length - 1; i >= 1; i--) {
    const tail = words.slice(i).join(" ");
    const parsed = parseQuantityPrefix(tail);
    if (parsed.amount && !parsed.rest) {
      return { name: words.slice(0, i).join(" "), amountText: tail };
    }
  }

  // Quantity in the middle: "banan 3 st mogen". Last, so neither of the two
  // orders above can be reinterpreted — this only ever adds an answer where
  // there was none. Without it the amount silently becomes part of the
  // qualifier and "3 st mogen" prints on the tile under the name.
  for (let start = 1; start < words.length - 1; start++) {
    for (let end = words.length - 1; end > start; end--) {
      const middle = words.slice(start, end).join(" ");
      const parsed = parseQuantityPrefix(middle);
      if (!parsed.amount || parsed.rest) continue;
      return {
        name: [...words.slice(0, start), ...words.slice(end)].join(" "),
        amountText: middle,
      };
    }
  }

  return { name: trimmed, amountText: "" };
}

/**
 * How many leading words may become a qualifier.
 *
 * "färska ekologiska" is a sort. Four words in front of a vara is a sentence,
 * and reading it as a qualifier would put it on the tile under the name. Past
 * the cap the query resolves to nothing, which is the honest answer: it offers
 * to create what was actually typed.
 */
const MAX_MODIFIER_WORDS = 3;

export interface ResolvedQuery {
  matches: CatalogItem[];
  /** Leading words the matched vara did not account for — "mogen". */
  modifier: string;
  /** The trailing or leading amount, verbatim — "2 l". */
  amountText: string;
  /** The query with the amount removed, for the "create a new vara" row. */
  name: string;
}

/**
 * Read a typed query as amount + qualifier + vara.
 *
 * The add bar used to ask one question — "is this whole string a vara?" — so
 * "mogen mango" matched nothing at all and the only thing on offer was creating
 * a 343rd catalog item next to the mango that already existed. Everything the
 * household actually types is shaped like this: a quantity, some adjectives, and
 * a thing. The thing is at the end.
 *
 * So: peel the amount, then take the LONGEST tail that names a vara, and let
 * whatever leads become the qualifier. Longest-first is what keeps "gul lök"
 * whole — it is a vara in its own right, not *lök* qualified with "gul" — and
 * the same test protects "kokt skinka" and "krossade tomater".
 *
 * The qualifier is then looked for behind the vara as well, because "banan
 * mogen" and "mogen banan" are the same instruction and only one of them is
 * grammatical. An app that understood one word order would be teaching a syntax
 * rather than taking an instruction. Front first: Swedish puts the head noun
 * last, so when a query reads both ways the leading words are the qualifier.
 *
 * This mirrors the recipe importer's parse with one deliberate inversion.
 * `parseIngredientLine` *discards* the leftover words, because "färsk" and
 * "riven" describe what you do at the stove. A shopping list keeps them,
 * because they describe what you pick off the shelf. Same reading, opposite
 * disposal of the remainder.
 *
 * Fuzzy matches are excluded from the tail walk on purpose. Typo tolerance is
 * there to help you find something that exists; letting it decide where a name
 * ends would let one mistyped letter invent a qualifier out of the word in
 * front of it.
 */
export function resolveQuery(
  catalog: CatalogItem[],
  raw: string,
  limit = MAX_SUGGESTIONS,
  /*
   * Defaulted, unlike `rankMatches`, and only because of who calls it.
   *
   * `rankMatches` takes `now` as a required argument so that adding recency to
   * its ordering could not change a caller's behaviour without somebody typing
   * the word — which is how two sheets were quietly re-ranked the first time.
   * Its callers are all in this lane. These two are the add bar's entry points,
   * owned by another lane in this pass, so the default is what keeps the
   * signature compatible. It is the one place `now` really is now.
   *
   * Every test passes it explicitly, so the module stays pinnable.
   */
  now: Date = new Date(),
): ResolvedQuery {
  const { name, amountText } = splitQuery(raw);
  const empty: ResolvedQuery = { matches: [], modifier: "", amountText, name };
  if (!name) return empty;

  const words = name.split(" ");
  const cap = Math.min(words.length - 1, MAX_MODIFIER_WORDS);

  // Qualifier in front — "mogen banan". Longest tail first, so a multi-word
  // vara stays whole.
  for (let i = 0; i <= cap; i++) {
    const attempt = trySplit(catalog, words.slice(i), words.slice(0, i), limit, now);
    if (attempt) return { ...attempt, amountText, name };
  }

  // Qualifier behind — "banan mogen". People say it both ways, and an app that
  // understood only one of them would be teaching a word order rather than
  // taking an instruction. Second because Swedish puts the head noun last, so
  // when both readings are available the front one is the qualifier.
  for (let j = 1; j <= cap; j++) {
    const attempt = trySplit(catalog, words.slice(0, -j), words.slice(-j), limit, now);
    if (attempt) return { ...attempt, amountText, name };
  }

  return empty;
}

/**
 * One candidate reading of a query: these words are the vara, those are the
 * qualifier. Null when the reading does not stand up.
 */
function trySplit(
  catalog: CatalogItem[],
  varaWords: string[],
  modifierWords: string[],
  limit: number,
  now: Date,
): { matches: CatalogItem[]; modifier: string } | null {
  if (varaWords.length === 0) return null;

  const vara = varaWords.join(" ");
  const matches = rankMatches(catalog, vara, limit, now);
  if (matches.length === 0) return null;

  const modifier = modifierWords.join(" ");
  if (modifier === "") return { matches, modifier };

  // Only the WHOLE query may resolve on a typo. Once a qualifier is being split
  // off, letting a fuzzy hit decide where the name begins would turn one
  // slipped letter into a qualifier nobody typed.
  if (!literallyMatches(vara, matches[0])) return null;

  // "salt och peppar" is two varor, not peppar of the sort "salt och". A
  // conjunction is never a qualifier, and `resolvePair` handles what this is.
  if (CONJUNCTION_RE.test(modifier)) return null;

  return { matches, modifier };
}

const CONJUNCTION_RE = /\boch\b/i;
const CONJUNCTION_SPLIT_RE = /\s+och\s+/i;

/**
 * Two varor named in one breath — "salt och peppar".
 *
 * People type the pair they are picturing, and until now that resolved to
 * nothing at all. The ingredients engine has met this before and answers it by
 * keeping only the first half, which is right for a recipe line being reviewed
 * by hand and wrong here: the second half is a thing the household said out
 * loud and would simply lose.
 *
 * Deliberately narrow. It fires only for a bare pair, because an amount or a
 * qualifier cannot be divided between two things without guessing which one it
 * belonged to — "2 dl salt och peppar" has an obvious wrong answer and no
 * obvious right one, so it stays a single-vara query and offers a create.
 */
export function resolvePair(
  catalog: CatalogItem[],
  raw: string,
  now: Date = new Date(),
): [CatalogItem, CatalogItem] | null {
  const { name, amountText } = splitQuery(raw);
  if (amountText || !CONJUNCTION_SPLIT_RE.test(name)) return null;

  const parts = name.split(CONJUNCTION_SPLIT_RE);
  if (parts.length !== 2) return null;

  const resolved = parts.map((part) => resolveQuery(catalog, part.trim(), 1, now));
  if (resolved.some((r) => r.matches.length === 0 || r.modifier)) return null;

  const [first, second] = resolved.map((r) => r.matches[0]);
  // "mjölk och mjölk" is one vara said twice, and adding it twice would write
  // two ops to reach the state one op already reaches.
  if (first.id === second.id) return null;

  return [first, second];
}

/** Did this item match without any spelling forgiveness? */
function literallyMatches(query: string, item: CatalogItem): boolean {
  const q = normalizeName(query);
  const n = item.nameNorm;
  return (
    n === q ||
    n.startsWith(q) ||
    isInflectionOf(q, n) ||
    n.split(" ").some((w) => w.startsWith(q)) ||
    n.includes(q)
  );
}
