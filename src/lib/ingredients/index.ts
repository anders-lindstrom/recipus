/**
 * Ingredients engine: turns a raw recipe line into a quantity and a cleaned
 * name, then fuzzy-matches that name against the household catalog.
 *
 * Pure module — no DOM, no network, no database. See
 * docs/superpowers/specs/2026-07-29-recipus-design.md §5.2 for the design
 * rationale (why matching tolerates preparation words and Swedish compounds,
 * and why an unmatched ingredient never blocks an import).
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

export function matchIngredient(name: string, catalog: MatchCandidate[]): IngredientMatch | null {
  const query = normalizeName(name);
  if (!query) return null;

  const headSuffix = compoundHeadSuffix(query, catalog);

  let best: { id: Id; score: number; nameLength: number } | null = null;
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

    if (!best || score > best.score || (score === best.score && c.length < best.nameLength)) {
      best = { id: candidate.id, score, nameLength: c.length };
    }
  }

  if (!best || best.score < MIN_SCORE) return null;
  return { id: best.id, score: best.score };
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
