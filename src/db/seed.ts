import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";
import { db } from "./index";
import {
  catalogItemAliases,
  catalogItems,
  categories,
  listEntries,
  lists,
  users,
} from "./schema";
import {
  CATALOG_ITEMS,
  CATEGORIES,
  ENGLISH_ALIASES,
  STARTER_ITEMS,
} from "./seed-data";
import { entryId } from "@/lib/domain";
import { normalizeName, slugify } from "@/lib/utils";

/**
 * Seed a fresh database with the category walking order, the Swedish catalog,
 * and one starter list.
 *
 * Idempotent by design: every row is upserted on its primary key, and the
 * columns a household can change — `has_at_home`, `use_count`, `last_used_at` —
 * are deliberately NOT overwritten on conflict. Re-running this to pick up new
 * seed items must never reset the catalog's learned ordering or un-flag a
 * staple you told it about.
 *
 * The starter list's CONTENTS are the one thing here that is not an upsert, and
 * the reason is written where they are inserted: what is on a list is the
 * household's, so the seed may write it exactly once, on the run that creates
 * the list, and never again.
 *
 * That idempotence is what lets this run on every server boot in production
 * (src/instrumentation.ts) rather than being a one-off someone has to remember
 * after each deploy. A deploy that adds catalog items ships them; a deploy that
 * adds none changes nothing.
 */

/**
 * The actor the seed writes, and a reserved username because of it.
 *
 * `updated_by` is what tells a seed correction apart from a human edit, so an
 * Authelia user literally called `system` would defeat the guard below.
 */
export const SEED_ACTOR = "system";

/** The list the seed creates, and the only one it ever puts anything on. */
const STARTER_LIST_ID = "hemkop";

/**
 * Upsert one seeded catalog item, leaving anything a human has touched alone.
 *
 * Extracted and exported so the guard can actually be tested — it is the kind of
 * rule that fails silently and only in production, which is the worst possible
 * combination.
 *
 * The problem it solves: this runs on every server boot (src/instrumentation.ts),
 * and it overwrites exactly `name`, `name_norm`, `category_id` and `icon_ref` —
 * which are precisely the columns the item registry makes editable. Without the
 * guard, every deploy and every container restart would silently revert every
 * rename and re-filing the household had done. Latent only because nothing
 * dispatches `update_catalog_item` from the UI yet.
 *
 * `setWhere` is the whole fix: seed corrections reach rows still stamped
 * `SEED_ACTOR` and stop at rows a person has edited. `updated_by` is trustworthy
 * for this because `applyOpToDatabase` replaces the client-supplied actor with
 * the authenticated one, so a human edit cannot wear the seed's name.
 *
 * Two properties this quietly depends on, both worth preserving deliberately:
 * buying something bumps `use_count`/`last_used_at` through a direct UPDATE that
 * never touches `updated_by` (so an item you have bought still receives seed
 * corrections), and deletions will need `deleted_at` rather than row removal or
 * a deleted seeded item comes back on the next boot.
 *
 * Accepted consequence: once a household renames an item, that row never takes
 * another seed correction. Correct precedence — they outrank us.
 */
/**
 * The English words that let an Echo reach the Swedish catalog.
 *
 * Insert-only — `onConflictDoNothing` on `alias_norm`, never an update — and
 * that is the whole safety story rather than laziness. Two household actions
 * write to this table and both must outrank the seed:
 *
 * A merge records the losing word as an alias, so re-pointing one by hand is a
 * real edit that a seed update would silently revert on the next deploy. And
 * removing an alias is a SOFT delete (`deleted_at`), exactly as a catalog
 * item's is, for the same reason — a hard delete would let an offline phone
 * resurrect it. Upserting here would bring back every alias anyone had
 * deliberately retired, on every boot, which is precisely the production bug
 * `catalog_items.deleted_at` exists to prevent.
 *
 * So a seeded alias lands once and is then the household's to keep or drop.
 */
async function seedEnglishAliases(): Promise<void> {
  const rows = Object.entries(ENGLISH_ALIASES).flatMap(([varaName, aliases]) =>
    aliases.map((alias) => ({
      // Folded exactly as `catalog_items.name_norm` is: an alias normalized any
      // other way is an alias that never matches.
      aliasNorm: normalizeName(alias),
      catalogItemId: slugify(varaName),
      createdBy: SEED_ACTOR,
      updatedBy: SEED_ACTOR,
    })),
  );

  console.log(`Seeding ${rows.length} English aliases…`);
  for (const row of rows) {
    await db.insert(catalogItemAliases).values(row).onConflictDoNothing();
  }
}

export async function upsertSeedCatalogItem(item: {
  name: string;
  categorySlug: string;
  iconRef: string;
  hasAtHome?: boolean;
}): Promise<void> {
  const id = slugify(item.name);
  await db
    .insert(catalogItems)
    .values({
      id,
      name: item.name,
      nameNorm: normalizeName(item.name),
      categoryId: item.categorySlug,
      iconRef: item.iconRef,
      isCustom: false,
      hasAtHome: item.hasAtHome ?? false,
      useCount: 0,
      lastUsedAt: null,
      updatedBy: SEED_ACTOR,
      // The per-field clocks are stamped with the seed actor too, so a later
      // `update_catalog_item` from a phone always wins on timestamp — a seeded
      // row has never been edited by anyone, and the clocks should say so
      // rather than defaulting to whenever the container happened to boot.
      nameUpdatedBy: SEED_ACTOR,
      categoryUpdatedBy: SEED_ACTOR,
      iconUpdatedBy: SEED_ACTOR,
      homeUpdatedBy: SEED_ACTOR,
      hiddenUpdatedBy: SEED_ACTOR,
    })
    .onConflictDoUpdate({
      target: catalogItems.id,
      // Name, category and icon are ours to correct in a later seed. Usage
      // counts, the has_at_home flag and whether the household has put this one
      // out of the way are theirs — and `hidden` in particular must survive a
      // deploy, or every seeded vara anyone has tidied away reappears in search
      // the next time the container boots.
      set: {
        name: item.name,
        nameNorm: normalizeName(item.name),
        categoryId: item.categorySlug,
        iconRef: item.iconRef,
      },
      setWhere: eq(catalogItems.updatedBy, SEED_ACTOR),
    });
}

export async function seed() {
  console.log("Seeding categories…");
  for (const c of CATEGORIES) {
    await db
      .insert(categories)
      .values({ id: c.slug, name: c.name, icon: c.icon, position: c.position })
      .onConflictDoUpdate({
        target: categories.id,
        set: { name: c.name, icon: c.icon, position: c.position },
      });
  }

  console.log(`Seeding ${CATALOG_ITEMS.length} catalog items…`);
  for (const item of CATALOG_ITEMS) {
    await upsertSeedCatalogItem(item);
  }

  await seedEnglishAliases();

  // A first list, so a fresh install opens on something usable rather than an
  // empty-state screen asking you to name things before you can shop.
  const createdList = await db
    .insert(lists)
    .values({
      id: STARTER_LIST_ID,
      name: "Hemköp",
      icon: "1F6D2", // 🛒
      position: 0,
      categoryOrder: CATEGORIES.map((c) => c.slug),
      updatedBy: SEED_ACTOR,
    })
    .onConflictDoNothing()
    .returning({ id: lists.id });

  /**
   * Entries land only when THIS run is what created the list.
   *
   * The obvious guard — "seed entries when the list has none" — is wrong, and
   * wrong in a way that only surfaces a month later. Ticking an item off is a
   * soft delete (`list_entries.removed_at`), but `pruneRetention` hard-deletes
   * tombstones once they are past the retention window, so a household that
   * cleared the starter items in week one has genuinely zero rows by week five.
   * That guard would put the whole starter list back on their list at the next
   * deploy — a seed that runs on every boot (src/instrumentation.ts) must never
   * resurrect something a person deliberately removed.
   *
   * Whether the insert above created the row is a fact that cannot drift: it is
   * true exactly once in a database's life, and it needs no extra query. It also
   * settles two containers booting at once for free, since only one of them can
   * win the insert.
   *
   * Known gap, stated rather than papered over: if the household DELETES the
   * starter list and the prune later removes its tombstone, the list itself
   * already came back on the next boot before this change, and now it comes back
   * with varor on it. The resurrected list is the pre-existing bug; the items are
   * only riding along, and fixing it needs a tombstone the prune keeps.
   */
  if (createdList.length > 0) {
    await db
      .insert(listEntries)
      .values(
        STARTER_ITEMS.map((name) => {
          const catalogItemId = slugify(name);
          return {
            id: entryId(STARTER_LIST_ID, catalogItemId),
            listId: STARTER_LIST_ID,
            catalogItemId,
            createdBy: SEED_ACTOR,
            updatedBy: SEED_ACTOR,
          };
        }),
      )
      // Somebody adding mjölk in the milliseconds between the two inserts would
      // otherwise fail the whole seed on the unique (list, item) constraint.
      // Adding, never overwriting, is the only thing this is allowed to do.
      .onConflictDoNothing();
  }

  // Said after the fact rather than before it. The previous "Seeding starter
  // list…" announced work that consisted of one empty list row, so a fresh
  // database reported success and then opened on "Listan är tom".
  console.log(
    createdList.length > 0
      ? `Seeded starter list with ${STARTER_ITEMS.length} varor.`
      : "Starter list already exists — left untouched.",
  );

  // The dev user, so a local run without Authelia in front has an identity to
  // attribute changes to.
  const devUser = process.env.DEV_AUTH_USER;
  if (devUser) {
    await db
      .insert(users)
      .values({ autheliaUser: devUser, displayName: devUser, color: "#1f6f4f" })
      .onConflictDoNothing();
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(catalogItems);
  console.log(`Done. Catalog holds ${count} items.`);
}

// CLI entry point (`pnpm db:seed`). Guarded, because the server imports this
// module at boot: an unguarded `process.exit(0)` at the bottom of the file
// would take the whole app down the moment the catalog finished seeding.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
