import {
  emptyState,
  entryId,
  manualContributionId,
  recipeContributionId,
  type Amount,
  type Contribution,
  type Id,
  type ListEntry,
  type RecordMeta,
  type SyncState,
} from "@/lib/domain";
import type { Op } from "./ops";

/**
 * The reducer.
 *
 * `applyOp(state, op)` is total, deterministic and pure, and it runs in two
 * places: in the browser to apply your tap before the network hears about it,
 * and on the server to apply the authoritative version. If those two ever
 * disagree, two phones' shopping lists diverge with no error anywhere.
 *
 * The property that makes this safe is order independence: applying the same
 * set of ops in ANY order must produce an identical state. Two people can be
 * offline in different shops, and their ops arrive interleaved however the
 * network feels like delivering them. Every mutation below is therefore guarded
 * by the same last-write-wins comparison, and deletes leave tombstones rather
 * than holes.
 */

type MetaKey = string;

const listKey = (id: Id): MetaKey => `list:${id}`;
const catalogKey = (id: Id): MetaKey => `catalog:${id}`;
const entryKey = (id: Id): MetaKey => `entry:${id}`;
const contributionKey = (id: Id): MetaKey => `contribution:${id}`;
const additionKey = (id: Id): MetaKey => `addition:${id}`;

/**
 * Does this op supersede what we already have?
 *
 * Ties break on the actor's name — an arbitrary rule, but a *consistent* one,
 * which is the only property that matters. Both sides must pick the same
 * winner, and neither can ask the other.
 */
function wins(op: Op, existing: RecordMeta | undefined): boolean {
  if (!existing) return true;
  if (op.at > existing.at) return true;
  if (op.at < existing.at) return false;
  return op.actor > existing.by;
}

function metaOf(op: Op, deleted = false): RecordMeta {
  return deleted
    ? { at: op.at, by: op.actor, deleted: true }
    : { at: op.at, by: op.actor };
}

/** Shallow clone with one map replaced — keeps untouched sub-objects shared. */
function patch(state: SyncState, changes: Partial<SyncState>): SyncState {
  return { ...state, ...changes };
}

function omit<T>(map: Record<Id, T>, id: Id): Record<Id, T> {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

/**
 * Ensure an entry exists and is not tombstoned.
 *
 * Deliberately permissive about the catalog item existing: ops arrive out of
 * order, so `add_item` can land before the `create_catalog_item` that defines
 * what it refers to. Refusing here would make the final state depend on arrival
 * order, which is exactly the property we are protecting. Referential integrity
 * is the UI's problem — it simply doesn't render an entry it can't name yet.
 */
/**
 * Creation info is a minimum, not a last-write-wins field.
 *
 * This is subtle and it bit me. `add_item` at T1 followed by `add_recipe` at T2
 * leaves createdAt at T1; the reverse order leaves it at T2, because the losing
 * op returns early and never gets to lower it. Same ops, different state — the
 * exact divergence this module has to rule out.
 *
 * So creation is tracked as the earliest add anyone has seen, applied whether or
 * not the op wins the LWW comparison. min() is commutative and associative,
 * which is precisely what order independence needs. Ties break on actor so the
 * two sides agree on who gets the credit.
 */
function earliestCreation(
  a: { at: string; by: string },
  b: { at: string; by: string },
): { at: string; by: string } {
  if (a.at < b.at) return a;
  if (b.at < a.at) return b;
  return a.by <= b.by ? a : b;
}

function writeEntry(
  state: SyncState,
  op: Op,
  listId: Id,
  itemId: Id,
  removed: boolean,
): SyncState {
  const id = entryId(listId, itemId);
  const key = entryKey(id);
  const existing = state.entries[id];

  const creation = existing
    ? earliestCreation(
        { at: existing.createdAt, by: existing.createdBy },
        { at: op.at, by: op.actor },
      )
    : { at: op.at, by: op.actor };

  // The op lost, but its creation timestamp may still be the earliest one seen.
  if (!wins(op, state.meta[key])) {
    if (
      existing &&
      (creation.at !== existing.createdAt || creation.by !== existing.createdBy)
    ) {
      return patch(state, {
        entries: {
          ...state.entries,
          [id]: { ...existing, createdAt: creation.at, createdBy: creation.by },
        },
      });
    }
    return state;
  }

  // Tombstoning something never seen is not an error — the remove may simply
  // have overtaken the add. Recording it makes the add lose when it lands.
  const entry: ListEntry = {
    id,
    listId,
    catalogItemId: itemId,
    createdAt: creation.at,
    createdBy: creation.by,
    removedAt: removed ? op.at : null,
    updatedAt: op.at,
    updatedBy: op.actor,
  };

  return patch(state, {
    entries: { ...state.entries, [id]: entry },
    // Marked deleted exactly when the entry itself is tombstoned, so that
    // pruneTombstones can eventually forget this key too — otherwise the meta
    // map would grow forever, even after the entry it describes is gone.
    meta: { ...state.meta, [key]: metaOf(op, removed) },
  });
}

function upsertEntry(state: SyncState, op: Op, listId: Id, itemId: Id): SyncState {
  return writeEntry(state, op, listId, itemId, false);
}

function tombstoneEntry(state: SyncState, op: Op, listId: Id, itemId: Id): SyncState {
  return writeEntry(state, op, listId, itemId, true);
}

function setContribution(
  state: SyncState,
  op: Op,
  contribution: Contribution,
): SyncState {
  const key = contributionKey(contribution.id);
  if (!wins(op, state.meta[key])) return state;
  return patch(state, {
    contributions: { ...state.contributions, [contribution.id]: contribution },
    meta: { ...state.meta, [key]: metaOf(op) },
  });
}

/**
 * Write one field of the manual contribution.
 *
 * The amount and the note are independent facts that happen to share a record,
 * so they need independent last-write-wins clocks. With a single per-record
 * clock, an older `set_amount` arriving after a newer `set_note` loses the
 * comparison and takes the quantity down with it — you set 5 dl, your partner
 * adds a note, and the 5 dl silently becomes nothing. The exhaustive ordering
 * test found this; nothing else would have.
 */
function setManualField(
  state: SyncState,
  op: Op,
  listId: Id,
  itemId: Id,
  field: "amount" | "note",
  value: Amount | string | null,
): SyncState {
  const eid = entryId(listId, itemId);
  const cid = manualContributionId(eid);
  const key = `${contributionKey(cid)}:${field}`;
  if (!wins(op, state.meta[key])) return state;

  const existing = state.contributions[cid];
  const next: Contribution = {
    id: cid,
    entryId: eid,
    sourceKind: "manual",
    recipeAdditionId: null,
    amount: field === "amount" ? (value as Amount | null) : (existing?.amount ?? null),
    note: field === "note" ? (value as string | null) : (existing?.note ?? null),
  };

  const meta = { ...state.meta, [key]: metaOf(op) };
  // Nothing left to say about the item — but the entry itself stays, because
  // "bread, amount unspecified" is a perfectly good thing to want.
  if (next.amount === null && next.note === null) {
    return patch(state, {
      contributions: omit(state.contributions, cid),
      meta,
    });
  }
  return patch(state, {
    contributions: { ...state.contributions, [cid]: next },
    meta,
  });
}

function dropContribution(state: SyncState, op: Op, id: Id): SyncState {
  const key = contributionKey(id);
  if (!wins(op, state.meta[key])) return state;
  return patch(state, {
    contributions: omit(state.contributions, id),
    meta: { ...state.meta, [key]: metaOf(op, true) },
  });
}

export function applyOp(state: SyncState, op: Op): SyncState {
  switch (op.kind) {
    case "create_list": {
      const key = listKey(op.listId);
      if (!wins(op, state.meta[key])) return state;
      return patch(state, {
        lists: {
          ...state.lists,
          [op.listId]: {
            id: op.listId,
            name: op.name,
            icon: op.icon,
            position: op.position,
            categoryOrder: op.categoryOrder,
          },
        },
        meta: { ...state.meta, [key]: metaOf(op) },
      });
    }

    case "update_list": {
      const key = listKey(op.listId);
      if (!wins(op, state.meta[key])) return state;
      const existing = state.lists[op.listId];
      // An update for a list we do not have yet is dropped rather than used to
      // conjure a half-built list — unlike entries, a list has no derivable
      // identity, so a partial one would render as a nameless tab.
      if (!existing) return state;
      return patch(state, {
        lists: { ...state.lists, [op.listId]: { ...existing, ...op.patch } },
        meta: { ...state.meta, [key]: metaOf(op) },
      });
    }

    case "delete_list": {
      const key = listKey(op.listId);
      if (!wins(op, state.meta[key])) return state;

      let next = patch(state, {
        lists: omit(state.lists, op.listId),
        meta: { ...state.meta, [key]: metaOf(op, true) },
      });
      // Its entries go with it, or they linger as orphans that the next
      // suggestion pass would happily count as "on a list".
      for (const entry of Object.values(state.entries)) {
        if (entry.listId === op.listId && entry.removedAt === null) {
          next = tombstoneEntry(next, op, entry.listId, entry.catalogItemId);
        }
      }
      return next;
    }

    case "create_catalog_item": {
      const key = catalogKey(op.item.id);
      if (!wins(op, state.meta[key])) return state;
      return patch(state, {
        catalog: { ...state.catalog, [op.item.id]: op.item },
        meta: { ...state.meta, [key]: metaOf(op) },
      });
    }

    case "update_catalog_item": {
      const key = catalogKey(op.itemId);
      if (!wins(op, state.meta[key])) return state;
      const existing = state.catalog[op.itemId];
      if (!existing) return state;
      return patch(state, {
        catalog: {
          ...state.catalog,
          [op.itemId]: { ...existing, ...op.patch },
        },
        meta: { ...state.meta, [key]: metaOf(op) },
      });
    }

    case "add_item":
      return upsertEntry(state, op, op.listId, op.catalogItemId);

    case "remove_item":
      return tombstoneEntry(state, op, op.listId, op.catalogItemId);

    case "set_amount": {
      // Setting an amount implies wanting the item, so make sure it is on the
      // list — otherwise typing "mjölk 2 l" would record a quantity for
      // something invisible.
      const withEntry = upsertEntry(state, op, op.listId, op.catalogItemId);
      return setManualField(
        withEntry,
        op,
        op.listId,
        op.catalogItemId,
        "amount",
        op.amount,
      );
    }

    case "set_note": {
      const withEntry = upsertEntry(state, op, op.listId, op.catalogItemId);
      return setManualField(
        withEntry,
        op,
        op.listId,
        op.catalogItemId,
        "note",
        op.note,
      );
    }

    case "add_recipe": {
      const key = additionKey(op.recipeAdditionId);
      if (!wins(op, state.meta[key])) return state;

      let next = patch(state, {
        recipeAdditions: {
          ...state.recipeAdditions,
          [op.recipeAdditionId]: {
            id: op.recipeAdditionId,
            listId: op.listId,
            recipeId: op.recipeId,
            scaleFactor: op.scaleFactor,
            addedAt: op.at,
            addedBy: op.actor,
          },
        },
        meta: { ...state.meta, [key]: metaOf(op) },
      });

      for (const item of op.items) {
        next = upsertEntry(next, op, op.listId, item.catalogItemId);
        next = setContribution(next, op, {
          id: recipeContributionId(op.recipeAdditionId, item.catalogItemId),
          entryId: entryId(op.listId, item.catalogItemId),
          sourceKind: "recipe",
          recipeAdditionId: op.recipeAdditionId,
          // Already scaled by the caller. Multiplying here as well would double
          // every quantity — the exact failure this app exists to prevent.
          amount: item.amount,
          note: null,
        });
      }
      return next;
    }

    case "remove_recipe": {
      const key = additionKey(op.recipeAdditionId);
      if (!wins(op, state.meta[key])) return state;

      let next = patch(state, {
        recipeAdditions: omit(state.recipeAdditions, op.recipeAdditionId),
        meta: { ...state.meta, [key]: metaOf(op, true) },
      });
      // Only this recipe's share goes. The entries stay: something else may
      // still want the cream, and an entry with no contributions is a perfectly
      // valid "buy some, amount unspecified".
      for (const c of Object.values(state.contributions)) {
        if (c.recipeAdditionId === op.recipeAdditionId) {
          next = dropContribution(next, op, c.id);
        }
      }
      return next;
    }

    case "move_item": {
      const moved = tombstoneEntry(
        state,
        op,
        op.fromListId,
        op.catalogItemId,
      );
      return upsertEntry(moved, op, op.toListId, op.catalogItemId);
    }
  }
}

export function applyOps(state: SyncState, ops: Op[]): SyncState {
  return ops.reduce(applyOp, state);
}

/**
 * Drop tombstones older than the cutoff.
 *
 * Tombstones exist so a stale op loses; once no client can still be holding an
 * op that old, they are dead weight. The cutoff must match the op log's
 * retention, or a client staler than the tombstones could resurrect something.
 */
export function pruneTombstones(state: SyncState, olderThan: Date): SyncState {
  const cutoff = olderThan.toISOString();
  const next = emptyState();

  next.lists = state.lists;
  next.catalog = state.catalog;
  next.recipes = state.recipes;
  next.recipeAdditions = state.recipeAdditions;
  next.contributions = state.contributions;

  next.entries = Object.fromEntries(
    Object.entries(state.entries).filter(
      ([, e]) => e.removedAt === null || e.removedAt >= cutoff,
    ),
  );

  const liveKeys = new Set<string>([
    ...Object.keys(next.entries).map(entryKey),
    ...Object.keys(next.lists).map(listKey),
    ...Object.keys(next.catalog).map(catalogKey),
    ...Object.keys(next.contributions).map(contributionKey),
    ...Object.keys(next.recipeAdditions).map(additionKey),
  ]);

  next.meta = Object.fromEntries(
    Object.entries(state.meta).filter(
      ([key, m]) => liveKeys.has(key) || !m.deleted || m.at >= cutoff,
    ),
  );

  return next;
}
