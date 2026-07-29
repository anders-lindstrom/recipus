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
    sourceUrl: pageUrl,
    method: "jsonld",
  };
}
