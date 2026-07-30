import { and, asc, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  catalogItems,
  categories,
  contributions,
  listEntries,
  lists,
  products,
  purchases,
  recipeAdditions,
  recipes,
} from "@/db/schema";
import { isClearedManualContribution } from "@/lib/domain";
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
import {
  analyzeCadence,
  catalogOrderScore,
  rankSuggestions,
  type CadenceStats,
} from "@/lib/cadence";
import {
  additionKey,
  catalogFieldKey,
  catalogKey,
  contributionFieldKey,
  contributionKey,
  entryKey,
  entryPriorityKey,
  listKey,
} from "@/lib/sync";
import { catalogFieldClocks } from "./clocks";
import {
  effectiveCatalogItemId,
  purchaseProductJoin,
} from "./purchase-attribution";
import { dismissedOn } from "./suggestion-dismissals";

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
  /**
   * Per-item purchase cadence, for items with any history at all.
   *
   * Deliberately HOUSEHOLD-wide rather than per-list, unlike `suggestions`.
   * "Should I buy this here" is a question about this shop; "do we already have
   * this in the cupboard" is a question about the kitchen, and the answer does not
   * change because you happened to buy it at Bauhaus last time.
   *
   * Sent as a digest rather than raw dates: the median and the confidence do not
   * age, only `daysSinceLast` does, and that is recomputable from the last
   * purchase whenever it is needed.
   */
  purchaseStats: Record<Id, CadenceStats>;
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
      removedAt: recipeAdditions.removedAt,
      updatedAt: recipeAdditions.updatedAt,
      updatedBy: recipeAdditions.updatedBy,
      title: recipes.title,
    })
    .from(recipeAdditions)
    .innerJoin(recipes, eq(recipes.id, recipeAdditions.recipeId))
    // Removed additions are loaded too, deliberately. Filtering them out here
    // meant a hydrating client received neither the row NOR its clock — and a
    // missing clock is not "no opinion", it is "anything wins": `wins(op,
    // undefined)` is true whatever the op's timestamp. So a stale `add_recipe`
    // replayed from an outbox resurrected the removed recipe and every
    // contribution it asked for. The row is still withheld below; only the
    // tombstone travels.
    .where(eq(recipeAdditions.listId, listId));

  const meta: Record<string, RecordMeta> = {};
  const additions: Record<Id, RecipeAddition> = {};
  const recipeTitles: Record<Id, string> = {};
  for (const a of additionRows) {
    const deleted = a.removedAt !== null;
    // The clock travels for every addition; the record and its title only for
    // the ones still on the list. Same shape as `apply-op`'s own loader, which
    // has always done this correctly — the two must agree, since one reducer
    // resolves against both.
    meta[additionKey(a.id)] = {
      at: a.updatedAt.toISOString(),
      by: a.updatedBy,
      deleted: deleted ? true : undefined,
    };
    if (deleted) continue;

    additions[a.id] = {
      id: a.id,
      listId: a.listId,
      recipeId: a.recipeId,
      scaleFactor: a.scaleFactor,
      addedAt: a.addedAt.toISOString(),
      addedBy: a.addedBy,
    };
    recipeTitles[a.recipeId] = a.title;
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
    // The four editable facts each resolve against their own clock — see the
    // reducer's update_catalog_item. Emitted here as well as in `apply-op`'s
    // loader because a hydrating client resolves the same ops against the same
    // reducer, and a clock the two loaders disagree about is worse than one
    // neither has: a missing key reads as "no prior record", so the newest
    // write always wins and conflict resolution silently stops working.
    for (const [field, clock] of catalogFieldClocks(c)) {
      meta[catalogFieldKey(c.id, field)] = clock;
    }
  }
  for (const e of entryRows) {
    meta[entryKey(e.id)] = {
      at: e.updatedAt.toISOString(),
      by: e.updatedBy,
      // Tombstoned entries already travel as records (removedAt is a normal
      // field on ListEntry), so this is harmless today — `wins()` ignores
      // `deleted`. It stops being harmless the moment anything calls
      // `pruneTombstones` client-side, which prunes on exactly this flag: an
      // entry whose clock never said "deleted" would be kept, then resurrected.
      // Same shape as the bug already fixed once in `writeEntry`.
      deleted: e.removedAt !== null ? true : undefined,
    };
    // Absent when never written, exactly as in `apply-op`'s loader: NULL means
    // no op has set a priority, and the first one to arrive should land whatever
    // its timestamp.
    if (e.priorityUpdatedAt && e.priorityUpdatedBy) {
      meta[entryPriorityKey(e.id)] = {
        at: e.priorityUpdatedAt.toISOString(),
        by: e.priorityUpdatedBy,
      };
    }
  }
  for (const c of contributionRows) {
    const row = { at: c.updatedAt.toISOString(), by: c.updatedBy };
    meta[contributionKey(c.id)] = row;
    // An unset per-field clock emits NOTHING, rather than falling back to the
    // row clock — see the column comment in src/db/schema.ts. The row clock
    // moves on every write to either field, so the fallback silently handed one
    // field the other's timestamp and cost a genuinely newer write, in one
    // arrival order only. Absent is what the reducer holds for a field no op has
    // touched, and absent is what must be reconstructed.
    if (c.amountUpdatedAt && c.amountUpdatedBy) {
      meta[contributionFieldKey(c.id, "amount")] = {
        at: c.amountUpdatedAt.toISOString(),
        by: c.amountUpdatedBy,
      };
    }
    if (c.noteUpdatedAt && c.noteUpdatedBy) {
      meta[contributionFieldKey(c.id, "note")] = {
        at: c.noteUpdatedAt.toISOString(),
        by: c.noteUpdatedBy,
      };
    }
    if (c.modifierUpdatedAt && c.modifierUpdatedBy) {
      meta[contributionFieldKey(c.id, "modifier")] = {
        at: c.modifierUpdatedAt.toISOString(),
        by: c.modifierUpdatedBy,
      };
    }
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
    priority: e.priority,
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
    // Emptied manual rows are withheld, exactly as `apply-op`'s loader withholds
    // them and for the same reason: the row exists only to carry the per-field
    // clocks emitted above, and a hydrating client that took it as a record
    // would hold a contribution the reducer never produces. Only the clock
    // travels — the same shape as a removed recipe addition.
    contributions: contributionRows
      .map((c) => ({
        id: c.id,
        entryId: c.entryId,
        sourceKind: c.sourceKind,
        recipeAdditionId: c.recipeAdditionId,
        amount: toAmount(c.amountValue, c.amountUnit),
        note: c.note,
        modifier: c.modifier,
      }))
      .filter((c) => !isClearedManualContribution(c)),
    recipeAdditions: additions,
    recipeTitles,
    meta,
    suggestions: await loadSuggestions(listId, entries, now),
    purchaseStats: await loadPurchaseStats(now),
  };
}

/**
 * Purchase cadence per item, across the whole household.
 *
 * Same two-year window and the same engine as the suggestion row, so the two can
 * never disagree about how often you buy something. The only difference is scope:
 * this one is not filtered by list.
 */
async function loadPurchaseStats(now: Date): Promise<Record<Id, CadenceStats>> {
  const since = new Date(now);
  since.setFullYear(since.getFullYear() - 2);

  const rows = await db
    .select({
      catalogItemId: effectiveCatalogItemId,
      purchasedAt: purchases.purchasedAt,
    })
    .from(purchases)
    .leftJoin(products, purchaseProductJoin)
    .where(gte(purchases.purchasedAt, since))
    .orderBy(asc(purchases.purchasedAt));

  const byItem = new Map<Id, Date[]>();
  for (const r of rows) {
    // NULL here means a scan of a product nobody has placed on a vara yet, so
    // there is no honest answer to "how often do we buy this" — deferred, not
    // lost. See purchase-attribution.ts.
    if (r.catalogItemId === null) continue;
    const list = byItem.get(r.catalogItemId);
    if (list) list.push(r.purchasedAt);
    else byItem.set(r.catalogItemId, [r.purchasedAt]);
  }

  const out: Record<Id, CadenceStats> = {};
  for (const [catalogItemId, dates] of byItem) {
    out[catalogItemId] = analyzeCadence(dates, now);
  }
  return out;
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
      catalogItemId: effectiveCatalogItemId,
      purchasedAt: purchases.purchasedAt,
    })
    .from(purchases)
    .leftJoin(products, purchaseProductJoin)
    .where(
      and(eq(purchases.listId, listId), gte(purchases.purchasedAt, since)),
    )
    .orderBy(asc(purchases.purchasedAt));

  const byItem = new Map<Id, Date[]>();
  for (const r of rows) {
    // Same resolution as `loadPurchaseStats`, and it has to be literally the
    // same one: the suggestion row and the cadence stats must never disagree
    // about how often you buy something.
    if (r.catalogItemId === null) continue;
    const list = byItem.get(r.catalogItemId);
    if (list) list.push(r.purchasedAt);
    else byItem.set(r.catalogItemId, [r.purchasedAt]);
  }

  // Already wanted, or explicitly declined today. Both are the same instruction
  // to the engine — "do not offer me this" — so they go in as one exclusion set
  // rather than as a second concept inside `rankSuggestions`. The dismissals are
  // household-wide by design; see src/lib/services/suggestion-dismissals.ts.
  const exclude = new Set(
    entries.filter((e) => e.removedAt === null).map((e) => e.catalogItemId),
  );
  for (const id of await dismissedOn(now)) exclude.add(id);

  return rankSuggestions(
    [...byItem.entries()].map(([catalogItemId, purchases]) => ({
      catalogItemId,
      purchases,
    })),
    { now, excludeItemIds: exclude },
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
