import {
  emptyState,
  entryId,
  manualContributionId,
  recipeContributionId,
  type Amount,
  type CatalogItem,
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

/**
 * The last-write-wins key shapes, exported because three places need them.
 *
 * The server rebuilds these from database columns and the client rebuilds them
 * from a snapshot, so for a while each kept its own copy with a comment saying
 * "must stay in lockstep with reducer.ts". That is a latent bug rather than a
 * safeguard: a mismatched key does not throw, it silently reads as "no prior
 * record", so the newest write always wins and conflict resolution quietly
 * stops working. One definition, imported everywhere, cannot drift.
 */
export const listKey = (id: Id): MetaKey => `list:${id}`;
export const catalogKey = (id: Id): MetaKey => `catalog:${id}`;
export const entryKey = (id: Id): MetaKey => `entry:${id}`;
export const contributionKey = (id: Id): MetaKey => `contribution:${id}`;
export const additionKey = (id: Id): MetaKey => `addition:${id}`;
/** The amount and the note carry independent clocks — see setManualField. */
export const contributionFieldKey = (
  id: Id,
  field: "amount" | "note",
): MetaKey => `contribution:${id}:${field}`;

/**
 * The editable facts about a catalog item, each with its own clock.
 *
 * Not one clock per column: `name` covers `name` and `nameNorm` together,
 * because they are one fact in two representations and an item findable under a
 * name it no longer displays is worse than either.
 *
 * `isCustom`, `useCount` and `lastUsedAt` are deliberately absent, and
 * `update_catalog_item` ignores them in a patch. They are not household
 * opinions: `isCustom` is a fact about how the item was born, and the two
 * counters are derived from purchase history by the server. A client asserting
 * an absolute `useCount` would clobber a concurrent increment, which is a lost
 * update rather than a conflict — last-write-wins has nothing useful to say
 * about it.
 */
export type CatalogField = "name" | "category" | "icon" | "home";
export const CATALOG_FIELDS: readonly CatalogField[] = [
  "name",
  "category",
  "icon",
  "home",
];
export const catalogFieldKey = (id: Id, field: CatalogField): MetaKey =>
  `catalog:${id}:${field}`;

type CatalogItemPatch = Partial<Omit<CatalogItem, "id">>;

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

/**
 * The part of a patch that speaks to one field, or null if it says nothing.
 *
 * The null matters: an op that does not mention the icon must not stamp the
 * icon's clock, or it would beat a later op that actually changes the icon.
 * Distinguishing "sets this to X" from "is silent about this" is the whole job.
 */
function catalogFieldPatch(
  update: CatalogItemPatch,
  field: CatalogField,
): CatalogItemPatch | null {
  switch (field) {
    case "name": {
      // One fact, two columns: whichever the patch carries, both clocks move
      // together, so a display name can never drift from the string search
      // matches against.
      const out: CatalogItemPatch = {};
      if (update.name !== undefined) out.name = update.name;
      if (update.nameNorm !== undefined) out.nameNorm = update.nameNorm;
      return Object.keys(out).length > 0 ? out : null;
    }
    case "category":
      return update.categoryId !== undefined
        ? { categoryId: update.categoryId }
        : null;
    case "icon":
      return update.iconRef !== undefined ? { iconRef: update.iconRef } : null;
    case "home":
      return update.hasAtHome !== undefined
        ? { hasAtHome: update.hasAtHome }
        : null;
  }
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
      // Every field clock is set too. A create writes all four facts at once, so
      // this op is honestly the last write for each of them — and leaving them
      // unset would mean a later `update_catalog_item` had nothing to lose
      // against, however stale it was.
      const meta = { ...state.meta, [key]: metaOf(op) };
      for (const field of CATALOG_FIELDS) {
        meta[catalogFieldKey(op.item.id, field)] = metaOf(op);
      }
      return patch(state, {
        catalog: { ...state.catalog, [op.item.id]: op.item },
        meta,
      });
    }

    /**
     * Each fact resolved against its own clock.
     *
     * With one clock for the whole row, a rename at 17:00 and a re-filing into
     * another aisle at 14:00 converge differently depending on arrival order:
     * applied 14:00-then-17:00 both stick, applied the other way the re-filing
     * loses and the item silently walks back to its old aisle. Same ops, two
     * states — the divergence this module exists to rule out. Verified by
     * execution before this was split.
     *
     * Note what is NOT here: the row-level `catalog:${id}` clock is neither
     * consulted nor written. It means "last touched by anyone", which the seed
     * guard and `create_catalog_item` both need, but it is the wrong thing to
     * resolve a single field against — that is precisely the moving clock the
     * split removes. The database's `updated_at` is recomputed as the latest of
     * all the field clocks, which is order-independent.
     */
    case "update_catalog_item": {
      const existing = state.catalog[op.itemId];
      // An update for an item we have never seen is dropped rather than used to
      // conjure a partial row, exactly as `update_list` is. Reachable only if an
      // update overtook its own create, which the per-device op order and the
      // server's sequencing both rule out.
      if (!existing) return state;

      let item = existing;
      let meta = state.meta;
      for (const field of CATALOG_FIELDS) {
        const fieldPatch = catalogFieldPatch(op.patch, field);
        // Silent about this fact: no claim, so no clock to stamp. Stamping it
        // anyway would let an op that says nothing about the icon beat one that
        // does.
        if (!fieldPatch) continue;
        const key = catalogFieldKey(op.itemId, field);
        if (!wins(op, meta[key])) continue;
        item = { ...item, ...fieldPatch };
        meta = { ...meta, [key]: metaOf(op) };
      }

      if (item === existing) return state;
      return patch(state, {
        catalog: { ...state.catalog, [op.itemId]: item },
        meta,
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

    /**
     * An op kind this build has never heard of.
     *
     * This branch is what lets a phone that has not been updated survive an op
     * from one that has, and it is deliberately load-bearing rather than
     * defensive: without it the switch fell through and returned `undefined`,
     * `applyOps` then threw on the next iteration, and the store wrote
     * `undefined` over the cached state and retried forever — an app that opens
     * to an empty list in a shop and blames the network. Dropping an op we
     * cannot understand trades convergence for availability, which is the right
     * way round: an old phone missing an item's urgency flag is a cosmetic
     * disagreement, an old phone that will not open is not.
     *
     * The `never` assignment keeps this from becoming a silent hole in the
     * *other* direction. If a kind is added to `Op` and not handled above, `op`
     * does not narrow to `never` here and the build fails, so forgetting a case
     * is a compile error rather than a live op that vanishes.
     *
     * Ops dropped here are not re-fetched — the cursor advances regardless — so
     * a client that skipped one repairs itself via the `stateVersion` rehydrate
     * in src/lib/client/db.ts rather than by replaying the log.
     */
    default: {
      const unhandled: never = op;
      void unhandled;
      return state;
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
