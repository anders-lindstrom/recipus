import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Combining diacritical marks, written as escapes rather than literal
// combining characters — those are invisible in most editors and get mangled
// by anything that re-encodes the file.
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Lowercase and fold Swedish diacritics for search and matching.
 *
 * å/ä/ö fold to a/a/o deliberately. Nobody reaches for the right key while
 * walking through a shop, and "rakor" must find "räkor".
 */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Deterministic slug from a name, used for seeded catalog ids. */
export function slugify(s: string): string {
  return normalizeName(s)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Render an emoji codepoint reference ("1F95B", "1F468-200D-1F373") as the
 * character. Used as the fallback when the OpenMoji sprite has not been built,
 * so the app is never iconless.
 */
export function codepointToEmoji(ref: string): string {
  try {
    return ref
      .split("-")
      .map((h) => String.fromCodePoint(parseInt(h, 16)))
      .join("");
  } catch {
    return "\u{1F4E6}"; // 📦
  }
}
