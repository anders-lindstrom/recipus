import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
  entryId as makeEntryId,
  isClearedManualContribution,
  manualContributionId,
  recipeContributionId,
  type Amount,
  type Contribution,
  type Id,
  type RecordMeta,
  type SyncState,
  type Unit,
} from "@/lib/domain";
import {
  additionKey,
  applyOp,
  catalogFieldKey,
  catalogKey,
  contributionFieldKey,
  contributionKey,
  entryKey,
  entryPriorityKey,
  listKey,
  opListId,
  CATALOG_FIELDS,
  type CatalogField,
  type ManualField,
  type Op,
} from "@/lib/sync";
import {
  catalogClockColumns,
  catalogFieldClocks,
  latestClock,
} from "./clocks";

/**
 * Applying one client op to Postgres.
 *
 * This runs the SAME reducer the browser runs (`applyOp` from src/lib/sync) —
 * see that module's header comment for why a second implementation here would
 * be a bug waiting to happen. This file's only job is the plumbing around it:
 * load just enough of the database to build the `SyncState` slice the op
 * touches, hand it to the reducer, and write back whatever changed.
 *
 * The LWW meta keys (listKey/catalogKey/entryKey/contributionKey/
 * contributionFieldKey/additionKey) are imported from src/lib/sync rather
 * than redefined here — they used to be duplicated locally, which is exactly
 * the kind of thing that silently drifts. One definition, imported on both
 * sides, cannot.
 */

function toAmount(value: number | null, unit: string | null): Amount | null {
  return value === null || unit === null ? null : { value, unit: unit as Unit };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Which rows this op could possibly touch, gathered while loading — reused
 * verbatim by `persist` so "what did we load" and "what do we write back" can
 * never drift apart into two separate lists that disagree.
 */
interface Scope {
  listIds: Set<Id>;
  catalogIds: Set<Id>;
  entryIds: Set<Id>;
  /**
   * set_amount/set_note touch exactly one manual contribution's ONE field —
   * never both, and never more than one entry — so this is a single optional
   * slot rather than a set.
   */
  manualContributionField: { entryId: Id; field: ManualField } | null;
  contributionIds: Set<Id>;
  additionIds: Set<Id>;
}

function emptyScope(): Scope {
  return {
    listIds: new Set(),
    catalogIds: new Set(),
    entryIds: new Set(),
    manualContributionField: null,
    contributionIds: new Set(),
    additionIds: new Set(),
  };
}

/**
 * Load the affected slice of SyncState for one op — the op's list, its
 * entries, their contributions, its recipe addition, plus the catalog rows it
 * names. Deliberately NOT the whole database: every query here is scoped to
 * ids the op itself names, or (delete_list / remove_recipe) a single indexed
 * WHERE clause bounded to one list/addition.
 */
async function loadStateSlice(
  tx: Tx,
  op: Op,
): Promise<{ state: SyncState; scope: Scope }> {
  const scope = emptyScope();

  switch (op.kind) {
    case "create_list":
    case "update_list":
      scope.listIds.add(op.listId);
      break;
    case "delete_list":
      scope.listIds.add(op.listId);
      break;
    case "create_catalog_item":
      scope.catalogIds.add(op.item.id);
      break;
    case "update_catalog_item":
      scope.catalogIds.add(op.itemId);
      break;
    case "add_item":
    case "remove_item":
    // Priority lives on the entry row, so it needs no contribution loaded.
    case "set_priority":
      scope.entryIds.add(makeEntryId(op.listId, op.catalogItemId));
      break;
    case "set_amount":
    case "set_note":
    case "set_modifier": {
      const eid = makeEntryId(op.listId, op.catalogItemId);
      scope.entryIds.add(eid);
      scope.manualContributionField = {
        entryId: eid,
        field:
          op.kind === "set_amount"
            ? "amount"
            : op.kind === "set_note"
              ? "note"
              : "modifier",
      };
      break;
    }
    case "add_recipe": {
      scope.additionIds.add(op.recipeAdditionId);
      for (const item of op.items) {
        scope.entryIds.add(makeEntryId(op.listId, item.catalogItemId));
        scope.contributionIds.add(
          recipeContributionId(op.recipeAdditionId, item.catalogItemId),
        );
      }
      break;
    }
    case "remove_recipe":
      scope.additionIds.add(op.recipeAdditionId);
      break;
    case "move_item":
      scope.entryIds.add(makeEntryId(op.fromListId, op.catalogItemId));
      scope.entryIds.add(makeEntryId(op.toListId, op.catalogItemId));
      break;
  }

  const state = emptyState();

  const [
    listRows,
    catalogRows,
    entryRows,
    deleteListEntryRows,
    manualContribRows,
    recipeContribRows,
    additionRows,
    removeRecipeContribRows,
  ] = await Promise.all([
    scope.listIds.size
      ? tx.select().from(lists).where(inArray(lists.id, [...scope.listIds]))
      : Promise.resolve([]),
    scope.catalogIds.size
      ? tx
          .select()
          .from(catalogItems)
          .where(inArray(catalogItems.id, [...scope.catalogIds]))
      : Promise.resolve([]),
    scope.entryIds.size
      ? tx
          .select()
          .from(listEntries)
          .where(inArray(listEntries.id, [...scope.entryIds]))
      : Promise.resolve([]),
    // delete_list tombstones every ACTIVE entry on the list — the reducer
    // skips ones already removed, so there is no need to load those too.
    op.kind === "delete_list"
      ? tx
          .select()
          .from(listEntries)
          .where(
            and(eq(listEntries.listId, op.listId), isNull(listEntries.removedAt)),
          )
      : Promise.resolve([]),
    scope.manualContributionField
      ? tx
          .select()
          .from(contributions)
          .where(
            eq(
              contributions.id,
              manualContributionId(scope.manualContributionField.entryId),
            ),
          )
      : Promise.resolve([]),
    scope.contributionIds.size
      ? tx
          .select()
          .from(contributions)
          .where(inArray(contributions.id, [...scope.contributionIds]))
      : Promise.resolve([]),
    scope.additionIds.size
      ? tx
          .select()
          .from(recipeAdditions)
          .where(inArray(recipeAdditions.id, [...scope.additionIds]))
      : Promise.resolve([]),
    // remove_recipe drops every contribution tied to this addition — the
    // reducer discovers these by scanning state.contributions, so we must
    // load exactly that set (one indexed query, bounded to one addition).
    op.kind === "remove_recipe"
      ? tx
          .select()
          .from(contributions)
          .where(eq(contributions.recipeAdditionId, op.recipeAdditionId))
      : Promise.resolve([]),
  ]);

  for (const row of listRows) {
    const deleted = row.deletedAt !== null;
    state.meta[listKey(row.id)] = {
      at: row.updatedAt.toISOString(),
      by: row.updatedBy,
      deleted: deleted ? true : undefined,
    };
    if (!deleted) {
      state.lists[row.id] = {
        id: row.id,
        name: row.name,
        icon: row.icon,
        position: row.position,
        categoryOrder: row.categoryOrder,
      };
    }
  }

  for (const row of catalogRows) {
    state.meta[catalogKey(row.id)] = {
      at: row.updatedAt.toISOString(),
      by: row.updatedBy,
    };
    // Four independent clocks, read straight from their own columns. No
    // fallback to the row clock: that clock moves whenever ANY field is
    // written, so a field that fell back to it would silently inherit an
    // unrelated write's timestamp and start beating ops it should lose to.
    for (const [field, clock] of catalogFieldClocks(row)) {
      state.meta[catalogFieldKey(row.id, field)] = clock;
    }
    state.catalog[row.id] = {
      id: row.id,
      name: row.name,
      nameNorm: row.nameNorm,
      categoryId: row.categoryId,
      iconRef: row.iconRef,
      isCustom: row.isCustom,
      hasAtHome: row.hasAtHome,
      useCount: row.useCount,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    };
  }

  for (const row of [...entryRows, ...deleteListEntryRows]) {
    scope.entryIds.add(row.id);
    state.meta[entryKey(row.id)] = {
      at: row.updatedAt.toISOString(),
      by: row.updatedBy,
      deleted: row.removedAt !== null ? true : undefined,
    };
    // Its own clock, and absent when never written — the same rule as the
    // contribution fields, for the same reason: the row clock moves on every
    // add and removal, so falling back to it would let a tap on the tile
    // silently outrank a genuine priority edit.
    if (row.priorityUpdatedAt && row.priorityUpdatedBy) {
      state.meta[entryPriorityKey(row.id)] = {
        at: row.priorityUpdatedAt.toISOString(),
        by: row.priorityUpdatedBy,
      };
    }
    // Entries stay in the map even when tombstoned — removedAt is a normal
    // field on ListEntry, not an omission like lists/catalog/additions.
    state.entries[row.id] = {
      id: row.id,
      listId: row.listId,
      catalogItemId: row.catalogItemId,
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy,
      removedAt: row.removedAt?.toISOString() ?? null,
      priority: row.priority,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    };
  }

  for (const row of manualContribRows) {
    // `amount` and `note` carry independent last-write-wins clocks — a single
    // shared clock lets an older amount write lose to a newer note write and
    // silently drop a quantity nobody touched (see reducer.ts's comment on
    // setManualField).
    //
    // Read straight from their own columns, and an UNSET column emits no meta at
    // all rather than falling back to the row clock. That fallback was the bug:
    // the row clock moves whenever either field is written, so it quietly told
    // the note it had been written at the amount's timestamp. Emitting nothing
    // reproduces what the reducer itself holds for a field no op has touched.
    for (const [field, at, by] of [
      ["amount", row.amountUpdatedAt, row.amountUpdatedBy],
      ["note", row.noteUpdatedAt, row.noteUpdatedBy],
      ["modifier", row.modifierUpdatedAt, row.modifierUpdatedBy],
    ] as const) {
      if (at && by) state.meta[contributionFieldKey(row.id, field)] = {
        at: at.toISOString(),
        by,
      };
    }
    const contribution: Contribution = {
      id: row.id,
      entryId: row.entryId,
      sourceKind: "manual",
      recipeAdditionId: null,
      amount: toAmount(row.amountValue, row.amountUnit),
      note: row.note,
      modifier: row.modifier,
    };
    // The clocks above always travel; the record only when there is something
    // left to record. An emptied row is how a clearing survives in the database
    // (see writeManualContribution) — loading it as a record would hand the
    // reducer a contribution the client, running the same ops, does not have.
    if (!isClearedManualContribution(contribution)) {
      state.contributions[row.id] = contribution;
    }
  }

  for (const row of [...recipeContribRows, ...removeRecipeContribRows]) {
    scope.contributionIds.add(row.id);
    state.meta[contributionKey(row.id)] = {
      at: row.updatedAt.toISOString(),
      by: row.updatedBy,
    };
    state.contributions[row.id] = {
      id: row.id,
      entryId: row.entryId,
      sourceKind: row.sourceKind as SyncState["contributions"][string]["sourceKind"],
      recipeAdditionId: row.recipeAdditionId,
      amount: toAmount(row.amountValue, row.amountUnit),
      note: row.note,
      modifier: row.modifier,
    };
  }

  for (const row of additionRows) {
    const deleted = row.removedAt !== null;
    state.meta[additionKey(row.id)] = {
      at: row.updatedAt.toISOString(),
      by: row.updatedBy,
      deleted: deleted ? true : undefined,
    };
    if (!deleted) {
      state.recipeAdditions[row.id] = {
        id: row.id,
        listId: row.listId,
        recipeId: row.recipeId,
        scaleFactor: row.scaleFactor,
        addedAt: row.addedAt.toISOString(),
        addedBy: row.addedBy,
      };
    }
  }

  return { state, scope };
}

// ---------------------------------------------------------------------------
// Writing the result back. Each writer recomputes the row's target state from
// `next` (the reducer's output) and unconditionally upserts it — never a
// before/after diff. If the op lost the last-write-wins comparison, `next`
// equals the loaded state exactly, so the "upsert" is a no-op write of
// unchanged values. That is simpler and harder to get wrong than diffing, at
// the cost of a few redundant UPDATEs on a losing op — cheap for a
// household-sized shopping list.
// ---------------------------------------------------------------------------

async function writeList(tx: Tx, id: Id, next: SyncState): Promise<void> {
  const meta = next.meta[listKey(id)];
  if (!meta) return;
  const list = next.lists[id];
  if (list) {
    await tx
      .insert(lists)
      .values({
        id: list.id,
        name: list.name,
        icon: list.icon,
        position: list.position,
        categoryOrder: list.categoryOrder,
        deletedAt: null,
        updatedAt: new Date(meta.at),
        updatedBy: meta.by,
      })
      .onConflictDoUpdate({
        target: lists.id,
        set: {
          name: list.name,
          icon: list.icon,
          position: list.position,
          categoryOrder: list.categoryOrder,
          deletedAt: null,
          updatedAt: new Date(meta.at),
          updatedBy: meta.by,
        },
      });
  } else {
    // Tombstoned. Nothing to fabricate for a list we never had a row for, so
    // this only has an effect when the row already exists.
    await tx
      .update(lists)
      .set({ deletedAt: new Date(meta.at), updatedAt: new Date(meta.at), updatedBy: meta.by })
      .where(eq(lists.id, id));
  }
}

async function writeCatalogItem(tx: Tx, id: Id, next: SyncState): Promise<void> {
  const rowMeta = next.meta[catalogKey(id)];
  const item = next.catalog[id];
  // Missing item with a meta entry means update_catalog_item targeted a row
  // we don't have — the reducer no-ops that too (see reducer.ts), so there is
  // nothing to write.
  if (!rowMeta || !item) return;

  const fieldMeta = (field: CatalogField): RecordMeta =>
    next.meta[catalogFieldKey(id, field)] ?? rowMeta;
  const clocks = catalogClockColumns(fieldMeta);
  // Derived, never stamped with whichever op arrived last — see latestClock.
  const touched = latestClock([rowMeta, ...CATALOG_FIELDS.map(fieldMeta)]);

  await tx
    .insert(catalogItems)
    .values({
      id: item.id,
      name: item.name,
      nameNorm: item.nameNorm,
      categoryId: item.categoryId,
      iconRef: item.iconRef,
      isCustom: item.isCustom,
      hasAtHome: item.hasAtHome,
      useCount: item.useCount,
      lastUsedAt: item.lastUsedAt ? new Date(item.lastUsedAt) : null,
      updatedAt: new Date(touched.at),
      updatedBy: touched.by,
      ...clocks,
    })
    .onConflictDoUpdate({
      target: catalogItems.id,
      set: {
        name: item.name,
        nameNorm: item.nameNorm,
        categoryId: item.categoryId,
        iconRef: item.iconRef,
        isCustom: item.isCustom,
        hasAtHome: item.hasAtHome,
        // `useCount` and `lastUsedAt` are deliberately NOT updated here. They
        // are maintained by the purchase side effects with an atomic
        // `use_count + 1`, and writing an absolute value loaded earlier in this
        // transaction would clobber a concurrent increment — a lost update, not
        // a conflict, so last-write-wins cannot save it. The reducer already
        // refuses to take them from a patch; this is the other half.
        updatedAt: new Date(touched.at),
        updatedBy: touched.by,
        ...clocks,
      },
    });
}

async function writeEntry(tx: Tx, id: Id, next: SyncState): Promise<void> {
  const entry = next.entries[id];
  if (!entry) return;
  // Written only when the reducer actually holds a priority clock. Stamping one
  // unconditionally would turn every ordinary add and removal into a claim about
  // when the priority was last set, which is the moving-clock bug this codebase
  // has now paid for twice.
  const priorityMeta = next.meta[entryPriorityKey(id)];
  const priorityColumns = priorityMeta
    ? {
        priorityUpdatedAt: new Date(priorityMeta.at),
        priorityUpdatedBy: priorityMeta.by,
      }
    : {};
  // NOTE: this insert can violate the catalog_item_id foreign key if the op
  // references a catalog item this server has never heard of (e.g. a
  // create_catalog_item op for it hasn't arrived yet). The reducer is
  // deliberately permissive about that in memory — "referential integrity is
  // the UI's problem" — but Postgres is not. That is intentional: within one
  // POST /api/ops batch, ops are applied strictly in the client's own order
  // (see routes/ops.ts), so a create-then-add-to-list batch always commits
  // the catalog item first. A genuinely out-of-order arrival across two
  // separate requests throws here, and the route reports that one op as a
  // per-op failure rather than silently dropping or corrupting state.
  await tx
    .insert(listEntries)
    .values({
      id: entry.id,
      listId: entry.listId,
      catalogItemId: entry.catalogItemId,
      createdAt: new Date(entry.createdAt),
      createdBy: entry.createdBy,
      removedAt: entry.removedAt ? new Date(entry.removedAt) : null,
      priority: entry.priority,
      ...priorityColumns,
      updatedAt: new Date(entry.updatedAt),
      updatedBy: entry.updatedBy,
    })
    .onConflictDoUpdate({
      target: listEntries.id,
      set: {
        createdAt: new Date(entry.createdAt),
        createdBy: entry.createdBy,
        removedAt: entry.removedAt ? new Date(entry.removedAt) : null,
        priority: entry.priority,
        ...priorityColumns,
        updatedAt: new Date(entry.updatedAt),
        updatedBy: entry.updatedBy,
      },
    });
}

/**
 * Write one field's worth of a manual contribution.
 *
 * `field` is the one field the current op (set_amount or set_note) targets, and
 * an UPDATE only ever moves that field's clock — a set_amount has nothing true
 * to say about when the note was last written. An INSERT supplies both, because
 * a brand-new row genuinely establishes both facts at once ("and the note has
 * been empty since then").
 *
 * The other field's clock comes from the reducer's meta rather than being left
 * out. Leaving it out is what made these columns nullable, and a NULL fell back
 * to the row clock at read time — which moves on every write to either field, so
 * writing the amount silently advanced the note's clock and a genuinely older
 * note write lost a comparison it should have won. In one arrival order only, so
 * two devices ended up with different notes and neither was wrong by its own
 * reckoning. Reproduced by execution; see drizzle/0003.
 */
async function writeManualContribution(
  tx: Tx,
  entryId: Id,
  field: ManualField,
  next: SyncState,
): Promise<void> {
  const cid = manualContributionId(entryId);
  const meta = next.meta[contributionFieldKey(cid, field)];
  if (!meta) return;

  /**
   * Both fields cleared. The RECORD goes — the reducer holds none, so keeping
   * one here would put the server out of step with every client — but the ROW
   * stays, emptied, because the row is where the per-field clocks live.
   *
   * Deleting it was a real divergence bug, and a quiet one. A missing clock is
   * not "no opinion", it is "anything wins": `wins(op, undefined)` returns true
   * whatever the op's timestamp says. So clearing an amount here at T3 and a
   * stale `set_amount` from T2 arriving afterwards left the server with the
   * amount restored and the clearing device without it — and neither would ever
   * budge, because each was applying last-write-wins correctly against the facts
   * it had. Two shopping lists, permanently disagreeing about how much milk,
   * with no error anywhere.
   */
  const contribution = next.contributions[cid] ?? {
    id: cid,
    entryId,
    sourceKind: "manual" as const,
    recipeAdditionId: null,
    amount: null,
    note: null,
    modifier: null,
  };

  /**
   * Only the targeted field's clock is written — on INSERT as well as on UPDATE.
   *
   * The tempting shortcut is to stamp both on insert, since the row is new. It
   * is wrong, and subtly: a `set_amount` at 05:00 creating the row would be
   * asserting "and the note has been empty since 05:00", which the op never
   * said. A note genuinely written at 03:00 then loses — but only in that
   * arrival order, so the two devices settle on different notes. The other
   * column stays NULL, meaning "nobody has written this", which is exactly what
   * the reducer holds and what makes any later write land.
   */
  const fieldColumns =
    field === "amount"
      ? { amountUpdatedAt: new Date(meta.at), amountUpdatedBy: meta.by }
      : field === "note"
        ? { noteUpdatedAt: new Date(meta.at), noteUpdatedBy: meta.by }
        : { modifierUpdatedAt: new Date(meta.at), modifierUpdatedBy: meta.by };

  // "Last touched, either field" — informational, and the only clock recipe and
  // scan contributions have. This call IS the most recent touch by construction.
  const touched = { at: new Date(meta.at), by: meta.by };

  await tx
    .insert(contributions)
    .values({
      id: cid,
      entryId,
      sourceKind: "manual",
      recipeAdditionId: null,
      amountValue: contribution.amount?.value ?? null,
      amountUnit: contribution.amount?.unit ?? null,
      note: contribution.note,
      modifier: contribution.modifier,
      updatedAt: touched.at,
      updatedBy: touched.by,
      ...fieldColumns,
    })
    .onConflictDoUpdate({
      target: contributions.id,
      set: {
        amountValue: contribution.amount?.value ?? null,
        amountUnit: contribution.amount?.unit ?? null,
        note: contribution.note,
        modifier: contribution.modifier,
        updatedAt: touched.at,
        updatedBy: touched.by,
        ...fieldColumns,
      },
    });
}

async function writeContribution(tx: Tx, id: Id, next: SyncState): Promise<void> {
  const meta = next.meta[contributionKey(id)];
  if (!meta) return;
  const c = next.contributions[id];
  if (!c) {
    await tx.delete(contributions).where(eq(contributions.id, id));
    return;
  }
  // Recipe and scan contributions are written whole by a single op and resolve
  // on the ROW-level key, so the per-field clock columns stay NULL for them —
  // nothing has written those fields independently, and saying otherwise would
  // be inventing a history. Their ids are disjoint from manual ones
  // (`recipeContributionId` vs `manualContributionId`), so the two clocking
  // schemes never meet on one row.
  await tx
    .insert(contributions)
    .values({
      id: c.id,
      entryId: c.entryId,
      sourceKind: c.sourceKind,
      recipeAdditionId: c.recipeAdditionId,
      amountValue: c.amount?.value ?? null,
      amountUnit: c.amount?.unit ?? null,
      note: c.note,
      updatedAt: new Date(meta.at),
      updatedBy: meta.by,
    })
    .onConflictDoUpdate({
      target: contributions.id,
      set: {
        amountValue: c.amount?.value ?? null,
        amountUnit: c.amount?.unit ?? null,
        note: c.note,
        updatedAt: new Date(meta.at),
        updatedBy: meta.by,
      },
    });
}

async function writeAddition(tx: Tx, id: Id, next: SyncState): Promise<void> {
  const meta = next.meta[additionKey(id)];
  if (!meta) return;
  const addition = next.recipeAdditions[id];
  if (addition) {
    await tx
      .insert(recipeAdditions)
      .values({
        id: addition.id,
        listId: addition.listId,
        recipeId: addition.recipeId,
        scaleFactor: addition.scaleFactor,
        addedAt: new Date(addition.addedAt),
        addedBy: addition.addedBy,
        removedAt: null,
        updatedAt: new Date(meta.at),
        updatedBy: meta.by,
      })
      .onConflictDoUpdate({
        target: recipeAdditions.id,
        set: {
          scaleFactor: addition.scaleFactor,
          removedAt: null,
          updatedAt: new Date(meta.at),
          updatedBy: meta.by,
        },
      });
  } else {
    await tx
      .update(recipeAdditions)
      .set({ removedAt: new Date(meta.at), updatedAt: new Date(meta.at), updatedBy: meta.by })
      .where(eq(recipeAdditions.id, id));
  }
}

async function persist(tx: Tx, next: SyncState, scope: Scope): Promise<void> {
  for (const id of scope.listIds) await writeList(tx, id, next);
  for (const id of scope.catalogIds) await writeCatalogItem(tx, id, next);
  for (const id of scope.entryIds) await writeEntry(tx, id, next);
  if (scope.manualContributionField) {
    const { entryId, field } = scope.manualContributionField;
    await writeManualContribution(tx, entryId, field, next);
  }
  for (const id of scope.contributionIds) await writeContribution(tx, id, next);
  for (const id of scope.additionIds) await writeAddition(tx, id, next);
}

/**
 * Did THIS op win the last-write-wins comparison for the given meta key?
 * `applyOp` sets meta to exactly `{at: op.at, by: op.actor}` when an op wins,
 * so comparing against that tells us whether the op actually took effect —
 * as opposed to losing to a newer write already on the server.
 */
function wonThisOp(next: SyncState, key: string, op: Op): boolean {
  const meta = next.meta[key];
  return meta !== undefined && meta.at === op.at && meta.by === op.actor;
}

/**
 * The one place purchase history is written. Only a `remove_item` with
 * `bought: true` that ACTUALLY WON writes anything: `bought: false` must
 * write nothing (a change of mind must not teach the cadence engine a lie),
 * and a removal that LOST to a newer write never really happened, so
 * recording a purchase for it would be a lie of a different kind — e.g. a
 * stale offline "bought the milk" arriving after someone else already
 * re-added milk with a newer timestamp must not count as a purchase.
 */
async function recordPurchaseIfBought(tx: Tx, op: Op, next: SyncState): Promise<void> {
  if (op.kind !== "remove_item" || !op.bought) return;
  const eid = makeEntryId(op.listId, op.catalogItemId);
  if (!wonThisOp(next, entryKey(eid), op)) return;

  await tx
    .insert(purchases)
    .values({
      id: randomUUID(),
      catalogItemId: op.catalogItemId,
      listId: op.listId,
      purchasedAt: new Date(op.at),
      actor: op.actor,
      clientOpId: op.clientOpId,
    })
    // A replayed op must not count as a second shop. The op log is already
    // idempotent per clientOpId; this makes the purchase row idempotent on the
    // same key, one layer down, so the two can never disagree.
    .onConflictDoNothing({ target: purchases.clientOpId });

  await tx
    .update(catalogItems)
    .set({ useCount: sql`${catalogItems.useCount} + 1`, lastUsedAt: new Date(op.at) })
    .where(eq(catalogItems.id, op.catalogItemId));
}

/**
 * Undo, on the history side.
 *
 * The other half of "Ångra". Putting the item back on the list is the visible
 * half and the client does it locally; this is the half nobody could see, and
 * without it every mis-tap left a permanent purchase behind. Since purchase
 * history is the only input to the cadence engine, and soon to the statistics
 * and the "probably still in the fridge" rule, a purchase the user explicitly
 * retracted is not a small inaccuracy — it is the app confidently telling you
 * something you already told it was wrong.
 *
 * Idempotent by key, so a replayed undo deletes nothing the second time.
 */
async function retractPurchaseIfUndo(tx: Tx, op: Op): Promise<void> {
  if (op.kind !== "add_item" || !op.undoesClientOpId) return;

  const [removed] = await tx
    .delete(purchases)
    .where(eq(purchases.clientOpId, op.undoesClientOpId))
    .returning({ catalogItemId: purchases.catalogItemId });

  // Nothing to undo: the purchase was never written (a `bought: false` removal,
  // or one that lost its LWW comparison), or this undo already applied.
  if (!removed) return;

  // `lastUsedAt` is recomputed from what is left rather than simply cleared.
  // Clearing it would erase a genuine earlier purchase, and leaving it would let
  // the retracted timestamp go on standing in for one — either way the catalog's
  // recency ordering, and later the fridge inference, would read a date that no
  // purchase row supports.
  const [latest] = await tx
    .select({ purchasedAt: purchases.purchasedAt })
    .from(purchases)
    .where(eq(purchases.catalogItemId, removed.catalogItemId))
    .orderBy(desc(purchases.purchasedAt))
    .limit(1);

  await tx
    .update(catalogItems)
    .set({
      useCount: sql`greatest(${catalogItems.useCount} - 1, 0)`,
      lastUsedAt: latest?.purchasedAt ?? null,
    })
    .where(eq(catalogItems.id, removed.catalogItemId));
}

// ---------------------------------------------------------------------------
// Live fan-out
//
// A single container serves this app, so an in-process EventEmitter is the
// right tool — Postgres LISTEN/NOTIFY would be solving a multi-instance
// problem this deployment doesn't have. `listId` is null for household-wide
// catalog ops, which every list's stream must still receive.
// ---------------------------------------------------------------------------

export interface OpAppliedEvent {
  listId: Id | null;
  seq: number;
  op: Op;
}

// Cached on globalThis for the same reason src/db/index.ts caches its pool:
// Next's dev server reloads this module on every edit, and a fresh
// EventEmitter each time would silently drop every open SSE connection's
// listener on save.
const globalForEvents = globalThis as unknown as { recipusOpEvents?: EventEmitter };
export const opEvents = globalForEvents.recipusOpEvents ?? new EventEmitter();
if (process.env.NODE_ENV !== "production") globalForEvents.recipusOpEvents = opEvents;
// Every open SSE connection adds one listener; a household has a handful of
// devices, not thousands, so there is no real cap to enforce here.
opEvents.setMaxListeners(0);

/**
 * Apply one client op, using the SAME reducer the client uses.
 *
 * Flow, inside a single transaction:
 *  1. `client_op_id` already logged → return its seq without re-applying
 *     (idempotent retry). Checked INSIDE the transaction, not before it, so a
 *     genuinely concurrent retry of the same clientOpId can't both pass the
 *     check before either commits (the loser hits the table's unique
 *     constraint and the whole transaction rolls back cleanly instead of
 *     double-applying).
 *  2. Load the affected SyncState slice.
 *  3. Run the shared reducer.
 *  4. Persist whatever changed (and the purchases side effect).
 *  5. Append to the catch-up log and return the new seq.
 *
 * `actor` is the AUTHENTICATED caller (from src/lib/auth.ts), not whatever the
 * op's own `actor` field says. The op's `actor` is client-supplied and reused
 * for display/attribution once trusted, but trusting it directly here would
 * let one household member's client silently attribute a change to somebody
 * else — so the authenticated identity always overrides it before anything is
 * applied or logged.
 */
export async function applyOpToDatabase(
  op: Op,
  actor: string,
): Promise<{ seq: number }> {
  const safeOp: Op = { ...op, actor };

  const result = await db.transaction(async (tx) => {
    const [existingRow] = await tx
      .select({ seq: opsTable.seq })
      .from(opsTable)
      .where(eq(opsTable.clientOpId, safeOp.clientOpId))
      .limit(1);
    if (existingRow) return { seq: existingRow.seq, applied: false as const };

    const { state: prev, scope } = await loadStateSlice(tx, safeOp);
    const next = applyOp(prev, safeOp);

    await persist(tx, next, scope);
    await recordPurchaseIfBought(tx, safeOp, next);
    await retractPurchaseIfUndo(tx, safeOp);

    const [inserted] = await tx
      .insert(opsTable)
      .values({
        clientOpId: safeOp.clientOpId,
        listId: opListId(safeOp),
        actor: safeOp.actor,
        kind: safeOp.kind,
        payload: safeOp,
        at: new Date(safeOp.at),
      })
      .returning({ seq: opsTable.seq });

    return { seq: inserted.seq, applied: true as const };
  });

  // Fired only for a genuinely new application, never for an idempotent
  // replay — and only after the transaction has committed, never before, so a
  // listener can never observe an op that then rolls back.
  if (result.applied) {
    const event: OpAppliedEvent = {
      listId: opListId(safeOp),
      seq: result.seq,
      op: safeOp,
    };
    opEvents.emit("op", event);
  }

  return { seq: result.seq };
}
