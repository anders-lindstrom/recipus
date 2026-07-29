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
  RecipeAddition,
  RecordMeta,
  Unit,
} from "@/lib/domain";
import { rankSuggestions, catalogOrderScore } from "@/lib/cadence";
import {
  additionKey,
  catalogKey,
  contributionFieldKey,
  contributionKey,
  entryKey,
  listKey,
} from "@/lib/sync";

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
  /**
   * Full records, in the shape the reducer needs — NOT display info.
   *
   * This carried `{recipeTitle, scaleFactor}` at first, which meant a client
   * hydrating from a snapshot could not populate `SyncState.recipeAdditions`
   * at all and had to leave it empty. Recipe-sourced tiles then lost their
   * badge and their breakdown until an `add_recipe` op happened to arrive.
   * Titles travel separately in `recipeTitles`.
   */
  recipeAdditions: Record<Id, RecipeAddition>;
  /** recipeId → title, for the breakdown sheet. */
  recipeTitles: Record<Id, string>;
  /**
   * Last-write-wins bookkeeping, rebuilt from the rows' own timestamps.
   *
   * Without this a hydrating client starts with empty meta, so a stale op
   * replayed from its outbox beats a fresher server value — it looks like a
   * won comparison because there is nothing to compare against. Keys come from
   * the reducer's own builders so they cannot drift.
   */
  meta: Record<string, RecordMeta>;
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
      listId: recipeAdditions.listId,
      recipeId: recipeAdditions.recipeId,
      scaleFactor: recipeAdditions.scaleFactor,
      addedAt: recipeAdditions.addedAt,
      addedBy: recipeAdditions.addedBy,
      updatedAt: recipeAdditions.updatedAt,
      updatedBy: recipeAdditions.updatedBy,
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

  const meta: Record<string, RecordMeta> = {};
  const additions: Record<Id, RecipeAddition> = {};
  const recipeTitles: Record<Id, string> = {};
  for (const a of additionRows) {
    additions[a.id] = {
      id: a.id,
      listId: a.listId,
      recipeId: a.recipeId,
      scaleFactor: a.scaleFactor,
      addedAt: a.addedAt.toISOString(),
      addedBy: a.addedBy,
    };
    recipeTitles[a.recipeId] = a.title;
    meta[additionKey(a.id)] = {
      at: a.updatedAt.toISOString(),
      by: a.updatedBy,
    };
  }

  meta[listKey(listRow.id)] = {
    at: listRow.updatedAt.toISOString(),
    by: listRow.updatedBy,
  };
  for (const c of catalogRows) {
    meta[catalogKey(c.id)] = {
      at: c.updatedAt.toISOString(),
      by: c.updatedBy,
    };
  }
  for (const e of entryRows) {
    meta[entryKey(e.id)] = {
      at: e.updatedAt.toISOString(),
      by: e.updatedBy,
    };
  }
  for (const c of contributionRows) {
    const row = { at: c.updatedAt.toISOString(), by: c.updatedBy };
    meta[contributionKey(c.id)] = row;
    // Per-field clocks fall back to the row clock: recipe and scan
    // contributions never populate them, and neither do pre-migration rows.
    meta[contributionFieldKey(c.id, "amount")] =
      c.amountUpdatedAt && c.amountUpdatedBy
        ? { at: c.amountUpdatedAt.toISOString(), by: c.amountUpdatedBy }
        : row;
    meta[contributionFieldKey(c.id, "note")] =
      c.noteUpdatedAt && c.noteUpdatedBy
        ? { at: c.noteUpdatedAt.toISOString(), by: c.noteUpdatedBy }
        : row;
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
    recipeTitles,
    meta,
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
