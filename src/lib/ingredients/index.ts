/**
 * Ingredients engine: turns a raw recipe line into a quantity and a cleaned
 * name, then fuzzy-matches that name against the household catalog.
 *
 * The same scorer places a scanned product's name in the catalog
 * (`autoMapProductName`), at a deliberately stricter threshold — it lives here
 * rather than beside the registry because that threshold is only meaningful in
 * terms of the score tiers defined below.
 *
 * Pure module — no DOM, no network, no database. See
 * docs/superpowers/specs/2026-07-29-recipus-design.md §5.2 for the design
 * rationale (why matching tolerates preparation words and Swedish compounds,
 * and why an unmatched ingredient never blocks an import), and
 * docs/superpowers/specs/2026-07-30-items-history-registry.md §2.10–2.11 for
 * aliases and the auto-map threshold.
 */

import type { Amount, Id } from "@/lib/domain";
import { parseQuantityPrefix } from "@/lib/units";
import { normalizeName } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedIngredient {
  /** The original line, verbatim. Never lose this. */
  rawText: string;
  amount: Amount | null;
  /** The cleaned ingredient name: "vispgrädde" from "2 dl vispgrädde". */
  name: string;
  /**
   * The name before preparation-word stripping (after trailing-noise removal
   * and multi-ingredient splitting) — "torkad dill" rather than "dill".
   * Equal to `name` when no preparation word was found. Some catalog items
   * genuinely ARE preparation-word + noun ("torkad dill", "kokt skinka");
   * `matchParsedIngredient` tries this form first so those aren't shadowed
   * by the generic strip.
   */
  nameWithPreparation: string;
}

// Adjectives that describe what you do to an ingredient, not what you buy.
// Stripped wherever they appear as a whole word — leading ("finhackad
// persilja") or trailing after a comma ("lök, skalad och finhackad").
const PREP_WORDS = [
  "finhackad",
  "hackad",
  "riven",
  "skivad",
  "tärnad",
  "strimlad",
  "pressad",
  "krossad",
  "malen",
  "smält",
  "kokt",
  "rostad",
  "färsk",
  "torkad",
  "fryst",
  "ekologisk",
  "valfri",
  "grovhackad",
  "finriven",
  "urkärnad",
  "skalad",
  "delad",
];

const PREP_WORDS_RE = new RegExp(`\\b(?:${PREP_WORDS.join("|")})\\b`, "gi");

// Trailing qualifiers describe how/when to use an ingredient, not what it is.
// Matched with a leading word boundary so e.g. "ca" never matches inside an
// unrelated word ("arnica"); internal spaces tolerate double-spacing in the
// source text.
const TRAILING_QUALIFIERS = [
  "att servera till",
  "till garnering",
  "efter smak",
  "eller mer",
  "vid behov",
  "gärna",
  "helst",
  "ca",
];

const TRAILING_QUALIFIER_PATTERN = TRAILING_QUALIFIERS.map((q) => q.replace(/ /g, "\\s+")).join(
  "|",
);
const TRAILING_QUALIFIER_RE = new RegExp(`[,;]?\\s*\\b(?:${TRAILING_QUALIFIER_PATTERN})\\s*$`, "i");

const TRAILING_PAREN_RE = /\s*\([^)]*\)\s*$/;

const OCH_SPLIT_RE = /\s+och\s+/i;

/**
 * Strip a trailing parenthetical ("(ca 200 g)") and trailing qualifiers
 * ("efter smak", "ca", ...), repeatedly — a line can end in more than one,
 * e.g. "smör (ca 200 g), efter smak". Never strips down to nothing: a line
 * that is *only* noise is returned unchanged, since an empty name is worse
 * than an unstripped one.
 */
function stripTrailingNoise(input: string): string {
  let result = input.trim();
  let changed = true;
  while (changed) {
    changed = false;
    const withoutParen = result.replace(TRAILING_PAREN_RE, "").trim();
    if (withoutParen !== result && withoutParen.length > 0) {
      result = withoutParen;
      changed = true;
      continue;
    }
    const withoutQualifier = result.replace(TRAILING_QUALIFIER_RE, "").trim();
    if (withoutQualifier !== result && withoutQualifier.length > 0) {
      result = withoutQualifier;
      changed = true;
    }
  }
  return result;
}

/**
 * "salt och peppar" -> "salt". Multi-ingredient lines are not split; the
 * first ingredient becomes `name` while `rawText` keeps everything, so a
 * wrong split never happens — the import sheet is reviewed by hand anyway.
 */
function takeFirstIngredient(input: string): string {
  const match = OCH_SPLIT_RE.exec(input);
  if (!match) return input;
  const first = input.slice(0, match.index).trim();
  return first.length > 0 ? first : input;
}

/**
 * Remove preparation words wherever they appear as a whole word, then clean
 * up the comma/whitespace debris left behind ("lök, skalad" -> "lök").
 * Falls back to the input unchanged if stripping would empty it out.
 */
function stripPreparationWords(input: string): string {
  const stripped = input
    .replace(PREP_WORDS_RE, "")
    .replace(/,\s*,/g, ",")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : input;
}

export function parseIngredientLine(line: string): ParsedIngredient {
  const { amount, rest } = parseQuantityPrefix(line);

  const nameWithPreparation = takeFirstIngredient(stripTrailingNoise(rest));
  const name = stripPreparationWords(nameWithPreparation);

  return { rawText: line, amount, name, nameWithPreparation };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface MatchCandidate {
  id: Id;
  nameNorm: string;
}

export interface IngredientMatch {
  id: Id;
  /** 0..1. Callers treat <0.5 as "no confident match". */
  score: number;
}

/** One row of `catalog_item_aliases`: an extra word that reaches an item. */
export interface CatalogItemAlias {
  itemId: Id;
  /** Already normalized, exactly as the column stores it. */
  aliasNorm: string;
}

/**
 * Expand items and their aliases into the flat candidate list the matcher
 * takes: one candidate per name, plus one per alias, all pointing at the item
 * they belong to.
 *
 * This is the entire mechanism behind "a merged-away word keeps resolving".
 * `merge_catalog_items(B → A)` tombstones B and keeps B's word as an alias of
 * A; without that alias a recipe line saying "köttfärs" goes from a 1.0 match
 * to nothing, because it shares no prefix, compound head or whole word with
 * any surviving catalog name. The matcher itself needs no knowledge of any of
 * this — it scores a list, and a list is what it gets.
 *
 * Both inputs carry pre-normalized names, matching the contract the matcher
 * already has with its callers: `name_norm` and `alias_norm` are columns, read
 * straight off the row rather than recomputed here.
 */
export function buildMatchCandidates(
  items: readonly MatchCandidate[],
  aliases: readonly CatalogItemAlias[] = [],
): MatchCandidate[] {
  return [
    ...items,
    ...aliases.map((alias) => ({ id: alias.itemId, nameNorm: alias.aliasNorm })),
  ];
}

const SCORE_EXACT = 1.0;
const SCORE_PREFIX = 0.8;
const SCORE_COMPOUND_HEAD = 0.7;
const SCORE_CONTAINS = 0.6;
const MIN_SCORE = 0.5;

// Swedish compounds put the head noun last ("vispgrädde" -> "grädde"). A
// query that misses on its full form is retried against progressively
// shorter suffixes of its last word, taking the longest suffix that exactly
// equals some catalog name. Suffixes shorter than this are never tried —
// short fragments ("öl", "te") risk matching an unrelated catalog item.
const MIN_COMPOUND_SUFFIX_LENGTH = 3;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWholeWord(haystack: string, word: string): boolean {
  if (!word) return false;
  return new RegExp(`\\b${escapeRegExp(word)}\\b`).test(haystack);
}

function lastWord(s: string): string {
  const parts = s.split(" ");
  return parts[parts.length - 1] ?? s;
}

/**
 * The longest suffix of the query's last word that exactly equals some
 * catalog name, or null if none does. This only ever competes with the
 * exact/prefix scores in the caller's max-over-candidates selection, so it
 * can never win over a real exact entry ("potatismjöl", "jordnötssmör").
 */
function compoundHeadSuffix(query: string, catalog: MatchCandidate[]): string | null {
  const token = lastWord(query);
  for (let drop = 1; token.length - drop >= MIN_COMPOUND_SUFFIX_LENGTH; drop++) {
    const suffix = token.slice(drop);
    if (catalog.some((c) => c.nameNorm === suffix)) return suffix;
  }
  return null;
}

interface ScoredCandidate {
  id: Id;
  score: number;
  nameLength: number;
}

/**
 * Is `a` a better match than `b`? Higher score first, then the shorter (more
 * generic, safer) catalog name, then the lowest id.
 *
 * The id comparison is the load-bearing part, and it is not decoration: the
 * candidate list arrives from a `select` with no `ORDER BY`, so its order is
 * Postgres' business. Without a final discriminator, "havre" resolves to
 * *havregryn* or *havremjöl* depending on row order alone — two devices
 * holding byte-identical catalogs can disagree, and one device can disagree
 * with itself after a VACUUM. Which of the two wins does not matter; that
 * both sides pick the same one, unable to consult each other, is the whole
 * point. Same reasoning as the actor-name tie-break in src/lib/sync/reducer.ts.
 *
 * Equal ids can occur — an item contributes one candidate per name *and* per
 * alias — and then either answer is the same answer, so falling through is
 * correct.
 */
function isBetterMatch(a: ScoredCandidate, b: ScoredCandidate): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if (a.nameLength !== b.nameLength) return a.nameLength < b.nameLength;
  return a.id < b.id;
}

export function matchIngredient(name: string, catalog: MatchCandidate[]): IngredientMatch | null {
  const query = normalizeName(name);
  if (!query) return null;

  const headSuffix = compoundHeadSuffix(query, catalog);

  let best: ScoredCandidate | null = null;
  for (const candidate of catalog) {
    const c = candidate.nameNorm;
    if (!c) continue;

    let score: number;
    if (c === query) {
      score = SCORE_EXACT;
    } else if (query.startsWith(c) || c.startsWith(query)) {
      score = SCORE_PREFIX;
    } else if (headSuffix !== null && c === headSuffix) {
      score = SCORE_COMPOUND_HEAD;
    } else if (containsWholeWord(query, c)) {
      score = SCORE_CONTAINS;
    } else {
      continue;
    }

    const scored: ScoredCandidate = { id: candidate.id, score, nameLength: c.length };
    if (!best || isBetterMatch(scored, best)) {
      best = scored;
    }
  }

  if (!best || best.score < MIN_SCORE) return null;
  return { id: best.id, score: best.score };
}

/**
 * The score a scanned product's NAME must reach before it is mapped to a vara
 * with nobody looking. 0.8 — the prefix tier — never 0.7.
 *
 * One tier lower is where Swedish compounding turns coffee into cheese: every
 * "-rost" ends in "ost", so the compound-head tier maps both "Kaffe Gevalia
 * Mellanrost" and "Zoégas Skånerost" to *ost*, and "Kelda Tomatsoppa" to
 * *soppa*. Verified by execution against the real seeded catalog, not
 * reasoned about — see the threshold tests.
 *
 * This threshold is strict because of what an auto-map *does* in buy mode: it
 * records a purchase. A wrong one is silent, lands on a vara nobody bought,
 * and then feeds cadence and statistics as though it were true. A product sent
 * to the review queue instead costs one tap, later, with the shopping already
 * done.
 *
 * The consequence is deliberate and should not be read as a defect: of twelve
 * realistic Swedish product names, two auto-commit and ten queue. That ratio
 * is the design.
 */
export const AUTO_MAP_MIN_SCORE = SCORE_PREFIX;

/**
 * Map a scanned product's name to a vara, or null when a human has to place
 * it. Null is the ordinary outcome, not an error — see AUTO_MAP_MIN_SCORE.
 *
 * Callers wanting a "menade du …?" suggestion for the review queue should call
 * `matchIngredient` directly; a suggestion a person confirms carries none of
 * the risk this threshold guards against.
 */
export function autoMapProductName(
  productName: string,
  catalog: MatchCandidate[],
): IngredientMatch | null {
  const match = matchIngredient(productName, catalog);
  return match !== null && match.score >= AUTO_MAP_MIN_SCORE ? match : null;
}

/**
 * Match a parsed ingredient, trying the name that still includes
 * preparation words ("torkad dill", "kokt skinka") alongside the
 * fully-stripped name ("dill", "skinka"), and preferring the more specific,
 * as-written form unless the stripped form scores strictly higher.
 *
 * This resolves the tension between "strip preparation words" and catalog
 * items that genuinely are preparation-word + noun. Three cases in order of
 * how they're decided:
 *  - "1 tsk torkad dill": `name` alone ("dill") has no match at all, so the
 *    preparation-word form wins by default.
 *  - "100 g kokt skinka": both forms match exactly, but to *different* real
 *    items ("kokt skinka" vs. plain "skinka") — an equal score is a tie, and
 *    the more specific, as-written form is the correct default, not the
 *    generic one.
 *  - "1 msk finhackad persilja": the preparation-word form only scores 0.6
 *    (it merely *contains* "persilja" as a whole word), while the stripped
 *    form matches "persilja" exactly at 1.0 — here the stripped form is
 *    strictly better and wins. A plain
 *    `matchIngredient(unstripped) ?? matchIngredient(stripped)` would get
 *    the first two cases right but stop at the non-null 0.6 result here,
 *    silently downgrading the far more common case where preparation words
 *    really are just noise.
 */
export function matchParsedIngredient(
  parsed: ParsedIngredient,
  catalog: MatchCandidate[],
): IngredientMatch | null {
  const stripped = matchIngredient(parsed.name, catalog);
  const withPreparation = matchIngredient(parsed.nameWithPreparation, catalog);

  if (!withPreparation) return stripped;
  if (!stripped) return withPreparation;
  return stripped.score > withPreparation.score ? stripped : withPreparation;
}
