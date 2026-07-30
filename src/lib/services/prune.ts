import { lt } from "drizzle-orm";
import { db } from "@/db";
import {
  listEntries,
  lists,
  ops as opsTable,
  recipeAdditions,
  recipes,
} from "@/db/schema";
import { retentionCutoff } from "@/lib/retention";

/**
 * Forgetting, on a schedule.
 *
 * Two things grow without bound here and neither is load-bearing forever: the op
 * log, and the tombstones. A tombstone is not a record of anything — it exists
 * only so that a stale op arriving late LOSES its last-write-wins comparison.
 * Once no phone can still be holding an op that old, it is dead weight that the
 * client re-serialises to IndexedDB on every single tap.
 *
 * The two prunes belong in one function, on one cutoff, deliberately. Pruning
 * the op log alone is harmless; pruning tombstones alone is a resurrection bug
 * waiting for a straggler. Keeping them in separate callers is how those two
 * facts drift apart.
 *
 * What is NOT pruned, and must never be: `purchases`. A purchase is not
 * bookkeeping about a deletion, it is the household's history, and it is the
 * sole input to the cadence engine and the statistics screen. It survives the
 * list it was made on — `purchases.list_id` carries no foreign key precisely so
 * that pruning a deleted list cannot cascade into it.
 */
export interface PruneResult {
  ops: number;
  entries: number;
  recipeAdditions: number;
  lists: number;
  recipes: number;
}

export async function pruneRetention(now: Date): Promise<PruneResult> {
  const cutoff = retentionCutoff(now);

  // One transaction: a half-applied prune would leave the op log trimmed while
  // the tombstones it was matched to survive, or the reverse — and the reverse
  // is the resurrection bug.
  return db.transaction(async (tx) => {
    /**
     * The op log goes by SERVER time, not the client clock in `at`.
     *
     * `at` is deliberately never rewritten to server time (see ops.ts) because
     * an offline phone's edits must not all lose to online ones. The cost is
     * that `at` is whatever that phone's clock said — a device with its date
     * badly wrong stamps ops years into the past, and pruning on `at` would
     * delete them the moment they landed. `created_at` is assigned here, by us,
     * and is the only honest answer to "how long have we had this".
     */
    const prunedOps = await tx
      .delete(opsTable)
      .where(lt(opsTable.createdAt, cutoff))
      .returning({ seq: opsTable.seq });

    /**
     * Tombstones go by the CLIENT clock, and that asymmetry is intended.
     *
     * `removed_at` is the moment the user removed the thing, which is exactly
     * what "old enough that no straggler can still be arguing about it" means.
     * The op log is asking a different question — how long we have stored a row
     * — so it gets a different clock. Two clocks measuring two things beats one
     * clock measuring the wrong one, which is the mistake this codebase has
     * already paid for three times.
     *
     * Contributions are not deleted here: `contributions.entry_id` cascades, so
     * they go with their entry automatically. Doing it by hand as well would be
     * a second definition of the same rule.
     */
    const prunedEntries = await tx
      .delete(listEntries)
      .where(lt(listEntries.removedAt, cutoff))
      .returning({ id: listEntries.id });

    const prunedAdditions = await tx
      .delete(recipeAdditions)
      .where(lt(recipeAdditions.removedAt, cutoff))
      .returning({ id: recipeAdditions.id });

    // Deleted lists and recipes take their remaining children with them by
    // cascade — entries and their contributions, ingredients and additions.
    const prunedLists = await tx
      .delete(lists)
      .where(lt(lists.deletedAt, cutoff))
      .returning({ id: lists.id });

    const prunedRecipes = await tx
      .delete(recipes)
      .where(lt(recipes.deletedAt, cutoff))
      .returning({ id: recipes.id });

    return {
      ops: prunedOps.length,
      entries: prunedEntries.length,
      recipeAdditions: prunedAdditions.length,
      lists: prunedLists.length,
      recipes: prunedRecipes.length,
    };
  });
}
