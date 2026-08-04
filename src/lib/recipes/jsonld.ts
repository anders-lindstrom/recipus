/**
 * JSON-LD recipe extraction: parses schema.org/Recipe markup out of
 * already-fetched HTML. Pure — no network, no DOM API, just regex and
 * `JSON.parse`. This is the common path: most Swedish recipe sites publish
 * this markup, so most imports never need the LLM fallback in `llm.ts`. See
 * docs/superpowers/specs/2026-07-29-recipus-design.md §5.6.
 */

export interface ImportedRecipe {
  title: string;
  servings: number;
  servingsUnit: string; // "portioner", "muffins", "bitar"
  imageUrl: string | null;
  ingredientLines: string[]; // RAW lines, e.g. "2 dl vispgrädde" — not parsed here
  /**
   * The method, one step per entry, in order. Empty when the page published
   * none — which is a real answer rather than a failure: plenty of pages carry
   * schema.org ingredients and leave the steps in unmarked prose.
   */
  instructions: string[];
  sourceUrl: string;
  method: "jsonld" | "llm";
}

const DEFAULT_SERVINGS = 4;
const DEFAULT_SERVINGS_UNIT = "portioner";

// ---------------------------------------------------------------------------
// HTML entity decoding
//
// Recipe values sometimes carry literal HTML entities inside an otherwise
// valid JSON string, e.g. `"name": "Kött &amp; potatis"`. Decoding is applied
// to the extracted string fields, after JSON.parse — never before it, since
// e.g. `&quot;` decoded to `"` ahead of parsing would unescape a quote in the
// middle of a JSON string and break otherwise-valid JSON.
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  // Named forms of å/ä/ö turn up often enough on Swedish sites to be worth a
  // direct entry, rather than relying only on the numeric form.
  aring: "å",
  Aring: "Å",
  auml: "ä",
  Auml: "Ä",
  ouml: "ö",
  Ouml: "Ö",
  nbsp: " ",
};

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g;

export function decodeHtmlEntities(s: string): string {
  return s.replace(ENTITY_RE, (match, entity: string) => {
    if (entity[0] === "#") {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const code = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

// ---------------------------------------------------------------------------
// Scanning <script type="application/ld+json"> blocks
// ---------------------------------------------------------------------------

const SCRIPT_RE = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Yields every object reachable from a parsed JSON-LD payload that could be a
 * node: array elements (recursively) and `@graph` members, plus the object
 * itself. Sites nest the Recipe differently, so the scan doesn't assume a
 * shape — it just looks everywhere plausible.
 */
function* iterCandidates(node: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const item of node) yield* iterCandidates(item);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    yield obj;
    if (Array.isArray(obj["@graph"])) {
      yield* iterCandidates(obj["@graph"]);
    }
  }
}

function isRecipeNode(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  if (typeof type === "string") return type === "Recipe";
  if (Array.isArray(type)) return type.includes("Recipe");
  return false;
}

/** Parse already-fetched HTML for a schema.org/Recipe. Pure — the testable core. */
export function extractJsonLdRecipe(html: string, url: string): ImportedRecipe | null {
  const blocks = html.matchAll(SCRIPT_RE);
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1] ?? "");
    } catch {
      continue; // malformed block — skip it, try the next
    }
    for (const candidate of iterCandidates(parsed)) {
      if (isRecipeNode(candidate)) {
        const recipe = buildImportedRecipe(candidate, url);
        if (recipe) return recipe;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

function firstString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = firstString(item);
      if (s) return s;
    }
  }
  return null;
}

function extractIngredientLines(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const lines: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const collapsed = decodeHtmlEntities(item).replace(/\s+/g, " ").trim();
    if (collapsed) lines.push(collapsed);
  }
  return lines;
}

/**
 * The steps, out of the four shapes `recipeInstructions` is published in.
 *
 * schema.org allows a plain string, a list of strings, a list of `HowToStep`
 * objects, or a `HowToSection` whose `itemListElement` holds the steps — and
 * Swedish recipe sites use all four. Anything that yields no text is skipped
 * rather than kept as an empty step: a numbered blank is worse than a shorter
 * method.
 *
 * A single string is split on newlines, because the sites that publish one
 * publish the whole method as one field with the steps separated that way. It
 * is NOT split on full stops: "Häll i 2 dl grädde. Rör om." is one step by the
 * author's reckoning, and a sentence splitter would also cut "ca 1,5 dl" and
 * every abbreviation in the language.
 *
 * Section names are dropped rather than promoted to a step. "Sås" as a step
 * reads as an instruction to do something to the sauce; the steps under it
 * already say what to do.
 */
function extractInstructions(value: unknown): string[] {
  const steps: string[] = [];

  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      for (const line of decodeHtmlEntities(node).split(/\r?\n/)) {
        const collapsed = line.replace(/\s+/g, " ").trim();
        if (collapsed) steps.push(collapsed);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;

    const obj = node as Record<string, unknown>;
    // A section holds its steps in `itemListElement`; a step holds its words in
    // `text`. Checked in that order because a section can carry a `name` too,
    // and taking it would replace the steps with the heading above them.
    if (obj.itemListElement !== undefined) {
      walk(obj.itemListElement);
      return;
    }
    walk(obj.text ?? obj.name ?? null);
  };

  walk(value);
  return steps;
}

function firstImageString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = firstImageString(item);
      if (s) return s;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const url = (value as Record<string, unknown>).url;
    if (typeof url === "string") return url;
  }
  return null;
}

function extractImageUrl(value: unknown, pageUrl: string): string | null {
  const raw = firstImageString(value);
  if (!raw) return null;
  try {
    return new URL(raw, pageUrl).toString();
  } catch {
    return null;
  }
}

const HEDGE_RE = /^(ca|cirka|ungefär)\.?\s*/i;
// Leading integer, optional "-N" / "–N" range (the lower bound is kept — the
// safer scale for a recipe that serves 4-6), then the rest as the unit word.
const SERVINGS_RE = /^(\d+)(?:\s*[-–]\s*\d+)?\s*(.*)$/;

function parseServingsText(text: string): { servings: number; servingsUnit: string } | null {
  const withoutHedge = text.replace(HEDGE_RE, "");
  const match = SERVINGS_RE.exec(withoutHedge.trim());
  if (!match) return null;
  const servings = parseInt(match[1]!, 10);
  if (!Number.isFinite(servings) || servings <= 0) return null;
  const servingsUnit = match[2]!.trim().toLowerCase();
  return { servings, servingsUnit: servingsUnit || DEFAULT_SERVINGS_UNIT };
}

function firstYieldValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const v = firstYieldValue(item);
      if (v !== null && v !== undefined && v !== "") return v;
    }
    return null;
  }
  return value ?? null;
}

function extractServings(value: unknown): { servings: number; servingsUnit: string } {
  const raw = firstYieldValue(value);
  if (raw === null) return { servings: DEFAULT_SERVINGS, servingsUnit: DEFAULT_SERVINGS_UNIT };

  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0
      ? { servings: raw, servingsUnit: DEFAULT_SERVINGS_UNIT }
      : { servings: DEFAULT_SERVINGS, servingsUnit: DEFAULT_SERVINGS_UNIT };
  }

  const text = decodeHtmlEntities(String(raw));
  return parseServingsText(text) ?? { servings: DEFAULT_SERVINGS, servingsUnit: DEFAULT_SERVINGS_UNIT };
}

function buildImportedRecipe(node: Record<string, unknown>, pageUrl: string): ImportedRecipe | null {
  const rawTitle = firstString(node.name);
  if (!rawTitle) return null;
  const title = decodeHtmlEntities(rawTitle).trim();
  if (!title) return null;

  const { servings, servingsUnit } = extractServings(node.recipeYield);

  return {
    title,
    servings,
    servingsUnit,
    imageUrl: extractImageUrl(node.image, pageUrl),
    ingredientLines: extractIngredientLines(node.recipeIngredient),
    instructions: extractInstructions(node.recipeInstructions),
    sourceUrl: pageUrl,
    method: "jsonld",
  };
}
