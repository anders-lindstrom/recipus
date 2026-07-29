import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
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

const SEED_ACTOR = "system";

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
      });
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
