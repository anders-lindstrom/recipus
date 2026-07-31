import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { suggestionDismissals } from "@/db/schema";
import { localDayKey } from "@/lib/cadence";
import type { Id } from "@/lib/domain";

/**
 * "Inte den här gången" — silencing one suggestion for the rest of the day.
 *
 * The "Föreslås" row offers items the cadence engine thinks are about due. Until
 * this existed the only possible answer was yes: tapping added the item, and
 * there was no way to say no, so a suggestion you did not want sat there every
 * time you opened the app for as long as the cadence kept firing.
 *
 * **Household-wide, deliberately.** There is no actor column and dismissing
 * silences the item for everyone — Anders's call, and the wanted behaviour
 * rather than a simplification: two people shopping from one list do not want to
 * each decline the same suggestion.
 *
 * **Not an op, also deliberately.** Dismissals are append-only and commutative —
 * the primary key is (item, day), so two devices dismissing the same thing write
 * the same row and there is nothing to resolve. That is the same reasoning that
 * keeps `purchases` out of the reducer (see SyncState's comment in
 * src/lib/domain.ts). Routing them through the op log would buy conflict
 * resolution for a value that cannot conflict, and would put a permanent entry
 * in the catch-up log for something that is meaningless by tomorrow.
 *
 * The cost of that choice, stated plainly: dismissing needs the network. The
 * client hides the tile optimistically so the gesture always feels like it
 * worked, and the worst case offline is that the suggestion reappears on the
 * next hydrate.
 */

/**
 * Record a dismissal for the local day `now` falls on.
 *
 * Idempotent by primary key: a double tap, a retry, or both of you declining the
 * same suggestion all write the same row. Without `onConflictDoNothing` the
 * second one throws, and a dismissal that 500s reads to the user as one that did
 * not take.
 */
export async function dismissSuggestion(
  catalogItemId: Id,
  now: Date,
): Promise<void> {
  await db
    .insert(suggestionDismissals)
    .values({ catalogItemId, day: localDayKey(now) })
    .onConflictDoNothing();
}

/**
 * Take a dismissal back.
 *
 * The gesture that dismisses is a long-press on the tile, and it acts
 * immediately rather than opening a sheet — so this is the safety valve, offered
 * as "Ångra" in the section heading exactly as buying an item already is. It has
 * to reach the server rather than only clearing the local set, or the suggestion
 * comes back on this phone and stays gone on the other one.
 *
 * A delete of a row that is not there affects nothing and raises nothing, which
 * is what makes the undo safe to tap twice.
 */
export async function restoreSuggestion(
  catalogItemId: Id,
  now: Date,
): Promise<void> {
  await db
    .delete(suggestionDismissals)
    .where(
      and(
        eq(suggestionDismissals.catalogItemId, catalogItemId),
        eq(suggestionDismissals.day, localDayKey(now)),
      ),
    );
}

/**
 * Which items are silenced on the local day `now` falls on.
 *
 * Returned as a Set because the only caller feeds it straight into
 * `rankSuggestions`'s `excludeItemIds` — the engine already knows how to leave
 * items out, so a dismissal needs no new concept inside it.
 *
 * Scoped to one exact day rather than a range: yesterday's dismissal is spent,
 * and "for the rest of today" has to mean the calendar day or the item comes
 * back at an arbitrary hour. `localDayKey` is shared with the cadence engine's
 * own per-day collapsing so the two can never disagree about where a day ends.
 */
export async function dismissedOn(now: Date): Promise<Set<Id>> {
  const rows = await db
    .select({ catalogItemId: suggestionDismissals.catalogItemId })
    .from(suggestionDismissals)
    .where(eq(suggestionDismissals.day, localDayKey(now)));
  return new Set(rows.map((r) => r.catalogItemId));
}
