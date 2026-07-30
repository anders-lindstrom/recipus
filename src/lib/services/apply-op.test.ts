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
  recipeAdditions,
  recipes,
} from "@/db/schema";
import { entryId, manualContributionId } from "@/lib/domain";
import type { Op } from "@/lib/sync";
import { SEED_ACTOR, upsertSeedCatalogItem } from "@/db/seed";
import { applyOpToDatabase } from "./apply-op";
import { loadListSnapshot } from "./list-data";

/**
 * These need the dev database (Postgres on 5434, see .env). Every row this
 * suite creates is prefixed with `test-apply-op-` and removed in `afterAll`,
 * so re-running the suite never collides with itself or with real data.
 */

const ACTOR = "test-apply-op-actor";
const RUN = randomUUID().slice(0, 8);
const listId = `test-apply-op-list-${RUN}`;
const catalogItemId = `test-apply-op-item-${RUN}`;

function op(kind: string, at: string, fields: Record<string, unknown>): Op {
  return {
    kind,
    clientOpId: randomUUID(),
    actor: ACTOR,
    at,
    ...fields,
  } as unknown as Op;
}

/**
 * Extra catalog items created by individual tests.
 *
 * Tracked so `afterAll` can reach them: this suite runs against the real dev
 * database, and an item left behind shows up as a stray tile in the app.
 */
const extraItems: string[] = [];
/** Recipes created by individual tests, for the same cleanup reason. */
const extraRecipes: string[] = [];

async function seedItem(id: string): Promise<void> {
  extraItems.push(id);
  await applyOpToDatabase(
    op("create_catalog_item", "2026-01-01T00:00:00.000Z", {
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
    op("create_list", "2026-01-01T00:00:00.000Z", {
      listId,
      name: "Test",
      icon: "1F6D2",
      position: 999,
      categoryOrder: [],
    }),
    ACTOR,
  );
  await applyOpToDatabase(
    op("create_catalog_item", "2026-01-01T00:00:00.000Z", {
      item: {
        id: catalogItemId,
        name: "Test Item",
        nameNorm: "test item",
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
});

afterAll(async () => {
  // FK order: purchases and entries reference catalog items, so they go first.
  const allItems = [catalogItemId, ...extraItems];
  await db.delete(purchases).where(inArray(purchases.catalogItemId, allItems));
  await db
    .delete(opsTable)
    .where(inArray(opsTable.actor, [ACTOR]));
  await db.delete(listEntries).where(eq(listEntries.listId, listId));
  await db.delete(catalogItems).where(inArray(catalogItems.id, allItems));
  await db.delete(lists).where(eq(lists.id, listId));
  await db.delete(recipes).where(inArray(recipes.id, extraRecipes));
});

describe("applyOpToDatabase", () => {
  it("replays the same clientOpId idempotently, without re-applying it", async () => {
    const addOp = op("add_item", "2026-01-02T00:00:00.000Z", {
      listId,
      catalogItemId,
    });

    const first = await applyOpToDatabase(addOp, ACTOR);
    const second = await applyOpToDatabase(addOp, ACTOR);

    expect(second.seq).toBe(first.seq);

    const rows = await db
      .select()
      .from(opsTable)
      .where(eq(opsTable.clientOpId, addOp.clientOpId));
    expect(rows).toHaveLength(1);
  });

  it("writes exactly one purchase and bumps use_count when bought is true", async () => {
    const eid = entryId(listId, catalogItemId);

    await applyOpToDatabase(
      op("add_item", "2026-01-03T00:00:00.000Z", { listId, catalogItemId }),
      ACTOR,
    );

    const [beforeItem] = await db
      .select({ useCount: catalogItems.useCount })
      .from(catalogItems)
      .where(eq(catalogItems.id, catalogItemId));

    const removeOp = op("remove_item", "2026-01-03T00:01:00.000Z", {
      listId,
      catalogItemId,
      bought: true,
    });
    await applyOpToDatabase(removeOp, ACTOR);

    const purchaseRows = await db
      .select()
      .from(purchases)
      .where(eq(purchases.catalogItemId, catalogItemId));
    expect(purchaseRows).toHaveLength(1);
    expect(purchaseRows[0].listId).toBe(listId);
    expect(purchaseRows[0].actor).toBe(ACTOR);

    const [afterItem] = await db
      .select({ useCount: catalogItems.useCount, lastUsedAt: catalogItems.lastUsedAt })
      .from(catalogItems)
      .where(eq(catalogItems.id, catalogItemId));
    expect(afterItem.useCount).toBe(beforeItem.useCount + 1);
    expect(afterItem.lastUsedAt).not.toBeNull();

    const [entryRow] = await db
      .select({ removedAt: listEntries.removedAt })
      .from(listEntries)
      .where(eq(listEntries.id, eid));
    expect(entryRow.removedAt).not.toBeNull();
  });

  it("writes no purchase when bought is false", async () => {
    await applyOpToDatabase(
      op("add_item", "2026-01-04T00:00:00.000Z", { listId, catalogItemId }),
      ACTOR,
    );

    const beforeCount = (
      await db.select().from(purchases).where(eq(purchases.catalogItemId, catalogItemId))
    ).length;

    await applyOpToDatabase(
      op("remove_item", "2026-01-04T00:01:00.000Z", {
        listId,
        catalogItemId,
        bought: false,
      }),
      ACTOR,
    );

    const afterCount = (
      await db.select().from(purchases).where(eq(purchases.catalogItemId, catalogItemId))
    ).length;
    expect(afterCount).toBe(beforeCount);
  });

  it("a stale op loses to a newer op already applied, and never records a purchase for the loss", async () => {
    const eid = entryId(listId, catalogItemId);

    // Re-add, then remove+buy at a LATER timestamp than the stale op below.
    await applyOpToDatabase(
      op("add_item", "2026-01-05T00:00:00.000Z", { listId, catalogItemId }),
      ACTOR,
    );
    await applyOpToDatabase(
      op("remove_item", "2026-01-05T00:10:00.000Z", {
        listId,
        catalogItemId,
        bought: true,
      }),
      ACTOR,
    );

    const purchasesBefore = await db
      .select()
      .from(purchases)
      .where(eq(purchases.catalogItemId, catalogItemId));

    // A remove_item{bought:true} that was queued EARLIER (client clock) but
    // arrives late — e.g. a phone that was offline. Its timestamp is older
    // than the removal already applied above, so it must lose: the entry
    // must stay removed (not resurrected), and — the bug this test guards
    // against — it must NOT write a second purchase for a removal that never
    // actually took effect.
    const staleOp = op("remove_item", "2026-01-05T00:05:00.000Z", {
      listId,
      catalogItemId,
      bought: true,
    });
    await applyOpToDatabase(staleOp, ACTOR);

    const purchasesAfter = await db
      .select()
      .from(purchases)
      .where(eq(purchases.catalogItemId, catalogItemId));
    expect(purchasesAfter).toHaveLength(purchasesBefore.length);

    const [entryRow] = await db
      .select({ removedAt: listEntries.removedAt, updatedBy: listEntries.updatedBy })
      .from(listEntries)
      .where(eq(listEntries.id, eid));
    expect(entryRow.removedAt).not.toBeNull();
  });

  it("a stale set_amount loses to a newer amount already on the server", async () => {
    const eid = entryId(listId, catalogItemId);
    const cid = manualContributionId(eid);

    await applyOpToDatabase(
      op("add_item", "2026-01-06T00:00:00.000Z", { listId, catalogItemId }),
      ACTOR,
    );
    await applyOpToDatabase(
      op("set_amount", "2026-01-06T00:10:00.000Z", {
        listId,
        catalogItemId,
        amount: { value: 5, unit: "dl" },
      }),
      ACTOR,
    );

    // Older timestamp, arrives later — must not overwrite the 5 dl above.
    await applyOpToDatabase(
      op("set_amount", "2026-01-06T00:05:00.000Z", {
        listId,
        catalogItemId,
        amount: { value: 1, unit: "dl" },
      }),
      ACTOR,
    );

    const [row] = await db
      .select({ amountValue: contributions.amountValue, amountUnit: contributions.amountUnit })
      .from(contributions)
      .where(eq(contributions.id, cid));
    expect(row.amountValue).toBe(5);
    expect(row.amountUnit).toBe("dl");
  });

  it("amount and note carry independent clocks — a newer note must not make a genuinely newer amount lose", async () => {
    // The regression this guards: amount/note used to share one physical
    // clock column. A note write later than an amount write made the row's
    // single clock look like the NOTE's timestamp; a subsequent amount write
    // older than that borrowed clock (but newer than the amount's own true
    // last write) then lost incorrectly. With per-field columns
    // (amount_updated_at/_by, note_updated_at/_by), the amount comparison
    // must only ever be measured against the amount's own history.
    const eid = entryId(listId, catalogItemId);
    const cid = manualContributionId(eid);

    await applyOpToDatabase(
      op("add_item", "2026-01-07T00:00:00.000Z", { listId, catalogItemId }),
      ACTOR,
    );
    // T1: first-ever amount write.
    await applyOpToDatabase(
      op("set_amount", "2026-01-07T00:01:00.000Z", {
        listId,
        catalogItemId,
        amount: { value: 5, unit: "dl" },
      }),
      ACTOR,
    );
    // T2 (> T1): a note write — must not touch the amount's clock.
    await applyOpToDatabase(
      op("set_note", "2026-01-07T00:10:00.000Z", {
        listId,
        catalogItemId,
        note: "extra fett",
      }),
      ACTOR,
    );
    // T1.5 (between T1 and T2): a genuinely newer amount write than the
    // amount's own last write (T1) — must win, even though it is OLDER than
    // the note's clock (T2).
    await applyOpToDatabase(
      op("set_amount", "2026-01-07T00:05:00.000Z", {
        listId,
        catalogItemId,
        amount: { value: 10, unit: "dl" },
      }),
      ACTOR,
    );

    const [row] = await db
      .select({
        amountValue: contributions.amountValue,
        amountUnit: contributions.amountUnit,
        note: contributions.note,
      })
      .from(contributions)
      .where(eq(contributions.id, cid));
    expect(row.amountValue).toBe(10);
    expect(row.amountUnit).toBe("dl");
    expect(row.note).toBe("extra fett");
  });
});

describe("undo retracts the purchase", () => {
  /**
   * "Ångra" always put the item back on the list. It never removed the purchase
   * row the removal wrote, nor undid the use_count bump — so "bought" silently
   * accumulated everything anyone had ever mis-tapped. Purchase history is the
   * only input to the cadence engine, so that is not a rounding error: it is the
   * app insisting you buy something you told it you did not.
   */
  it("deletes the purchase, decrements use_count and recomputes last_used_at", async () => {
    const item = `${catalogItemId}-undo`;
    await seedItem(item);

    // An earlier, genuine purchase that must SURVIVE the undo — this is what
    // distinguishes recomputing last_used_at from simply clearing it.
    await applyOpToDatabase(
      op("add_item", "2026-02-01T00:00:00.000Z", { listId, catalogItemId: item }),
      ACTOR,
    );
    const firstBuy = op("remove_item", "2026-02-01T10:00:00.000Z", {
      listId,
      catalogItemId: item,
      bought: true,
    });
    await applyOpToDatabase(firstBuy, ACTOR);

    // The mis-tap.
    await applyOpToDatabase(
      op("add_item", "2026-02-05T00:00:00.000Z", { listId, catalogItemId: item }),
      ACTOR,
    );
    const misTap = op("remove_item", "2026-02-05T10:00:00.000Z", {
      listId,
      catalogItemId: item,
      bought: true,
    });
    await applyOpToDatabase(misTap, ACTOR);

    const [before] = await db
      .select({ useCount: catalogItems.useCount })
      .from(catalogItems)
      .where(eq(catalogItems.id, item));
    expect(before.useCount).toBe(2);

    // Undo: an add_item naming the removal it retracts.
    await applyOpToDatabase(
      op("add_item", "2026-02-05T10:00:05.000Z", {
        listId,
        catalogItemId: item,
        undoesClientOpId: misTap.clientOpId,
      }),
      ACTOR,
    );

    const rows = await db
      .select()
      .from(purchases)
      .where(eq(purchases.catalogItemId, item));
    expect(rows).toHaveLength(1);
    expect(rows[0].clientOpId).toBe(firstBuy.clientOpId);

    const [after] = await db
      .select({ useCount: catalogItems.useCount, lastUsedAt: catalogItems.lastUsedAt })
      .from(catalogItems)
      .where(eq(catalogItems.id, item));
    expect(after.useCount).toBe(1);
    // Rolled back to the surviving purchase, not cleared and not left on the
    // retracted one.
    expect(after.lastUsedAt?.toISOString()).toBe("2026-02-01T10:00:00.000Z");
  });

  it("is idempotent, so a replayed undo cannot delete a later purchase", async () => {
    const item = `${catalogItemId}-undo-replay`;
    await seedItem(item);

    await applyOpToDatabase(
      op("add_item", "2026-03-01T00:00:00.000Z", { listId, catalogItemId: item }),
      ACTOR,
    );
    const buy = op("remove_item", "2026-03-01T10:00:00.000Z", {
      listId,
      catalogItemId: item,
      bought: true,
    });
    await applyOpToDatabase(buy, ACTOR);

    const undo = op("add_item", "2026-03-01T10:00:05.000Z", {
      listId,
      catalogItemId: item,
      undoesClientOpId: buy.clientOpId,
    });
    await applyOpToDatabase(undo, ACTOR);
    // Same clientOpId: the op log dedupes this, but the retraction must be safe
    // on its own terms too, since a differently-keyed op could name the same
    // removal.
    await applyOpToDatabase(undo, ACTOR);

    const [after] = await db
      .select({ useCount: catalogItems.useCount })
      .from(catalogItems)
      .where(eq(catalogItems.id, item));
    // Zero, not minus one: the second pass must find nothing to retract.
    expect(after.useCount).toBe(0);
  });

  it("leaves history alone when there was no purchase to retract", async () => {
    const item = `${catalogItemId}-undo-noop`;
    await seedItem(item);

    // A plain add carrying an undo reference that names nothing.
    await applyOpToDatabase(
      op("add_item", "2026-04-01T00:00:00.000Z", {
        listId,
        catalogItemId: item,
        undoesClientOpId: randomUUID(),
      }),
      ACTOR,
    );

    const rows = await db
      .select()
      .from(purchases)
      .where(eq(purchases.catalogItemId, item));
    expect(rows).toHaveLength(0);

    const [after] = await db
      .select({ useCount: catalogItems.useCount })
      .from(catalogItems)
      .where(eq(catalogItems.id, item));
    expect(after.useCount).toBe(0);
  });
});

describe("snapshot meta for removed records", () => {
  /**
   * A hydrating client must learn that a record was DELETED, not merely that it
   * is absent.
   *
   * `loadListSnapshot` filtered removed recipe additions out of its query, so
   * neither the row nor its `addition:x` clock reached the client. A stale
   * `add_recipe` replayed from an outbox — reachable whenever an ack write fails
   * after a successful post — then had nothing to lose against, because
   * `wins(op, undefined)` is true regardless of the op's timestamp. The removed
   * recipe and every contribution it asked for came back.
   *
   * The reducer half of this was already right: `apply-op`'s own loader emits
   * `deleted: true`. Only the snapshot disagreed, which is exactly the kind of
   * drift the two-loaders-one-reducer design is supposed to make impossible.
   */
  it("marks a removed recipe addition as deleted rather than omitting it", async () => {
    const recipeId = `${catalogItemId}-recipe`;
    extraRecipes.push(recipeId);
    await db.insert(recipes).values({
      id: recipeId,
      title: "Testkaka",
      servings: 4,
      servingsUnit: "portioner",
      createdBy: ACTOR,
      updatedBy: ACTOR,
    });

    const additionId = `${listId}-addition`;
    await applyOpToDatabase(
      op("add_recipe", "2026-05-01T00:00:00.000Z", {
        listId,
        recipeId,
        recipeAdditionId: additionId,
        scaleFactor: 1,
        items: [{ catalogItemId, amount: { value: 2, unit: "dl" } }],
      }),
      ACTOR,
    );

    // A live addition must still arrive as a record with an UNdeleted clock.
    // Asserted because the first version of the fix got this exactly backwards:
    // `removedAt` was missing from the query's projection, so `undefined !== null`
    // was true and every addition — live ones included — was marked deleted. The
    // removed-addition assertion below passed anyway, for the wrong reason.
    const before = await loadListSnapshot(listId, new Date());
    expect(before!.recipeAdditions[additionId]).toBeDefined();
    expect(before!.meta[`addition:${additionId}`].deleted).toBeUndefined();
    expect(before!.recipeTitles[recipeId]).toBe("Testkaka");

    await applyOpToDatabase(
      op("remove_recipe", "2026-05-01T01:00:00.000Z", {
        listId,
        recipeAdditionId: additionId,
      }),
      ACTOR,
    );

    const snapshot = await loadListSnapshot(listId, new Date());
    expect(snapshot).not.toBeNull();

    // Absent from the records, which was already true...
    expect(snapshot!.recipeAdditions[additionId]).toBeUndefined();
    // ...but its clock must still be there, carrying the tombstone. Without this
    // the client has no timestamp for a replayed add_recipe to lose against.
    const clock = snapshot!.meta[`addition:${additionId}`];
    expect(clock).toBeDefined();
    expect(clock.deleted).toBe(true);

    await db.delete(recipeAdditions).where(eq(recipeAdditions.id, additionId));
  });

  it("marks a tombstoned entry as deleted in its clock too", async () => {
    const item = `${catalogItemId}-tombstone-meta`;
    await seedItem(item);

    await applyOpToDatabase(
      op("add_item", "2026-06-01T00:00:00.000Z", { listId, catalogItemId: item }),
      ACTOR,
    );
    await applyOpToDatabase(
      op("remove_item", "2026-06-01T01:00:00.000Z", {
        listId,
        catalogItemId: item,
        bought: false,
      }),
      ACTOR,
    );

    const snapshot = await loadListSnapshot(listId, new Date());
    const clock = snapshot!.meta[`entry:${entryId(listId, item)}`];
    expect(clock).toBeDefined();
    // Harmless while nothing prunes client-side, and a resurrection bug the
    // moment anything does — the same shape already fixed once for writeEntry.
    expect(clock.deleted).toBe(true);
  });
});

describe("seed corrections versus household edits", () => {
  /**
   * The seed runs on every server boot in production (src/instrumentation.ts)
   * and overwrites name, name_norm, category_id and icon_ref — exactly the
   * columns the item registry makes editable. So without a guard, every deploy
   * and every container restart silently reverts every rename and re-filing the
   * household has done, in production only, with no error anywhere.
   *
   * Tested rather than reasoned about precisely because of that failure profile:
   * it cannot be noticed in development, where the seed and the edit are rarely
   * more than minutes apart.
   */
  /**
   * One row per test, not one shared row.
   *
   * These tests deliberately leave rows in opposite states — one seed-owned, one
   * human-edited — so sharing a row makes each test's outcome depend on the
   * previous one's. That is exactly the coupling the fixture comment above warns
   * about for lists.
   */
  function seedFixture(tag: string) {
    const name = `Test Seed Vara ${tag} ${RUN}`;
    const id = `test-seed-vara-${tag}-${RUN}`;
    return {
      id,
      seeded: { name, categorySlug: "frukt-gront", iconRef: "1F34E" },
    };
  }

  it("corrects a row nobody has touched", async () => {
    const { id: seededId, seeded } = seedFixture("untouched");
    await upsertSeedCatalogItem(seeded);
    extraItems.push(seededId);

    // A later deploy re-files it and gives it a better icon. NOT a rename:
    // the id is slugify(name), so changing the name in seed data produces a
    // NEW row rather than a conflict — which means the `name`/`name_norm` in the
    // upsert's `set:` can only ever differ by case or diacritics.
    await upsertSeedCatalogItem({
      ...seeded,
      categorySlug: "mejeri-agg",
      iconRef: "1F95B",
    });

    const [row] = await db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.id, seededId));
    expect(row.categoryId).toBe("mejeri-agg");
    expect(row.iconRef).toBe("1F95B");
    expect(row.updatedBy).toBe(SEED_ACTOR);
  });

  it("leaves a row the household has edited alone, forever", async () => {
    const { id: seededId, seeded } = seedFixture("edited");
    await upsertSeedCatalogItem(seeded);
    extraItems.push(seededId);

    // The household re-files it. applyOpToDatabase stamps the AUTHENTICATED
    // actor, which is what makes updated_by trustworthy as the discriminator.
    // The timestamp has to POSTDATE the seed's insert, which stamps
    // `updated_at = now()`. An edit dated earlier loses the LWW comparison and
    // is silently dropped — which is correct behaviour, and the reason a fixed
    // past date made this test fail in a way that looked like the guard being
    // broken. In production this is a non-issue: real edits happen after boot.
    await applyOpToDatabase(
      op("update_catalog_item", "2099-01-01T00:00:00.000Z", {
        itemId: seededId,
        patch: { name: "Vår egen benämning", categoryId: "skafferi" },
      }),
      ACTOR,
    );

    // Two more deploys try to correct it.
    await upsertSeedCatalogItem({ ...seeded, categorySlug: "dryck" });
    await upsertSeedCatalogItem({ ...seeded, iconRef: "1F37A" });

    const [row] = await db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.id, seededId));
    expect(row.name).toBe("Vår egen benämning");
    expect(row.categoryId).toBe("skafferi");
    expect(row.iconRef).toBe(seeded.iconRef);
    expect(row.updatedBy).toBe(ACTOR);
  });

  it("still corrects an item that has only been bought, never edited", async () => {
    const { id: seededId, seeded } = seedFixture("bought");
    await upsertSeedCatalogItem(seeded);
    extraItems.push(seededId);

    await applyOpToDatabase(
      op("add_item", "2026-07-02T00:00:00.000Z", { listId, catalogItemId: seededId }),
      ACTOR,
    );
    await applyOpToDatabase(
      op("remove_item", "2026-07-02T01:00:00.000Z", {
        listId,
        catalogItemId: seededId,
        bought: true,
      }),
      ACTOR,
    );

    await upsertSeedCatalogItem({ ...seeded, categorySlug: "dryck" });

    const [row] = await db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.id, seededId));
    // Buying bumps use_count through a direct UPDATE that never touches
    // updated_by. That is load-bearing, not incidental: if a purchase stamped
    // the actor, everything anyone had ever bought would freeze out of future
    // seed corrections.
    expect(row.categoryId).toBe("dryck");
    expect(row.useCount).toBeGreaterThan(0);
  });
});
