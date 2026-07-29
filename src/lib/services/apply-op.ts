import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  catalogItems,
  contributions,
  listEntries,
  lists,
  ops as opsTable,
  purchases,
  recipeAdditions,
} from "@/db/schema";
import {
  emptyState,
  entryId,
  type Id,
  type RecordMeta,
  type SyncState,
  type Unit,
} from "@/lib/domain";
import { applyOp, opListId, type Op } from "@/lib/sync";

/**
 * Applying an operation on the server.
 *
 * The load-bearing decision here is that this uses the SAME reducer the browser
 * uses. It loads the slice of state an op can touch, runs `applyOp`, and writes
 * back the difference. Reimplementing op semantics in SQL would be faster to
 * write and would eventually disagree with the client in some corner nobody
 * tests — and a disagreement here means two people's shopping lists quietly
 * stop matching, with no error anywhere.
 */

/**
 * Rebuild the reducer's LWW keys from the database's own columns.
 *
 * These strings must match src/lib/sync/reducer.ts exactly. A typo does not
 * throw — it silently makes every comparison look like "no prior record", so
 * the newest write always wins and conflict resolution quietly stops working.
 */
const metaKeys = {
  list: (id: Id) => `list:${id}`,
  catalog: (id: Id) => `catalog:${id}`,
  entry: (id: Id) => `entry:${id}`,
  contribution: (id: Id) => `contribution:${id}`,
  contributionField: (id: Id, field: "amount" | "note") =>
    `contribution:${id}:${field}`,
  addition: (id: Id) => `addition:${id}`,
};

function meta(at: Date, by: string): RecordMeta {
  return { at: at.toISOString(), by };
}

/**
 * Load only what this op can touch.
 *
 * Loading the whole database would be correct and would also get slower every
 * week the household uses the app. The reducer only ever reads the entries and
 * contributions of one list, plus the catalog rows the op names by id.
 */
async function loadSlice(op: Op): Promise<SyncState> {
  const state = emptyState();
  const listId = opListId(op);

  const listIds = [
    ...new Set(
      [
        listId,
        op.kind === "move_item" ? op.fromListId : null,
        op.kind === "move_item" ? op.toListId : null,
      ].filter((v): v is Id => Boolean(v)),
    ),
  ];

  if (listIds.length) {
    const listRows = await db
      .select()
      .from(lists)
      .where(inArray(lists.id, listIds));
    for (const l of listRows) {
      state.lists[l.id] = {
        id: l.id,
        name: l.name,
        icon: l.icon,
        position: l.position,
        categoryOrder: l.categoryOrder,
      };
      state.meta[metaKeys.list(l.id)] = l.deletedAt
        ? { ...meta(l.updatedAt, l.updatedBy), deleted: true }
        : meta(l.updatedAt, l.updatedBy);
    }

    const entryRows = await db
      .select()
      .from(listEntries)
      .where(inArray(listEntries.listId, listIds));

    for (const e of entryRows) {
      state.entries[e.id] = {
        id: e.id,
        listId: e.listId,
        catalogItemId: e.catalogItemId,
        createdAt: e.createdAt.toISOString(),
        createdBy: e.createdBy,
        removedAt: e.removedAt?.toISOString() ?? null,
        updatedAt: e.updatedAt.toISOString(),
        updatedBy: e.updatedBy,
      };
      state.meta[metaKeys.entry(e.id)] = meta(e.updatedAt, e.updatedBy);
    }

    if (entryRows.length) {
      const contribRows = await db
        .select()
        .from(contributions)
        .where(
          inArray(
            contributions.entryId,
            entryRows.map((e) => e.id),
          ),
        );
      for (const c of contribRows) {
        state.contributions[c.id] = {
          id: c.id,
          entryId: c.entryId,
          sourceKind: c.sourceKind,
          recipeAdditionId: c.recipeAdditionId,
          amount:
            c.amountValue !== null && c.amountUnit !== null
              ? { value: c.amountValue, unit: c.amountUnit as Unit }
              : null,
          note: c.note,
        };
        const m = meta(c.updatedAt, c.updatedBy);
        state.meta[metaKeys.contribution(c.id)] = m;
        // Manual contributions carry a clock per field — amount and note are
        // independent facts and a shared clock loses one of them.
        state.meta[metaKeys.contributionField(c.id, "amount")] = m;
        state.meta[metaKeys.contributionField(c.id, "note")] = m;
      }
    }

    const additionRows = await db
      .select()
      .from(recipeAdditions)
      .where(inArray(recipeAdditions.listId, listIds));
    for (const a of additionRows) {
      if (!a.removedAt) {
        state.recipeAdditions[a.id] = {
          id: a.id,
          listId: a.listId,
          recipeId: a.recipeId,
          scaleFactor: a.scaleFactor,
          addedAt: a.addedAt.toISOString(),
          addedBy: a.addedBy,
        };
      }
      state.meta[metaKeys.addition(a.id)] = a.removedAt
        ? { ...meta(a.updatedAt, a.updatedBy), deleted: true }
        : meta(a.updatedAt, a.updatedBy);
    }
  }

  // Catalog rows the op names directly.
  const itemIds = new Set<Id>();
  if ("catalogItemId" in op) itemIds.add(op.catalogItemId);
  if (op.kind === "create_catalog_item") itemIds.add(op.item.id);
  if (op.kind === "update_catalog_item") itemIds.add(op.itemId);
  if (op.kind === "add_recipe") {
    for (const i of op.items) itemIds.add(i.catalogItemId);
  }

  if (itemIds.size) {
    const rows = await db
      .select()
      .from(catalogItems)
      .where(inArray(catalogItems.id, [...itemIds]));
    for (const c of rows) {
      state.catalog[c.id] = {
        id: c.id,
        name: c.name,
        nameNorm: c.nameNorm,
        categoryId: c.categoryId,
        iconRef: c.iconRef,
        isCustom: c.isCustom,
        hasAtHome: c.hasAtHome,
        useCount: c.useCount,
        lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
      };
      state.meta[metaKeys.catalog(c.id)] = meta(c.updatedAt, c.updatedBy);
    }
  }

  return state;
}

export interface ApplyResult {
  clientOpId: string;
  seq: number;
  /** True when this op had already been applied and was skipped. */
  duplicate: boolean;
}

export async function applyOpToDatabase(op: Op): Promise<ApplyResult> {
  // Idempotency first. A client that retried after a flaky response must not
  // apply its op twice — and it cannot tell whether the first attempt landed.
  const [existing] = await db
    .select({ seq: opsTable.seq })
    .from(opsTable)
    .where(eq(opsTable.clientOpId, op.clientOpId))
    .limit(1);
  if (existing) {
    return { clientOpId: op.clientOpId, seq: existing.seq, duplicate: true };
  }

  const before = await loadSlice(op);
  const after = applyOp(before, op);
  const at = new Date(op.at);

  return await db.transaction(async (tx) => {
    // --- lists ---------------------------------------------------------
    for (const [id, list] of Object.entries(after.lists)) {
      if (before.lists[id] === list) continue;
      await tx
        .insert(lists)
        .values({ ...list, updatedAt: at, updatedBy: op.actor })
        .onConflictDoUpdate({
          target: lists.id,
          set: {
            name: list.name,
            icon: list.icon,
            position: list.position,
            categoryOrder: list.categoryOrder,
            deletedAt: null,
            updatedAt: at,
            updatedBy: op.actor,
          },
        });
    }
    for (const id of Object.keys(before.lists)) {
      if (!after.lists[id]) {
        await tx
          .update(lists)
          .set({ deletedAt: at, updatedAt: at, updatedBy: op.actor })
          .where(eq(lists.id, id));
      }
    }

    // --- catalog -------------------------------------------------------
    for (const [id, cat] of Object.entries(after.catalog)) {
      if (before.catalog[id] === cat) continue;
      await tx
        .insert(catalogItems)
        .values({
          ...cat,
          lastUsedAt: cat.lastUsedAt ? new Date(cat.lastUsedAt) : null,
          updatedAt: at,
          updatedBy: op.actor,
        })
        .onConflictDoUpdate({
          target: catalogItems.id,
          set: {
            name: cat.name,
            nameNorm: cat.nameNorm,
            categoryId: cat.categoryId,
            iconRef: cat.iconRef,
            hasAtHome: cat.hasAtHome,
            updatedAt: at,
            updatedBy: op.actor,
          },
        });
    }

    // --- entries -------------------------------------------------------
    for (const [id, entry] of Object.entries(after.entries)) {
      if (before.entries[id] === entry) continue;
      await tx
        .insert(listEntries)
        .values({
          id,
          listId: entry.listId,
          catalogItemId: entry.catalogItemId,
          createdAt: new Date(entry.createdAt),
          createdBy: entry.createdBy,
          removedAt: entry.removedAt ? new Date(entry.removedAt) : null,
          updatedAt: new Date(entry.updatedAt),
          updatedBy: entry.updatedBy,
        })
        .onConflictDoUpdate({
          target: listEntries.id,
          set: {
            createdAt: new Date(entry.createdAt),
            createdBy: entry.createdBy,
            removedAt: entry.removedAt ? new Date(entry.removedAt) : null,
            updatedAt: new Date(entry.updatedAt),
            updatedBy: entry.updatedBy,
          },
        });
    }

    // --- contributions --------------------------------------------------
    for (const [id, c] of Object.entries(after.contributions)) {
      if (before.contributions[id] === c) continue;
      await tx
        .insert(contributions)
        .values({
          id,
          entryId: c.entryId,
          sourceKind: c.sourceKind,
          recipeAdditionId: c.recipeAdditionId,
          amountValue: c.amount?.value ?? null,
          amountUnit: c.amount?.unit ?? null,
          note: c.note,
          updatedAt: at,
          updatedBy: op.actor,
        })
        .onConflictDoUpdate({
          target: contributions.id,
          set: {
            amountValue: c.amount?.value ?? null,
            amountUnit: c.amount?.unit ?? null,
            note: c.note,
            updatedAt: at,
            updatedBy: op.actor,
          },
        });
    }
    const goneContributions = Object.keys(before.contributions).filter(
      (id) => !after.contributions[id],
    );
    if (goneContributions.length) {
      await tx
        .delete(contributions)
        .where(inArray(contributions.id, goneContributions));
    }

    // --- recipe additions -----------------------------------------------
    for (const [id, a] of Object.entries(after.recipeAdditions)) {
      if (before.recipeAdditions[id] === a) continue;
      await tx
        .insert(recipeAdditions)
        .values({
          id,
          listId: a.listId,
          recipeId: a.recipeId,
          scaleFactor: a.scaleFactor,
          addedAt: new Date(a.addedAt),
          addedBy: a.addedBy,
          updatedAt: at,
          updatedBy: op.actor,
        })
        .onConflictDoNothing();
    }
    for (const id of Object.keys(before.recipeAdditions)) {
      if (!after.recipeAdditions[id]) {
        await tx
          .update(recipeAdditions)
          .set({ removedAt: at, updatedAt: at, updatedBy: op.actor })
          .where(eq(recipeAdditions.id, id));
      }
    }

    // --- purchase history ------------------------------------------------
    // The ONLY place purchases are written, and the cadence engine's entire
    // input. `bought: false` deliberately writes nothing — that path exists so
    // a change of mind cannot teach the engine that you buy saffran weekly.
    if (op.kind === "remove_item" && op.bought) {
      const eid = entryId(op.listId, op.catalogItemId);
      const wasOnList = before.entries[eid]?.removedAt === null;
      if (wasOnList) {
        await tx.insert(purchases).values({
          id: `${op.clientOpId}:purchase`,
          catalogItemId: op.catalogItemId,
          listId: op.listId,
          purchasedAt: at,
          actor: op.actor,
        });
        await tx
          .update(catalogItems)
          .set({
            useCount: sql`${catalogItems.useCount} + 1`,
            lastUsedAt: at,
          })
          .where(eq(catalogItems.id, op.catalogItemId));
      }
    }

    const [row] = await tx
      .insert(opsTable)
      .values({
        clientOpId: op.clientOpId,
        listId: opListId(op),
        actor: op.actor,
        kind: op.kind,
        payload: op,
        at,
      })
      .returning({ seq: opsTable.seq });

    return { clientOpId: op.clientOpId, seq: row.seq, duplicate: false };
  });
}

/** Catch-up feed: everything after a client's cursor. */
export async function opsSince(seq: number, listId?: Id): Promise<
  Array<{ seq: number; op: Op }>
> {
  const rows = await db
    .select({ seq: opsTable.seq, payload: opsTable.payload })
    .from(opsTable)
    .where(
      listId
        ? and(sql`${opsTable.seq} > ${seq}`, eq(opsTable.listId, listId))
        : sql`${opsTable.seq} > ${seq}`,
    )
    .orderBy(opsTable.seq);

  return rows.map((r) => ({ seq: r.seq, op: r.payload as Op }));
}
