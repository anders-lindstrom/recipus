import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  barcodes,
  catalogItemAliases,
  catalogItems,
  contributions,
  listEntries,
  lists,
  ops as opsTable,
  products,
  purchases,
  recipeAdditions,
  recipeIngredients,
} from "@/db/schema";
import {
  emptyState,
  entryId as makeEntryId,
  isClearedManualContribution,
  manualContributionId,
  recipeContributionId,
  type Amount,
  type BarcodeSource,
  type Contribution,
  type Id,
  type RecordMeta,
  type SyncState,
  type Unit,
} from "@/lib/domain";
import {
  additionKey,
  aliasKey,
  applyOp,
  barcodeKey,
  catalogFieldKey,
  catalogKey,
  contributionFieldKey,
  contributionKey,
  entryKey,
  entryPriorityKey,
  listKey,
  opListId,
  productFieldKey,
  productKey,
  CATALOG_FIELDS,
  MANUAL_FIELDS,
  PRODUCT_FIELDS,
  type CatalogField,
  type ManualField,
  type Op,
  type ProductField,
} from "@/lib/sync";
import { mergeAmounts } from "@/lib/units";
import {
  catalogClockColumns,
  catalogFieldClocks,
  latestClock,
  productClockColumns,
  productFieldClocks,
} from "./clocks";
import {
  effectiveCatalogItemId,
  purchaseProductJoin,
} from "./purchase-attribution";

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
   * Which manual contribution fields this op can write, as (entry, field) pairs.
   *
   * set_amount/set_note/set_modifier each contribute exactly one pair. move_item
   * contributes six — two entries, three fields each — because the manual
   * contribution travels with the item and both ends have to be written: the
   * destination gains the values, and the source is emptied while keeping the
   * row, since the row is where its clocks live.
   */
  manualContributionFields: Array<{ entryId: Id; field: ManualField }>;
  contributionIds: Set<Id>;
  additionIds: Set<Id>;
  productIds: Set<Id>;
  /** Keyed by the normalized word, which is the alias's whole identity. */
  aliasNorms: Set<string>;
  eans: Set<string>;
}

function emptyScope(): Scope {
  return {
    listIds: new Set(),
    catalogIds: new Set(),
    entryIds: new Set(),
    manualContributionFields: [],
    contributionIds: new Set(),
    additionIds: new Set(),
    productIds: new Set(),
    aliasNorms: new Set(),
    eans: new Set(),
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
      scope.manualContributionFields.push({
        entryId: eid,
        field:
          op.kind === "set_amount"
            ? "amount"
            : op.kind === "set_note"
              ? "note"
              : "modifier",
      });
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
    // Both shares and both entries. The addition itself is deliberately absent:
    // this op changes what a recipe asks for, never whether the recipe is on the
    // list, so loading the addition row would only invite a write to it.
    case "repoint_recipe_item":
      for (const itemId of [op.fromCatalogItemId, op.toCatalogItemId]) {
        scope.entryIds.add(makeEntryId(op.listId, itemId));
        scope.contributionIds.add(
          recipeContributionId(op.recipeAdditionId, itemId),
        );
      }
      break;
    case "move_item": {
      const from = makeEntryId(op.fromListId, op.catalogItemId);
      const to = makeEntryId(op.toListId, op.catalogItemId);
      scope.entryIds.add(from);
      scope.entryIds.add(to);
      // Both rows and all three fields of each, whether or not this particular
      // op carries a manual contribution. The scope's job is to cover everything
      // the reducer COULD write; narrowing it on the op's payload would silently
      // stop covering the reducer the day the reducer changes, and only on the
      // server — the half nobody looks at, because the client would still be
      // right and the two would just quietly disagree.
      //
      // Loading a row the reducer then leaves alone costs an UPSERT of unchanged
      // values, which this file already accepts everywhere else.
      for (const eid of [from, to]) {
        for (const field of MANUAL_FIELDS) {
          scope.manualContributionFields.push({ entryId: eid, field });
        }
      }
      // Recipe contributions are deliberately NOT in scope: they stay on the
      // list their addition belongs to. See the op's own comment in sync/ops.ts.
      break;
    }
    case "create_product":
      scope.productIds.add(op.product.id);
      break;
    case "update_product":
      scope.productIds.add(op.productId);
      break;
    // Only the barcode row. The product it points at is neither read nor written
    // by the reducer — that is what makes two phones linking two EANs to one
    // product a non-conflict rather than a merge nobody can perform.
    case "link_barcode":
      scope.eans.add(op.ean);
      break;
    case "delete_catalog_item":
      scope.catalogIds.add(op.itemId);
      break;
    case "merge_catalog_items":
      // The merged-away vara and the alias, and deliberately nothing else. The
      // surviving vara is never written, and entries and contributions are never
      // touched at all — see the reducer's own comment on this op for why that
      // restraint is what makes a merge converge.
      scope.catalogIds.add(op.fromItemId);
      scope.aliasNorms.add(op.aliasNorm);
      break;
  }

  const state = emptyState();

  // Deduplicated: move_item names three fields per row, and they all live on the
  // one row.
  const manualIds = [
    ...new Set(
      scope.manualContributionFields.map((f) => manualContributionId(f.entryId)),
    ),
  ];

  const [
    listRows,
    catalogRows,
    entryRows,
    deleteListEntryRows,
    manualContribRows,
    recipeContribRows,
    additionRows,
    removeRecipeContribRows,
    productRows,
    aliasRows,
    barcodeRows,
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
    manualIds.length
      ? tx.select().from(contributions).where(inArray(contributions.id, manualIds))
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
    scope.productIds.size
      ? tx.select().from(products).where(inArray(products.id, [...scope.productIds]))
      : Promise.resolve([]),
    scope.aliasNorms.size
      ? tx
          .select()
          .from(catalogItemAliases)
          .where(
            inArray(catalogItemAliases.aliasNorm, [...scope.aliasNorms]),
          )
      : Promise.resolve([]),
    scope.eans.size
      ? tx.select().from(barcodes).where(inArray(barcodes.ean, [...scope.eans]))
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
    // Tombstoned by `delete_catalog_item` or by the losing half of a merge. The
    // CLOCK still travels — a missing clock is not "no opinion", it is "anything
    // wins" — but the record does not, or the reducer would be handed a vara the
    // client, running the same ops, does not have. `update_catalog_item` then
    // no-ops on it here exactly as it does there.
    const deleted = row.deletedAt !== null;
    state.meta[catalogKey(row.id)] = {
      at: row.updatedAt.toISOString(),
      by: row.updatedBy,
      deleted: deleted ? true : undefined,
    };
    // Four independent clocks, read straight from their own columns. No
    // fallback to the row clock: that clock moves whenever ANY field is
    // written, so a field that fell back to it would silently inherit an
    // unrelated write's timestamp and start beating ops it should lose to.
    //
    // Emitted for a tombstoned row too: the field clocks outlive the record for
    // the same reason the record clock does, and a resurrecting create must lose
    // to a rename that genuinely came after it.
    for (const [field, clock] of catalogFieldClocks(row)) {
      state.meta[catalogFieldKey(row.id, field)] = clock;
    }
    if (deleted) continue;
    state.catalog[row.id] = {
      id: row.id,
      name: row.name,
      nameNorm: row.nameNorm,
      categoryId: row.categoryId,
      iconRef: row.iconRef,
      isCustom: row.isCustom,
      hasAtHome: row.hasAtHome,
      hidden: row.hidden,
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

  for (const row of productRows) {
    const deleted = row.deletedAt !== null;
    state.meta[productKey(row.id)] = {
      at: row.updatedAt.toISOString(),
      by: row.updatedBy,
      deleted: deleted ? true : undefined,
    };
    // Each from its OWN column, and a NULL column emits nothing at all. See
    // productFieldClocks: NULL means "no op has ever written this field", which
    // is the state a product born from Open Food Facts is genuinely in.
    for (const [field, clock] of productFieldClocks(row)) {
      state.meta[productFieldKey(row.id, field)] = clock;
    }
    if (deleted) continue;
    state.products[row.id] = {
      id: row.id,
      name: row.name,
      brand: row.brand,
      catalogItemId: row.catalogItemId,
      defaultSize: toAmount(row.defaultSizeValue, row.defaultSizeUnit),
      sourceSizeText: row.sourceSizeText,
      imageUrl: row.imageUrl,
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy,
    };
  }

  for (const row of aliasRows) {
    const deleted = row.deletedAt !== null;
    state.meta[aliasKey(row.aliasNorm)] = {
      at: row.updatedAt.toISOString(),
      by: row.updatedBy,
      deleted: deleted ? true : undefined,
    };
    if (deleted) continue;
    state.aliases[row.aliasNorm] = {
      aliasNorm: row.aliasNorm,
      catalogItemId: row.catalogItemId,
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy,
    };
  }

  for (const row of barcodeRows) {
    const deleted = row.deletedAt !== null;
    state.meta[barcodeKey(row.ean)] = {
      at: row.updatedAt.toISOString(),
      by: row.updatedBy,
      deleted: deleted ? true : undefined,
    };
    if (deleted) continue;
    // One editable fact — which product this EAN points at — so the record-level
    // clock IS that fact's clock and there is nothing for a field clock to
    // disambiguate.
    state.barcodes[row.ean] = {
      ean: row.ean,
      productId: row.productId,
      source: row.source as BarcodeSource,
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
  if (!rowMeta) return;
  const item = next.catalog[id];
  if (!item) {
    /**
     * Retired by `delete_catalog_item`, or the losing half of a merge.
     *
     * Only when the clock says so. A meta entry with no record and no tombstone
     * means `update_catalog_item` targeted a row this server does not have — the
     * reducer no-ops that too, so there is nothing to write.
     *
     * The four field clocks are deliberately NOT touched. Existence is not a
     * field of the row, it is the record itself, and it already has the
     * record-level clock; giving it a field clock as well would be the second
     * clock for one fact that this codebase has paid for three times.
     */
    if (!rowMeta.deleted) return;
    await tx
      .update(catalogItems)
      .set({
        deletedAt: new Date(rowMeta.at),
        updatedAt: new Date(rowMeta.at),
        updatedBy: rowMeta.by,
      })
      .where(eq(catalogItems.id, id));
    return;
  }

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
      hidden: item.hidden,
      useCount: item.useCount,
      lastUsedAt: item.lastUsedAt ? new Date(item.lastUsedAt) : null,
      deletedAt: null,
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
        hidden: item.hidden,
        // Cleared, so a `create_catalog_item` newer than the retirement actually
        // brings the vara back rather than writing its fields into a row that
        // stays invisible. Soft deletes are only reversible if something reverses
        // them.
        deletedAt: null,
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

/**
 * A product, with its four clocks in their own four column pairs.
 *
 * The clocks are NULLABLE here and NOT NULL for a vara, and preserving that is
 * the whole care in this function: a product born from Open Food Facts has
 * genuinely never had its mapping asserted by anyone, and a clock invented for it
 * would put the machine's guess ahead of the human correction the review queue
 * exists to collect. `productClockColumns` writes NULL for a field the reducer
 * holds no clock for; nothing falls back to `updated_at`.
 */
async function writeProduct(tx: Tx, id: Id, next: SyncState): Promise<void> {
  const rowMeta = next.meta[productKey(id)];
  const product = next.products[id];
  // A record with no meta cannot happen; meta with no record means either an
  // `update_product` for a product this server has never seen (the reducer
  // no-ops that too) or a tombstone, which is already in the column.
  if (!rowMeta || !product) return;

  const fieldMeta = (field: ProductField): RecordMeta | undefined =>
    next.meta[productFieldKey(id, field)];
  const clocks = productClockColumns(fieldMeta);
  // Derived from whatever clocks exist, never stamped with whichever op arrived
  // last — see latestClock. The row clock is not a conflict input for any field
  // on this row; it exists so the tombstone has a timestamp and so /varor can
  // order by recency.
  const touched = latestClock([
    rowMeta,
    ...PRODUCT_FIELDS.map(fieldMeta).filter((m) => m !== undefined),
  ]);

  await tx
    .insert(products)
    .values({
      id: product.id,
      name: product.name,
      brand: product.brand,
      catalogItemId: product.catalogItemId,
      defaultSizeValue: product.defaultSize?.value ?? null,
      defaultSizeUnit: product.defaultSize?.unit ?? null,
      sourceSizeText: product.sourceSizeText,
      imageUrl: product.imageUrl,
      // Earliest-wins, resolved by the reducer (`earliestCreation`) rather than
      // here, because two offline phones scanning one unknown EAN both author a
      // create for the same derived id and only one creation can be recorded.
      // Written on conflict too: a losing create still lowers this.
      createdAt: new Date(product.createdAt),
      createdBy: product.createdBy,
      deletedAt: null,
      updatedAt: new Date(touched.at),
      updatedBy: touched.by,
      ...clocks,
    })
    .onConflictDoUpdate({
      target: products.id,
      set: {
        name: product.name,
        brand: product.brand,
        catalogItemId: product.catalogItemId,
        defaultSizeValue: product.defaultSize?.value ?? null,
        defaultSizeUnit: product.defaultSize?.unit ?? null,
        sourceSizeText: product.sourceSizeText,
        imageUrl: product.imageUrl,
        createdAt: new Date(product.createdAt),
        createdBy: product.createdBy,
        deletedAt: null,
        updatedAt: new Date(touched.at),
        updatedBy: touched.by,
        ...clocks,
      },
    });
}

/**
 * The merged-away word, kept so old recipe lines go on resolving.
 *
 * `createdAt`/`createdBy` come from the reducer's own record rather than from
 * this call, so they are the WINNING merge's stamp in either arrival order — the
 * same shape as the barcode pointer below, which the schema deliberately models
 * on this one.
 */
async function writeAlias(tx: Tx, aliasNorm: string, next: SyncState): Promise<void> {
  const meta = next.meta[aliasKey(aliasNorm)];
  const alias = next.aliases[aliasNorm];
  if (!meta || !alias) return;

  await tx
    .insert(catalogItemAliases)
    .values({
      aliasNorm: alias.aliasNorm,
      catalogItemId: alias.catalogItemId,
      createdAt: new Date(alias.createdAt),
      createdBy: alias.createdBy,
      deletedAt: null,
      updatedAt: new Date(meta.at),
      updatedBy: meta.by,
    })
    .onConflictDoUpdate({
      target: catalogItemAliases.aliasNorm,
      set: {
        catalogItemId: alias.catalogItemId,
        createdAt: new Date(alias.createdAt),
        createdBy: alias.createdBy,
        deletedAt: null,
        updatedAt: new Date(meta.at),
        updatedBy: meta.by,
      },
    });
}

/**
 * One EAN, pointing at a product.
 *
 * `BarcodeLink` carries no creation info — the reducer has no use for it — so
 * these columns are stamped from the record-level clock, which is the winning
 * op's and therefore the same in either arrival order. Taking them from whichever
 * write happened to insert the row first would make them depend on delivery
 * order, which is the one property nothing in this file is allowed to have.
 */
async function writeBarcode(tx: Tx, ean: string, next: SyncState): Promise<void> {
  const meta = next.meta[barcodeKey(ean)];
  const link = next.barcodes[ean];
  if (!meta || !link) return;
  const at = new Date(meta.at);

  await tx
    .insert(barcodes)
    .values({
      ean: link.ean,
      productId: link.productId,
      source: link.source,
      createdAt: at,
      createdBy: meta.by,
      deletedAt: null,
      updatedAt: at,
      updatedBy: meta.by,
    })
    .onConflictDoUpdate({
      target: barcodes.ean,
      set: {
        productId: link.productId,
        source: link.source,
        createdAt: at,
        createdBy: meta.by,
        deletedAt: null,
        updatedAt: at,
        updatedBy: meta.by,
      },
    });
}

async function persist(tx: Tx, next: SyncState, scope: Scope): Promise<void> {
  for (const id of scope.listIds) await writeList(tx, id, next);
  for (const id of scope.catalogIds) await writeCatalogItem(tx, id, next);
  for (const id of scope.entryIds) await writeEntry(tx, id, next);
  for (const { entryId, field } of scope.manualContributionFields) {
    await writeManualContribution(tx, entryId, field, next);
  }
  for (const id of scope.contributionIds) await writeContribution(tx, id, next);
  for (const id of scope.additionIds) await writeAddition(tx, id, next);
  for (const id of scope.productIds) await writeProduct(tx, id, next);
  for (const aliasNorm of scope.aliasNorms) await writeAlias(tx, aliasNorm, next);
  for (const ean of scope.eans) await writeBarcode(tx, ean, next);
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
/**
 * How much was bought, read at the only moment it exists.
 *
 * `purchases.quantity_value`/`quantity_unit` are the one thing on that table
 * that cannot be added later — the row records a moment in a shop, and no
 * amount of future code can reconstruct how many litres of milk went into a
 * basket in March. The columns were declared for exactly that reason and then
 * never written, so every purchase since has recorded that something was bought
 * and not how much.
 *
 * `remove_item` tombstones the entry and leaves its contributions standing, so
 * `next` still carries what the household was asking for at the moment they
 * ticked it off. That is the honest figure: what was on the list when it was
 * bought.
 *
 * Returns null when the entry's asks do not reduce to ONE amount, and that is
 * deliberate rather than lossy. `mergeAmounts` sums within a family and refuses
 * to cross families, so a muffin recipe wanting 3 dl grädde and a manual "2 st"
 * comes back as two amounts — and there is no honest single pair for that. A
 * fabricated one would be worse than a null: it would be the only made-up
 * number on a table whose whole purpose is to be trustworthy about the past.
 *
 * Read from the DATABASE rather than from `next`, and that is not an oversight
 * to tidy up later. `loadStateSlice` deliberately loads no contributions for a
 * `remove_item` — the reducer resolves a removal entirely on the entry row — so
 * `next.contributions` is empty here and always would be. Widening the slice to
 * suit this would change what the reducer sees and what `persist` then rewrites,
 * to serve a side effect; this function already sits on the side-effect
 * boundary, next to the `use_count` bump, which does its own query for exactly
 * the same reason.
 */
async function purchasedQuantity(tx: Tx, entryId: Id): Promise<Amount | null> {
  const rows = await tx
    .select({ value: contributions.amountValue, unit: contributions.amountUnit })
    .from(contributions)
    .where(eq(contributions.entryId, entryId));

  const amounts = mergeAmounts(
    rows.map((r) =>
      r.value !== null && r.unit !== null
        ? ({ value: r.value, unit: r.unit as Amount["unit"] } as Amount)
        : null,
    ),
  );
  return amounts.length === 1 ? amounts[0]! : null;
}

async function recordPurchaseIfBought(tx: Tx, op: Op, next: SyncState): Promise<void> {
  if (op.kind !== "remove_item" || !op.bought) return;
  const eid = makeEntryId(op.listId, op.catalogItemId);
  if (!wonThisOp(next, entryKey(eid), op)) return;

  const quantity = await purchasedQuantity(tx, eid);

  await tx
    .insert(purchases)
    .values({
      id: randomUUID(),
      /*
       * Two shapes, exactly as the table has always documented: a tapped tile
       * writes {item, null}, and a scan writes {null, product}.
       *
       * Not denormalising the vara onto a scan-sourced purchase is the whole
       * point rather than an economy. The vara is read back through
       * COALESCE(purchases.catalog_item_id, products.catalog_item_id), so
       * placing an unplaced product retro-attributes its entire history for
       * free instead of needing a migration, and correcting a wrong auto-map
       * moves every past purchase with it. We know what we scanned; we do not
       * know what we tapped, which is why a tile tap stays put and is never
       * divided by a split.
       */
      catalogItemId: op.productId ? null : op.catalogItemId,
      productId: op.productId ?? null,
      listId: op.listId,
      purchasedAt: new Date(op.at),
      actor: op.actor,
      clientOpId: op.clientOpId,
      quantityValue: quantity?.value ?? null,
      quantityUnit: quantity?.unit ?? null,
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
 * The other half of a merge — the half the reducer must not do.
 *
 * `merge_catalog_items` tombstones the losing vara and records its word as an
 * alias, and NOTHING else, because a merge implemented as row rewriting does not
 * converge: `merge(B→A)` at T5 followed by a long-offline `add_item(B)` at T7
 * ends with an entry for B in one arrival order and for A in the other. So the
 * re-pointing lives here, on the same boundary `recordPurchaseIfBought` sits on,
 * and it is deliberately restricted to rows that carry NO clock of their own:
 *
 *   - `purchases` and `recipe_ingredients` never go through the reducer at all,
 *     so moving them can contradict nothing.
 *   - `catalog_item_aliases` DOES sync, and this moves it anyway — because the
 *     alternative is a chain of merges leaving old words aiming at a vara that no
 *     longer exists, which breaks the one thing the alias is for. The stated
 *     cost: a client holding that alias keeps the old target until it rehydrates.
 *     Bounded and self-repairing, unlike a word that resolves to a tombstone.
 *
 * Entries and contributions are NOT here, and that omission is the design rather
 * than an oversight. Both arrival orders end with the same orphan entry on a
 * tombstoned vara: visible, manually fixable, and above all identical everywhere.
 *
 * Idempotent by construction — every statement is `WHERE catalog_item_id =
 * fromItemId`, which matches nothing on a second run — and gated on the op having
 * actually WON, so a stale merge that lost to a newer one never re-points
 * anything.
 */
async function repointMergedCatalogItem(
  tx: Tx,
  op: Op,
  next: SyncState,
): Promise<void> {
  if (op.kind !== "merge_catalog_items") return;
  if (!wonThisOp(next, catalogKey(op.fromItemId), op)) return;

  // Scan-sourced purchases are deliberately untouched: they carry a product, not
  // a vara, and resolve through it (see purchase-attribution.ts). Moving the
  // product's mapping is a separate, human decision with its own clock.
  await tx
    .update(purchases)
    .set({ catalogItemId: op.toItemId })
    .where(eq(purchases.catalogItemId, op.fromItemId));

  await tx
    .update(recipeIngredients)
    .set({ catalogItemId: op.toItemId })
    .where(eq(recipeIngredients.catalogItemId, op.fromItemId));

  // Aliases that already pointed at the merged-away vara. The alias this op
  // itself creates was written by `persist` above and already names `toItemId`,
  // so it is not matched here.
  await tx
    .update(catalogItemAliases)
    .set({ catalogItemId: op.toItemId })
    .where(eq(catalogItemAliases.catalogItemId, op.fromItemId));
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
/**
 * How long after buying something putting it back still reads as "we did not
 * buy it".
 *
 * Half an hour, and it is a judgement about people rather than a measurement.
 * The gesture this serves is a mis-tap on a 92px tile, one-handed, with a
 * trolley moving — noticed a few taps later, when the tile you wanted is still
 * missing and the one beside it is gone. That is minutes, not hours. Long
 * enough to walk the rest of an aisle and look back; short enough that the
 * weekly shop is over before it can reach the milk you bought on purpose.
 *
 * NOT `modeAfterIdle`'s 90 minutes, though the first attempt reused it. That
 * window answers "are you still in a shop", which is a different and longer
 * question: you can be forty minutes into a shop and genuinely want a second
 * carton. Sharing a constant between two questions is how one of them quietly
 * gets the wrong answer.
 */
const RETRACT_WINDOW_MS = 30 * 60 * 1000;

/**
 * The purchase an ordinary put-it-back takes with it, if there is one.
 *
 * `DECISIONS.md:302` rejected retracting on a re-add because it cannot tell "I
 * mis-tapped" from "I need another one". That objection is still true and is
 * still not answered — nothing can tell them apart. What is chosen here is that
 * the app would rather MISS a purchase than INVENT one, which is the direction
 * `use-mode.ts:20` already commits to, and that inside half an hour the mis-tap
 * reading is overwhelmingly the likelier of the two.
 *
 * The cost is real and worth stating: buy bananas, decide within the half hour
 * that you want more, put them back on the list, and that purchase is gone from
 * the history. Same for a recipe added on the way home that happens to want
 * something you just bought.
 *
 * Two conditions, and only two:
 *
 * 1. **The vara had actually left the list.** Without this, `add_item` is fired
 *    by things that are not re-adds at all — setting an amount through the
 *    duplicate sheet, a recipe topping up a vara that is already there — and
 *    each of them would delete a genuine purchase for an item that never went
 *    anywhere. This is what makes "add" mean "add BACK".
 * 2. **A purchase of it inside the window**, on this list, most recent first.
 *
 * Deliberately NOT conditioned on who, or on which device. The household shops
 * as one: a phone in the shop and a phone at home are the same trip, and asking
 * "did YOU record it" would mean the partner putting the bananas back could not
 * fix the mis-tap they can plainly see. That is also why this is resolved here
 * rather than from a token the buying device kept — the server is the only place
 * that knows about a purchase both phones can see.
 */
async function recentPurchaseToRetract(
  tx: Tx,
  op: Extract<Op, { kind: "add_item" }>,
  prev: SyncState,
): Promise<string | undefined> {
  if (op.keepsPurchase) return undefined;

  const entry = prev.entries[makeEntryId(op.listId, op.catalogItemId)];
  if (!entry || entry.removedAt === null) return undefined;

  // Through the same resolution the rest of the app reads purchases by, so a
  // scan of a placed product is found here exactly as a tapped tile is.
  const [recent] = await tx
    .select({ clientOpId: purchases.clientOpId })
    .from(purchases)
    .leftJoin(products, purchaseProductJoin)
    .where(
      and(
        eq(purchases.listId, op.listId),
        eq(effectiveCatalogItemId, op.catalogItemId),
        gt(
          purchases.purchasedAt,
          new Date(new Date(op.at).getTime() - RETRACT_WINDOW_MS),
        ),
      ),
    )
    .orderBy(desc(purchases.purchasedAt))
    .limit(1);

  return recent?.clientOpId;
}

async function retractPurchaseIfUndo(tx: Tx, op: Op, prev: SyncState): Promise<void> {
  if (op.kind !== "add_item") return;

  // The strip names its own removal and always wins: it is the only caller that
  // knows exactly which purchase it is offering to take back, including a
  // `bought: false` removal with no purchase behind it at all.
  const undoes = op.undoesClientOpId ?? (await recentPurchaseToRetract(tx, op, prev));
  if (!undoes) return;

  // Resolved BEFORE the delete rather than from a RETURNING clause, because a
  // scan-sourced purchase keeps its vara on the product and `DELETE` cannot
  // join. Both statements key on the same `clientOpId` inside one transaction,
  // so the idempotency is exactly what it was: a replayed undo finds nothing and
  // does nothing.
  const [removed] = await tx
    .select({ catalogItemId: effectiveCatalogItemId })
    .from(purchases)
    .leftJoin(products, purchaseProductJoin)
    .where(eq(purchases.clientOpId, undoes))
    .limit(1);

  // Nothing to undo: the purchase was never written (a `bought: false` removal,
  // or one that lost its LWW comparison), or this undo already applied.
  if (!removed) return;

  await tx
    .delete(purchases)
    .where(eq(purchases.clientOpId, undoes));

  // A scan of a product nobody has placed on a vara yet. There is no catalog row
  // to correct — `use_count` was never incremented for it, because nothing knew
  // which vara to credit. Retracting the purchase is the half that matters and
  // has already happened.
  if (removed.catalogItemId === null) return;

  // `lastUsedAt` is recomputed from what is left rather than simply cleared.
  // Clearing it would erase a genuine earlier purchase, and leaving it would let
  // the retracted timestamp go on standing in for one — either way the catalog's
  // recency ordering, and later the fridge inference, would read a date that no
  // purchase row supports.
  // Through the same resolution, not `purchases.catalog_item_id` directly. A
  // scan of a placed product is a genuine purchase of this vara, and counting it
  // here but not in the cadence would leave two answers to one question.
  const [latest] = await tx
    .select({ purchasedAt: purchases.purchasedAt })
    .from(purchases)
    .leftJoin(products, purchaseProductJoin)
    .where(eq(effectiveCatalogItemId, removed.catalogItemId))
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
    await retractPurchaseIfUndo(tx, safeOp, prev);
    await repointMergedCatalogItem(tx, safeOp, next);

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
