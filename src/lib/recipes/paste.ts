/**
 * Pasted text → ingredient lines. The third of the four input paths in
 * docs/superpowers/specs/2026-07-29-recipus-design.md §5.6, and the way out of
 * a dead end.
 *
 * A page with no JSON-LD and no `ANTHROPIC_API_KEY` gives "Kunde inte läsa
 * receptet från sidan." and a "Försök igen" that will fail in exactly the same
 * way — while the recipe sits fully readable in the tab the person just came
 * from. The machinery to make something of it already exists: `parseIngredientLine`
 * turns "2 dl grädde" into an amount plus a name, and the matcher finds the
 * household's vara for it. All that was missing was somewhere to put the text.
 *
 * Deliberately NOT a document parser. It makes no attempt to find where the
 * ingredients begin and end inside a whole pasted article, because it does not
 * have to — the person selected the ingredient list before copying it — and
 * because guessing wrong means silently dropping an ingredient, which is the
 * one failure a shopping list must not have. Everything below is line-level
 * tidying of what a copy off a web page reliably drags along with it.
 *
 * Pure module: no DOM, no network, no database.
 */

/**
 * Bare headings, with or without a trailing colon.
 *
 * The colon rule below catches "Sås:" and "Till servering:" without needing to
 * know the words; this list is for the ones written without one, which in
 * practice is almost always the heading above the list itself.
 */
const HEADINGS = [
  "ingredienser",
  "ingrediens",
  "gör så här",
  "så här gör du",
  "så gör du",
  "tillagning",
  "instruktioner",
];

/** List markers, which survive a copy far more often than they are wanted. */
const BULLET_RE = /^[-–—•·*]+\s*/;

const TRAILING_PUNCT_RE = /[:.]+$/;

/**
 * A line that is a serving count and nothing else — "4 portioner", "ca 6-8
 * bitar". It sits at the top of most ingredient lists, and left alone it would
 * become an ingredient called "portioner" with a quantity of 4 on the shopping
 * list. Dropped rather than lifted into the recipe's own serving count: the
 * form asks for that outright, and a field that silently disagreed with what
 * the person typed is worse than one they have to fill in.
 */
const SERVINGS_ONLY_RE =
  /^(?:ca|cirka|ungefär)?\.?\s*\d+(?:\s*[-–]\s*\d+)?\s*(?:portioner|portion|port|personer|person|bitar|bit|muffins|kakor)\.?$/i;

/**
 * An upper bound, so a paste of an entire article cannot turn into a recipe
 * with two thousand ingredients. Far above any real recipe — the point is to
 * have a ceiling at all, not to enforce a taste in recipes.
 */
const MAX_LINES = 200;

export function cleanPastedIngredients(text: string): string[] {
  const lines: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    // The whitespace collapse is not cosmetic. Copying "2 dl mjölk" off a web
    // page very often yields a non-breaking space between the number and the
    // unit, and `parseQuantityPrefix` looks for an ordinary one — so the amount
    // is quietly lost and the whole line ends up as the ingredient's name.
    // `\s` covers U+00A0, and the same pass takes care of tabs and double
    // spaces.
    const line = raw
      .replace(/\s+/g, " ")
      .trim()
      .replace(BULLET_RE, "")
      .trim();
    if (!line) continue;

    // A line ending in a colon is introducing something rather than being it:
    // "Sås:", "Till servering:", "Deg:". Stated as a shape rather than a word
    // list, because every household writes its own group headings.
    if (line.endsWith(":")) continue;

    if (HEADINGS.includes(line.toLowerCase().replace(TRAILING_PUNCT_RE, ""))) {
      continue;
    }

    if (SERVINGS_ONLY_RE.test(line)) continue;

    lines.push(line);
    if (lines.length >= MAX_LINES) break;
  }

  return lines;
}
