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

/**
 * A person's name, from the username Authelia authenticated them as.
 *
 * `anders` → `Anders`. Derived rather than stored, and the `users` table is
 * deliberately not consulted: the roster already comes from `autheliaUser`,
 * which is on every op and every purchase row, so maintaining a second source
 * of truth would buy a join and a way for the two to disagree.
 *
 * The stated cost, because it will eventually be somebody's problem: this
 * assumes an Authelia username IS a first name. `svc-backup` becomes
 * `Svc-backup`, which is wrong and harmless. The day that matters is the day
 * `users.display_name` earns its keep, and this is the one function that would
 * have to change.
 *
 * Only ever for display. Nothing keys off the result.
 */
export function displayName(autheliaUser: string): string {
  const trimmed = autheliaUser.trim();
  if (!trimmed) return trimmed;
  // `slice(1)` untouched rather than lowercased, so "JB" stays "JB" instead of
  // being corrected into "Jb".
  return trimmed[0].toUpperCase() + trimmed.slice(1);
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
/**
 * The inverse, for the icon picker: "🍞" → "1F35E".
 *
 * Icons are stored as codepoint refs because that is how the OpenMoji sprite
 * names its files, but nobody types a codepoint — so the picker takes whatever
 * the emoji keyboard produced and converts it here, and the storage format never
 * reaches the person choosing.
 *
 * Every codepoint is kept, joined with hyphens, because a ZWJ sequence like 👨‍🍳
 * is four of them; taking only the first would quietly store a different emoji
 * than the one that was picked.
 *
 * Returns null for anything that is not an emoji. The input is a free-text field
 * — "bröd" and "" both arrive here — and storing either would render as a missing
 * sprite rather than as a refusal, which is a worse way to find out.
 */
export function emojiToCodepoint(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const points = [...trimmed];
  // A single ASCII letter or a word is not an icon. Emoji live well above the
  // Latin range, and the variation selector / ZWJ that glue sequences together
  // are the only sub-range members worth accepting.
  const isEmojiLike = points.every((c) => {
    const cp = c.codePointAt(0)!;
    return cp > 0x2000;
  });
  if (!isEmojiLike) return null;

  return points
    .map((c) => c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0"))
    .join("-");
}

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
