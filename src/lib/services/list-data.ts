import { and, asc, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  catalogItems,
  categories,
  contributions,
  listEntries,
  lists,
  purchases,
  recipeAdditions,
  recipes,
} from "@/db/schema";
import type {
  CatalogItem,
  Category,
  Contribution,
  Id,
  List,
  ListEntry,
  Unit,
} from "@/lib/domain";
import { rankSuggestions, catalogOrderScore } from "@/lib/cadence";
import type { RecipeAdditionInfo } from "./entries";

/**
 * Reading a list's world out of Postgres.
 *
 * This is the initial payload a client hydrates from. Once hydrated the client
 * works from IndexedDB and the op stream, so this runs on a cold open and after
 * a long absence — not on every interaction.
 */

export interface ListSnapshot {
  list: List;
  categories: Category[];
  catalog: CatalogItem[];
  entries: ListEntry[];
  contributions: Contribution[];
  recipeAdditions: Record<Id, RecipeAdditionInfo>;
  /** Cadence suggestions, already ranked and filtered. */
  suggestions: Array<{ catalogItemId: Id; reason: string }>;
}

function toAmount(
  value: number | null,
  unit: string | null,
): { value: number; unit: Unit } | null {
  if (value === null || unit === null) return null;
  return { value, unit: unit as Unit };
}

export async function loadListSnapshot(
  listId: Id,
  now: Date,
): Promise<ListSnapshot | null> {
  const [listRow] = await db
    .select()
    .from(lists)
    .where(and(eq(lists.id, listId), isNull(lists.deletedAt)))
    .limit(1);
  if (!listRow) return null;

  const [categoryRows, catalogRows, entryRows] = await Promise.all([
    db.select().from(categories).orderBy(asc(categories.position)),
    db
      .select()
      .from(catalogItems)
      // Recency and frequency are applied below; this ordering is only a stable
      // tie-break so the catalog never reshuffles arbitrarily between loads.
      .orderBy(desc(catalogItems.useCount), asc(catalogItems.name)),
    db.select().from(listEntries).where(eq(listEntries.listId, listId)),
  ]);

  const entryIds = entryRows.map((e) => e.id);
  // No swallowing errors here: a failed contributions query would render every
  // quantity blank, which reads as "no amount specified" rather than as a bug —
  // and sends you home with 4 dl instead of 11.
  const contributionRows = entryIds.length
    ? await db
        .select()
        .from(contributions)
        .where(inArray(contributions.entryId, entryIds))
    : [];

  // Recipe additions still live on this list, with their titles resolved so the
  // breakdown sheet can say "Blåbärsmuffins ×2" rather than an opaque id.
  const additionRows = await db
    .select({
      id: recipeAdditions.id,
      scaleFactor: recipeAdditions.scaleFactor,
      title: recipes.title,
    })
    .from(recipeAdditions)
    .innerJoin(recipes, eq(recipes.id, recipeAdditions.recipeId))
    .where(
      and(
        eq(recipeAdditions.listId, listId),
        isNull(recipeAdditions.removedAt),
      ),
    );

  const additions: Record<Id, RecipeAdditionInfo> = {};
  for (const a of additionRows) {
    additions[a.id] = { recipeTitle: a.title, scaleFactor: a.scaleFactor };
  }

  const catalog: CatalogItem[] = catalogRows.map((c) => ({
    id: c.id,
    name: c.name,
    nameNorm: c.nameNorm,
    categoryId: c.categoryId,
    iconRef: c.iconRef,
    isCustom: c.isCustom,
    hasAtHome: c.hasAtHome,
    useCount: c.useCount,
    lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
  }));

  // Recency+frequency ordering. This is the cheap mechanism that makes the
  // catalog feel personal after about three shops, long before the cadence
  // engine has enough history to say anything.
  catalog.sort(
    (a, b) =>
      catalogOrderScore(
        b.useCount,
        b.lastUsedAt ? new Date(b.lastUsedAt) : null,
        now,
      ) -
        catalogOrderScore(
          a.useCount,
          a.lastUsedAt ? new Date(a.lastUsedAt) : null,
          now,
        ) || a.name.localeCompare(b.name, "sv"),
  );

  const entries: ListEntry[] = entryRows.map((e) => ({
    id: e.id,
    listId: e.listId,
    catalogItemId: e.catalogItemId,
    createdAt: e.createdAt.toISOString(),
    createdBy: e.createdBy,
    removedAt: e.removedAt?.toISOString() ?? null,
    updatedAt: e.updatedAt.toISOString(),
    updatedBy: e.updatedBy,
  }));

  return {
    list: {
      id: listRow.id,
      name: listRow.name,
      icon: listRow.icon,
      position: listRow.position,
      categoryOrder: listRow.categoryOrder,
    },
    categories: categoryRows.map((c) => ({
      id: c.id,
      name: c.name,
      icon: c.icon,
      position: c.position,
    })),
    catalog,
    entries,
    contributions: contributionRows.map((c) => ({
      id: c.id,
      entryId: c.entryId,
      sourceKind: c.sourceKind,
      recipeAdditionId: c.recipeAdditionId,
      amount: toAmount(c.amountValue, c.amountUnit),
      note: c.note,
    })),
    recipeAdditions: additions,
    suggestions: await loadSuggestions(listId, entries, now),
  };
}

/**
 * Rank purchase history into the "Föreslås" row.
 *
 * Pulls the last two years of purchases — enough for the engine to see a yearly
 * pattern, bounded enough that the query stays cheap as history grows.
 */
async function loadSuggestions(
  listId: Id,
  entries: ListEntry[],
  now: Date,
): Promise<Array<{ catalogItemId: Id; reason: string }>> {
  const since = new Date(now);
  since.setFullYear(since.getFullYear() - 2);

  const rows = await db
    .select({
      catalogItemId: purchases.catalogItemId,
      purchasedAt: purchases.purchasedAt,
    })
    .from(purchases)
    .where(
      and(eq(purchases.listId, listId), gte(purchases.purchasedAt, since)),
    )
    .orderBy(asc(purchases.purchasedAt));

  const byItem = new Map<Id, Date[]>();
  for (const r of rows) {
    const list = byItem.get(r.catalogItemId);
    if (list) list.push(r.purchasedAt);
    else byItem.set(r.catalogItemId, [r.purchasedAt]);
  }

  const onList = new Set(
    entries.filter((e) => e.removedAt === null).map((e) => e.catalogItemId),
  );

  return rankSuggestions(
    [...byItem.entries()].map(([catalogItemId, purchases]) => ({
      catalogItemId,
      purchases,
    })),
    { now, excludeItemIds: onList },
  ).map((s) => ({ catalogItemId: s.catalogItemId, reason: s.reason }));
}

export async function loadLists(): Promise<List[]> {
  const rows = await db
    .select()
    .from(lists)
    .where(isNull(lists.deletedAt))
    .orderBy(asc(lists.position));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    icon: r.icon,
    position: r.position,
    categoryOrder: r.categoryOrder,
  }));
}
