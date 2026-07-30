import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";
import { db } from "./index";
import { catalogItems, categories, lists, users } from "./schema";
import { CATALOG_ITEMS, CATEGORIES } from "./seed-data";
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
    })
    .onConflictDoUpdate({
      target: catalogItems.id,
      // Name, category and icon are ours to correct in a later seed. Usage
      // counts and the has_at_home flag belong to the household.
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

  // A first list, so a fresh install opens on something usable rather than an
  // empty-state screen asking you to name things before you can shop.
  console.log("Seeding starter list…");
  await db
    .insert(lists)
    .values({
      id: "hemkop",
      name: "Hemköp",
      icon: "1F6D2", // 🛒
      position: 0,
      categoryOrder: CATEGORIES.map((c) => c.slug),
      updatedBy: SEED_ACTOR,
    })
    .onConflictDoNothing();

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
