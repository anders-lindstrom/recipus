/**
 * What the starter list opens with on a brand-new database.
 *
 * A list row on its own is not a starter list — it is an empty-state screen with
 * a name, and "Listan är tom" is exactly what a fresh install used to greet
 * people with despite the seed logging that it had made one. Something has to be
 * on it, or the first thing the app teaches you is that it has nothing to show.
 *
 * Six varor across five aisles rather than six from one shelf, because the
 * walking order is the whole point of the list and it is invisible in a single
 * undifferentiated column. This is the only screen where the aisle grouping gets
 * to explain itself before anyone has typed anything.
 *
 * Names, not ids, so `seed-data.test.ts` can hold them against CATALOG_ITEMS by
 * plain string comparison — the ids are `slugify(name)` and a starter item that
 * named a vara which does not exist would fail on a foreign key, on a fresh
 * database only, which is the one place nobody looks twice.
 */
export const STARTER_ITEMS: string[] = [
  "banan",
  "formbröd",
  "mjölk",
  "ägg",
  "pasta",
  "toapapper",
];
