import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  catalogItems,
  contributions,
  listEntries,
  lists,
  ops as opsTable,
  purchases,
  suggestionDismissals,
} from "@/db/schema";
import { entryId, manualContributionId } from "@/lib/domain";
import type { Op } from "@/lib/sync";
import { applyOpToDatabase } from "./apply-op";
import { pruneRetention } from "./prune";

/**
 * Retention, driven through the real database.
 *
 * This is the one piece of this codebase that DELETES, so the half of it worth
 * testing hardest is what it leaves alone: a live entry, a tombstone still
 * inside the window, and — above all — purchase history, which is the sole input
 * to the cadence engine and to the statistics screen. `purchases.list_id` is a
 * plain text column with no foreign key precisely so that pruning a deleted list
 * can never cascade into it, and that is an easy property to lose by accident in
 * a later migration.
 */

const ACTOR = "test-prune-actor";
const RUN = randomUUID().slice(0, 8);
const listId = `test-prune-list-${RUN}`;
const items = {
  old: `test-prune-item-old-${RUN}`,
  recent: `test-prune-item-recent-${RUN}`,
  live: `test-prune-item-live-${RUN}`,
};

/**
 * Well outside the 30-day window, and comfortably inside it.
 *
 * The two long-ago stamps are an hour apart on purpose. Last-write-wins breaks
 * ties on the actor's name, and every op here shares one actor — so a removal
 * written at the same instant as the amount before it loses the comparison and
 * never tombstones anything, leaving this suite quietly testing nothing.
 */
const NOW = new Date("2026-07-30T12:00:00.000Z");
const LONG_AGO = "2026-05-01T12:00:00.000Z";
const LONG_AGO_LATER = "2026-05-01T13:00:00.000Z";
const RECENTLY = "2026-07-25T12:00:00.000Z";

function op(kind: string, at: string, fields: Record<string, unknown>): Op {
  return {
    kind,
    clientOpId: randomUUID(),
    actor: ACTOR,
    at,
    ...fields,
  } as unknown as Op;
}

async function seedItem(id: string): Promise<void> {
  await applyOpToDatabase(
    op("create_catalog_item", LONG_AGO, {
      item: {
        id,
        name: id,
        nameNorm: id,
        categoryId: "frukt-gront",
        iconRef: "1F34E",
        isCustom: true,
        hasAtHome: false,
        useCount: 0,
        lastUsedAt: null,
      },
    }),
    ACTOR,
  );
}

beforeAll(async () => {
  await applyOpToDatabase(
    op("create_list", LONG_AGO, {
      listId,
      name: "Prune",
      icon: "1F6D2",
      position: 997,
      categoryOrder: [],
    }),
    ACTOR,
  );
  for (const id of Object.values(items)) await seedItem(id);

  // Bought and gone long ago: tombstone past the window, plus the purchase row
  // that must outlive it.
  await applyOpToDatabase(
    op("set_amount", LONG_AGO, {
      listId,
      catalogItemId: items.old,
      amount: { value: 2, unit: "l" },
    }),
    ACTOR,
  );
  await applyOpToDatabase(
    op("remove_item", LONG_AGO_LATER, {
      listId,
      catalogItemId: items.old,
      bought: true,
    }),
    ACTOR,
  );

  // Removed last week — still recallable, so still a tombstone.
  await applyOpToDatabase(
    op("remove_item", RECENTLY, {
      listId,
      catalogItemId: items.recent,
      bought: false,
    }),
    ACTOR,
  );

  // On the list right now, added long ago. Age is not the test; removal is.
  await applyOpToDatabase(
    op("add_item", LONG_AGO, { listId, catalogItemId: items.live }),
    ACTOR,
  );
});

afterAll(async () => {
  const all = Object.values(items);
  await db
    .delete(suggestionDismissals)
    .where(inArray(suggestionDismissals.catalogItemId, all));
  await db.delete(purchases).where(inArray(purchases.catalogItemId, all));
  await db.delete(opsTable).where(eq(opsTable.actor, ACTOR));
  await db.delete(listEntries).where(eq(listEntries.listId, listId));
  await db.delete(catalogItems).where(inArray(catalogItems.id, all));
  await db.delete(lists).where(eq(lists.id, listId));
});

describe("pruneRetention", () => {
  it("forgets what is past recall and keeps everything else", async () => {
    // Every op above was written with a client clock months in the past, but the
    // op log is pruned on the SERVER clock, so they are all still young. Proving
    // the two clocks are not confused needs its own test; here it just means the
    // ops table is left alone.
    await pruneRetention(NOW);

    const entries = await db
      .select()
      .from(listEntries)
      .where(eq(listEntries.listId, listId));
    const byItem = (id: string) => entries.find((e) => e.catalogItemId === id);

    expect(byItem(items.old)).toBeUndefined();
    expect(byItem(items.recent)).toBeDefined();
    expect(byItem(items.live)).toBeDefined();

    // The pruned entry's contribution goes with it — otherwise it is an orphan
    // pointing at an entry nobody has any record of, and its row keeps a
    // last-write-wins key alive forever.
    const orphan = await db
      .select()
      .from(contributions)
      .where(
        eq(contributions.id, manualContributionId(entryId(listId, items.old))),
      );
    expect(orphan).toHaveLength(0);

    // The whole point of keeping history. A purchase is not a tombstone: it is
    // the only record that the household ever bought this, and the cadence
    // engine reads nothing else.
    const kept = await db
      .select()
      .from(purchases)
      .where(eq(purchases.catalogItemId, items.old));
    expect(kept).toHaveLength(1);
  });

  /**
   * Dismissals are spent the day after they are made, and nothing else forgets
   * them — so they belong here rather than accumulating one row per declined
   * suggestion per day forever.
   *
   * The comparison is lexicographic on a `YYYY-MM-DD` string, which is only
   * correct because `localDayKey` zero-pads. An unpadded `2026-7-5` would sort
   * after `2026-12-31` and the prune would quietly skip rows or take live ones.
   */
  it("forgets spent suggestion dismissals", async () => {
    await db.insert(suggestionDismissals).values([
      { catalogItemId: items.live, day: "2026-05-01" },
      { catalogItemId: items.live, day: "2026-07-29" },
    ]);

    await pruneRetention(NOW);

    const left = await db
      .select()
      .from(suggestionDismissals)
      .where(eq(suggestionDismissals.catalogItemId, items.live));
    expect(left.map((r) => r.day)).toEqual(["2026-07-29"]);
  });

  it("prunes the op log on the server clock, not the client's", async () => {
    // A phone with a badly-set clock stamps `at` years in the past — that value
    // is load-bearing for last-write-wins and deliberately never rewritten. If
    // retention read it, that phone's ops would be deleted the moment they
    // landed, and the op log would lose entries nobody could explain.
    const { seq } = await applyOpToDatabase(
      op("add_item", "2019-01-01T00:00:00.000Z", {
        listId,
        catalogItemId: items.live,
      }),
      ACTOR,
    );

    await pruneRetention(NOW);

    const [row] = await db
      .select({ seq: opsTable.seq })
      .from(opsTable)
      .where(eq(opsTable.seq, seq));
    expect(row).toBeDefined();
  });
});
