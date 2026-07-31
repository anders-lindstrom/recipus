import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  recipes,
} from "@/db/schema";
import { entryId, manualContributionId } from "@/lib/domain";
import type { Op } from "@/lib/sync";
import {
  aliasKey,
  barcodeKey,
  catalogKey,
  productFieldKey,
  productKey,
} from "@/lib/sync";
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
/** The other shop. Only move_item needs two lists; everything else uses one. */
const otherListId = `test-apply-op-list-other-${RUN}`;
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
/**
 * The registry rows individual tests create, tracked for the same reason.
 *
 * Separate lists rather than one, because they have to be deleted in foreign-key
 * order: a barcode points at a product, an alias points at a vara.
 */
const extraProducts: string[] = [];
const extraEans: string[] = [];
const extraAliases: string[] = [];

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

/**
 * A product born the way a scan makes one: named, unplaced, nothing else known.
 *
 * `create_product` stamps all four field clocks, so anything a test does to it
 * afterwards has a genuine clock to lose against — which is the whole point of
 * the ordering tests below.
 */
async function seedProduct(
  id: string,
  at = "2026-01-01T00:00:00.000Z",
): Promise<void> {
  extraProducts.push(id);
  await applyOpToDatabase(
    op("create_product", at, {
      product: {
        id,
        name: id,
        brand: null,
        catalogItemId: null,
        defaultSize: null,
        sourceSizeText: null,
        imageUrl: null,
        createdAt: at,
        createdBy: ACTOR,
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
    op("create_list", "2026-01-01T00:00:00.000Z", {
      listId: otherListId,
      name: "Test (andra affären)",
      icon: "1F6D2",
      position: 998,
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
  // Scan-sourced purchases carry a product instead of a vara, so they are not
  // reached by the delete above.
  await db.delete(purchases).where(inArray(purchases.productId, extraProducts));
  await db
    .delete(opsTable)
    .where(inArray(opsTable.actor, [ACTOR]));
  await db
    .delete(listEntries)
    .where(inArray(listEntries.listId, [listId, otherListId]));
  await db.delete(barcodes).where(inArray(barcodes.ean, extraEans));
  await db
    .delete(catalogItemAliases)
    .where(inArray(catalogItemAliases.aliasNorm, extraAliases));
  // Before the catalog items, not after: this cascades to recipe_ingredients,
  // which reference catalog items without a cascade of their own — so a recipe
  // left standing makes the item delete below fail on a foreign key.
  await db.delete(recipes).where(inArray(recipes.id, extraRecipes));
  await db.delete(products).where(inArray(products.id, extraProducts));
  await db.delete(catalogItems).where(inArray(catalogItems.id, allItems));
  await db.delete(lists).where(inArray(lists.id, [listId, otherListId]));
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

describe("clearing an amount keeps its clock", () => {
  /**
   * The clock has to outlive the value it describes.
   *
   * Clearing both fields of a manual contribution used to DELETE its row, and
   * the row is where `amount_updated_at`/`_by` live. A missing clock is not "no
   * opinion", it is "anything wins" — `wins(op, undefined)` is true whatever the
   * op's timestamp says — so a stale `set_amount` arriving afterwards was
   * applied as though it were news.
   *
   * The divergence is permanent and silent. The clearing device keeps the clock
   * in its own meta, so the stale op loses there; the server has no clock, so it
   * wins there. Both are applying last-write-wins correctly against the facts
   * they hold, and nothing ever reconciles them: two phones showing different
   * quantities for the same item, with no error anywhere.
   */
  it("makes a stale set_amount lose against a clearing that already happened", async () => {
    const item = `${catalogItemId}-cleared-clock`;
    await seedItem(item);

    await applyOpToDatabase(
      op("set_amount", "2026-07-01T10:00:00.000Z", {
        listId,
        catalogItemId: item,
        amount: { value: 2, unit: "l" },
      }),
      ACTOR,
    );
    // Cleared at 12:00. The row now holds nothing but its clocks.
    await applyOpToDatabase(
      op("set_amount", "2026-07-01T12:00:00.000Z", {
        listId,
        catalogItemId: item,
        amount: null,
      }),
      ACTOR,
    );

    // A phone that was offline since 11:00 finally posts its op. It is OLDER
    // than the clearing, so it must lose — that is the whole point of the clock.
    await applyOpToDatabase(
      op("set_amount", "2026-07-01T11:00:00.000Z", {
        listId,
        catalogItemId: item,
        amount: { value: 99, unit: "l" },
      }),
      ACTOR,
    );

    const snapshot = await loadListSnapshot(listId, new Date());
    const cid = manualContributionId(entryId(listId, item));

    // The stale amount must NOT be back.
    const contribution = snapshot!.contributions.find((c) => c.id === cid);
    expect(contribution).toBeUndefined();

    // And the clock must still be readable by a hydrating client, still at the
    // clearing's timestamp — otherwise the same stale op wins on the next device
    // to hydrate, and the divergence just moves rather than being fixed.
    const clock = snapshot!.meta[`contribution:${cid}:amount`];
    expect(clock).toBeDefined();
    expect(clock.at).toBe("2026-07-01T12:00:00.000Z");
  });

  /**
   * The emptied row must not come back as a record.
   *
   * It exists only to carry the clocks. If either loader handed it to the
   * reducer as a contribution, the server would hold a record the client — running
   * the same ops through the same reducer — does not, which is the drift the
   * two-loaders-one-reducer design exists to prevent.
   */
  it("withholds the emptied row from the snapshot's records", async () => {
    const item = `${catalogItemId}-cleared-record`;
    await seedItem(item);

    await applyOpToDatabase(
      op("set_note", "2026-07-02T10:00:00.000Z", {
        listId,
        catalogItemId: item,
        note: "grön",
      }),
      ACTOR,
    );
    await applyOpToDatabase(
      op("set_note", "2026-07-02T11:00:00.000Z", {
        listId,
        catalogItemId: item,
        note: null,
      }),
      ACTOR,
    );

    const snapshot = await loadListSnapshot(listId, new Date());
    const cid = manualContributionId(entryId(listId, item));
    expect(snapshot!.contributions.find((c) => c.id === cid)).toBeUndefined();
    expect(snapshot!.meta[`contribution:${cid}:note`].at).toBe(
      "2026-07-02T11:00:00.000Z",
    );

    // The entry itself stays: "bread, amount unspecified" is a thing you want.
    const entry = snapshot!.entries.find((e) => e.catalogItemId === item);
    expect(entry?.removedAt).toBeNull();
  });

  /**
   * A recipe contribution with no amount is NOT an emptied row.
   *
   * "The recipe wants salt, quantity unstated" is an ordinary record and must
   * survive both loaders. Pinned because the withholding rule is a null check,
   * and the obvious way to write it catches this too.
   */
  it("keeps a recipe contribution that has no amount", async () => {
    const item = `${catalogItemId}-recipe-no-amount`;
    await seedItem(item);

    const recipeId = `${item}-recipe`;
    extraRecipes.push(recipeId);
    await db.insert(recipes).values({
      id: recipeId,
      title: "Saltkaka",
      servings: 4,
      servingsUnit: "portioner",
      createdBy: ACTOR,
      updatedBy: ACTOR,
    });

    const additionId = `${item}-addition`;
    await applyOpToDatabase(
      op("add_recipe", "2026-07-03T10:00:00.000Z", {
        listId,
        recipeId,
        recipeAdditionId: additionId,
        scaleFactor: 1,
        items: [{ catalogItemId: item, amount: null }],
      }),
      ACTOR,
    );

    const snapshot = await loadListSnapshot(listId, new Date());
    const contribution = snapshot!.contributions.find(
      (c) => c.recipeAdditionId === additionId,
    );
    expect(contribution).toBeDefined();
    expect(contribution!.amount).toBeNull();

    await db.delete(recipeAdditions).where(eq(recipeAdditions.id, additionId));
  });
});

describe("per-field clocks survive the database", () => {
  /**
   * The bug this whole split exists for, driven through Postgres rather than
   * the pure reducer.
   *
   * The reducer keeps its clocks in a map, so it converges on its own. What can
   * still go wrong is the round trip: the server rebuilds that map from columns,
   * and if two fields end up sharing a column — or falling back to one that
   * moves — the reconstruction is a state no client ever had.
   *
   * Two items, identical ops, opposite arrival orders. Anything that reads the
   * same clock for two different facts makes these disagree.
   */
  it("converges when a rename and a re-filing arrive in either order", async () => {
    const first = `${catalogItemId}-order-a`;
    const second = `${catalogItemId}-order-b`;
    await seedItem(first);
    await seedItem(second);

    const rename = (id: string) =>
      applyOpToDatabase(
        op("update_catalog_item", "2026-09-01T17:00:00.000Z", {
          itemId: id,
          patch: { name: "vispgrädde", nameNorm: "vispgradde" },
        }),
        ACTOR,
      );
    const refile = (id: string) =>
      applyOpToDatabase(
        op("update_catalog_item", "2026-09-01T14:00:00.000Z", {
          itemId: id,
          patch: { categoryId: "skafferi" },
        }),
        ACTOR,
      );

    // Newer rename first, then the older re-filing — the order that used to
    // lose the re-filing, because it lost to the rename's row-level clock.
    await rename(first);
    await refile(first);

    await refile(second);
    await rename(second);

    const snapshot = await loadListSnapshot(listId, new Date());
    const read = (id: string) => {
      const c = snapshot!.catalog.find((x) => x.id === id)!;
      return { name: c.name, nameNorm: c.nameNorm, categoryId: c.categoryId };
    };

    expect(read(first)).toEqual(read(second));
    // And both edits actually stuck, rather than converging on having lost both.
    expect(read(first)).toEqual({
      name: "vispgrädde",
      nameNorm: "vispgradde",
      categoryId: "skafferi",
    });
  });

  /**
   * The same failure, one layer down, in the clocks that already existed.
   *
   * `amount_updated_at`/`note_updated_at` were nullable and fell back to the
   * row's `updated_at` when unset — and the row clock moves whenever EITHER
   * field is written. So setting the amount at 05:00 silently advanced the
   * note's clock to 05:00, and a note genuinely written at 03:00 arriving
   * afterwards lost a comparison it should have won. In one arrival order only.
   *
   * Reproduced by execution before the fix: order A dropped the note, order B
   * kept it. A fallback that moves is not a default, it is a second clock nobody
   * declared.
   */
  it("converges when an amount and an older note arrive in either order", async () => {
    const first = `${catalogItemId}-fields-a`;
    const second = `${catalogItemId}-fields-b`;
    await seedItem(first);
    await seedItem(second);

    const setAmount = (id: string) =>
      applyOpToDatabase(
        op("set_amount", "2026-09-02T05:00:00.000Z", {
          listId,
          catalogItemId: id,
          amount: { value: 5, unit: "dl" },
        }),
        ACTOR,
      );
    const setNote = (id: string) =>
      applyOpToDatabase(
        op("set_note", "2026-09-02T03:00:00.000Z", {
          listId,
          catalogItemId: id,
          note: "helst ekologisk",
        }),
        ACTOR,
      );

    await setAmount(first);
    await setNote(first);

    await setNote(second);
    await setAmount(second);

    const snapshot = await loadListSnapshot(listId, new Date());
    const read = (id: string) => {
      const cid = manualContributionId(entryId(listId, id));
      const c = snapshot!.contributions.find((x) => x.id === cid);
      return { amount: c?.amount ?? null, note: c?.note ?? null };
    };

    expect(read(first)).toEqual(read(second));
    expect(read(first)).toEqual({
      amount: { value: 5, unit: "dl" },
      note: "helst ekologisk",
    });
  });

  /**
   * The seed guard has to keep working after a field edit.
   *
   * It refuses to overwrite a row whose `updated_by` is no longer the seed
   * actor, so if a per-field write stopped stamping the row-level columns, a
   * household rename would leave `updated_by = 'system'` and the next deploy
   * would quietly revert it — in production only, with no error. That is exactly
   * the failure profile the guard was written for, so the interaction is
   * asserted rather than assumed.
   */
  it("stamps the row clock so the seed guard still sees a human edit", async () => {
    const item = `${catalogItemId}-seed-guard`;
    await seedItem(item);

    await applyOpToDatabase(
      op("update_catalog_item", "2026-09-03T09:00:00.000Z", {
        itemId: item,
        patch: { hasAtHome: true },
      }),
      ACTOR,
    );

    const [row] = await db
      .select({ updatedBy: catalogItems.updatedBy, updatedAt: catalogItems.updatedAt })
      .from(catalogItems)
      .where(eq(catalogItems.id, item));

    expect(row.updatedBy).toBe(ACTOR);
    // Derived as the latest of the field clocks, so it reflects the edit rather
    // than whichever op happened to be written last.
    expect(row.updatedAt.toISOString()).toBe("2026-09-03T09:00:00.000Z");
  });

  /**
   * Buying something must not be undone by a catalog edit landing afterwards.
   *
   * `use_count` is incremented atomically by the purchase path. The catalog
   * writer used to rewrite it from an absolute value loaded earlier in the
   * transaction, which is a lost update rather than a conflict — last-write-wins
   * has nothing useful to say about a counter.
   */
  it("does not roll back a purchase count when a field is edited", async () => {
    const item = `${catalogItemId}-counter`;
    await seedItem(item);

    await applyOpToDatabase(
      op("add_item", "2026-09-04T09:00:00.000Z", { listId, catalogItemId: item }),
      ACTOR,
    );
    await applyOpToDatabase(
      op("remove_item", "2026-09-04T10:00:00.000Z", {
        listId,
        catalogItemId: item,
        bought: true,
      }),
      ACTOR,
    );

    await applyOpToDatabase(
      op("update_catalog_item", "2026-09-04T11:00:00.000Z", {
        itemId: item,
        patch: { iconRef: "1F9C0" },
      }),
      ACTOR,
    );

    const [row] = await db
      .select({ useCount: catalogItems.useCount, iconRef: catalogItems.iconRef })
      .from(catalogItems)
      .where(eq(catalogItems.id, item));

    expect(row.iconRef).toBe("1F9C0");
    expect(row.useCount).toBe(1);
  });
});

describe("priority and modifiers survive the database", () => {
  /**
   * Priority must not ride the entry's own clock through the round trip.
   *
   * The entry row's `updated_at` moves on every add and removal, so if priority
   * fell back to it, tapping a tile would silently outrank a genuine priority
   * edit — and only in one arrival order, which is the shape that leaves two
   * devices disagreeing with no error anywhere.
   */
  it("converges when a removal and a newer priority arrive in either order", async () => {
    const first = `${catalogItemId}-prio-a`;
    const second = `${catalogItemId}-prio-b`;
    await seedItem(first);
    await seedItem(second);

    const add = (id: string) =>
      applyOpToDatabase(
        op("add_item", "2026-10-01T08:00:00.000Z", { listId, catalogItemId: id }),
        ACTOR,
      );
    const remove = (id: string) =>
      applyOpToDatabase(
        op("remove_item", "2026-10-01T09:00:00.000Z", {
          listId,
          catalogItemId: id,
          bought: false,
        }),
        ACTOR,
      );
    const urgent = (id: string) =>
      applyOpToDatabase(
        op("set_priority", "2026-10-01T11:00:00.000Z", {
          listId,
          catalogItemId: id,
          priority: "urgent",
        }),
        ACTOR,
      );

    await add(first);
    await remove(first);
    await urgent(first);

    await add(second);
    await urgent(second);
    await remove(second);

    const snapshot = await loadListSnapshot(listId, new Date());
    const read = (id: string) => {
      const e = snapshot!.entries.find((x) => x.catalogItemId === id)!;
      return { priority: e.priority, removed: e.removedAt !== null };
    };

    expect(read(first)).toEqual(read(second));
    // The priority is newer than the removal, so it wins and the item is back.
    expect(read(first)).toEqual({ priority: "urgent", removed: false });
  });

  /**
   * Removal clears priority — and the clearing has to survive the round trip
   * too, or urgency comes back from the database after a reload.
   */
  it("clears priority on removal, through the snapshot", async () => {
    const item = `${catalogItemId}-prio-clear`;
    await seedItem(item);

    await applyOpToDatabase(
      op("set_priority", "2026-10-02T08:00:00.000Z", {
        listId,
        catalogItemId: item,
        priority: "urgent",
      }),
      ACTOR,
    );
    await applyOpToDatabase(
      op("remove_item", "2026-10-02T09:00:00.000Z", {
        listId,
        catalogItemId: item,
        bought: true,
      }),
      ACTOR,
    );
    await applyOpToDatabase(
      op("add_item", "2026-10-02T10:00:00.000Z", { listId, catalogItemId: item }),
      ACTOR,
    );

    const snapshot = await loadListSnapshot(listId, new Date());
    const entry = snapshot!.entries.find((e) => e.catalogItemId === item)!;
    expect(entry.removedAt).toBeNull();
    expect(entry.priority).toBe("normal");
  });

  /**
   * The third manual field needs its own column pair for the same reason the
   * first two did. Amount, note and modifier share a row; an older write to one
   * arriving after a newer write to another must not take the first down.
   */
  it("keeps all three manual fields whatever order they arrive in", async () => {
    const first = `${catalogItemId}-mod-a`;
    const second = `${catalogItemId}-mod-b`;
    await seedItem(first);
    await seedItem(second);

    const setAmount = (id: string) =>
      applyOpToDatabase(
        op("set_amount", "2026-10-03T09:00:00.000Z", {
          listId,
          catalogItemId: id,
          amount: { value: 2, unit: "kg" },
        }),
        ACTOR,
      );
    const setModifier = (id: string) =>
      applyOpToDatabase(
        op("set_modifier", "2026-10-03T07:00:00.000Z", {
          listId,
          catalogItemId: id,
          modifier: "mogna",
        }),
        ACTOR,
      );
    const setNote = (id: string) =>
      applyOpToDatabase(
        op("set_note", "2026-10-03T08:00:00.000Z", {
          listId,
          catalogItemId: id,
          note: "till smoothien",
        }),
        ACTOR,
      );

    await setAmount(first);
    await setNote(first);
    await setModifier(first);

    await setModifier(second);
    await setNote(second);
    await setAmount(second);

    const snapshot = await loadListSnapshot(listId, new Date());
    const read = (id: string) => {
      const cid = manualContributionId(entryId(listId, id));
      const c = snapshot!.contributions.find((x) => x.id === cid);
      return {
        amount: c?.amount ?? null,
        note: c?.note ?? null,
        modifier: c?.modifier ?? null,
      };
    };

    expect(read(first)).toEqual(read(second));
    expect(read(first)).toEqual({
      amount: { value: 2, unit: "kg" },
      note: "till smoothien",
      modifier: "mogna",
    });
  });
});

describe("move_item survives the database", () => {
  /**
   * The pure reducer converges on all of this on its own — it keeps its clocks
   * in a map. What breaks is the ROUND TRIP: the server rebuilds that map from
   * columns, and a move writes to two entries and two contribution rows at once,
   * which is more of the loader and the writer than any other op touches.
   *
   * Every data-loss bug in this codebase so far has been a clock that describes
   * something other than what it is compared against, and every one of them was
   * invisible to the pure reducer. So the move is driven through Postgres here.
   */
  const move = (
    itemId: string,
    at: string,
    carried: {
      priority?: string;
      manual?: {
        amount: { value: number; unit: string } | null;
        note: string | null;
        modifier: string | null;
      } | null;
    } = {},
  ) =>
    applyOpToDatabase(
      op("move_item", at, {
        fromListId: listId,
        toListId: otherListId,
        catalogItemId: itemId,
        priority: carried.priority ?? "normal",
        manual: carried.manual ?? null,
      }),
      ACTOR,
    );

  it("carries the whole entry across and leaves the source empty", async () => {
    const item = `${catalogItemId}-move`;
    await seedItem(item);

    await applyOpToDatabase(
      op("set_amount", "2026-11-01T08:00:00.000Z", {
        listId,
        catalogItemId: item,
        amount: { value: 5, unit: "dl" },
      }),
      ACTOR,
    );
    await applyOpToDatabase(
      op("set_note", "2026-11-01T08:10:00.000Z", {
        listId,
        catalogItemId: item,
        note: "helst ekologisk",
      }),
      ACTOR,
    );
    await applyOpToDatabase(
      op("set_modifier", "2026-11-01T08:20:00.000Z", {
        listId,
        catalogItemId: item,
        modifier: "vispgrädde",
      }),
      ACTOR,
    );
    await applyOpToDatabase(
      op("set_priority", "2026-11-01T08:30:00.000Z", {
        listId,
        catalogItemId: item,
        priority: "urgent",
      }),
      ACTOR,
    );

    await move(item, "2026-11-01T09:00:00.000Z", {
      priority: "urgent",
      manual: {
        amount: { value: 5, unit: "dl" },
        note: "helst ekologisk",
        modifier: "vispgrädde",
      },
    });

    const destination = await loadListSnapshot(otherListId, new Date());
    const arrived = destination!.entries.find((e) => e.catalogItemId === item)!;
    expect(arrived.removedAt).toBeNull();
    expect(arrived.priority).toBe("urgent");
    const carried = destination!.contributions.find(
      (c) => c.id === manualContributionId(entryId(otherListId, item)),
    )!;
    expect(carried.amount).toEqual({ value: 5, unit: "dl" });
    expect(carried.note).toBe("helst ekologisk");
    expect(carried.modifier).toBe("vispgrädde");

    const source = await loadListSnapshot(listId, new Date());
    const left = source!.entries.find((e) => e.catalogItemId === item)!;
    expect(left.removedAt).not.toBeNull();
    expect(left.priority).toBe("normal");
    expect(
      source!.contributions.find(
        (c) => c.id === manualContributionId(entryId(listId, item)),
      ),
    ).toBeUndefined();
  });

  /**
   * The clocks have to arrive with the values, at BOTH ends.
   *
   * A written value whose clock did not survive the round trip is not "no
   * opinion", it is "anything wins" — `wins(op, undefined)` is true whatever the
   * op's timestamp says. So a stale `set_amount` predating the move would land
   * unopposed on the destination, and would refill the source record the move
   * just emptied. Both directions are asserted, because the source row is the
   * one that has to survive EMPTIED rather than deleted, purely to keep its
   * clocks alive.
   */
  it("refuses writes that predate the move, at either end", async () => {
    const item = `${catalogItemId}-move-stale`;
    await seedItem(item);

    await applyOpToDatabase(
      op("set_amount", "2026-11-02T08:00:00.000Z", {
        listId,
        catalogItemId: item,
        amount: { value: 5, unit: "dl" },
      }),
      ACTOR,
    );
    await move(item, "2026-11-02T09:00:00.000Z", {
      manual: { amount: { value: 5, unit: "dl" }, note: null, modifier: null },
    });

    // Both queued while offline BEFORE the move, arriving after it.
    await applyOpToDatabase(
      op("set_amount", "2026-11-02T08:30:00.000Z", {
        listId: otherListId,
        catalogItemId: item,
        amount: { value: 99, unit: "l" },
      }),
      ACTOR,
    );
    await applyOpToDatabase(
      op("set_note", "2026-11-02T08:30:00.000Z", {
        listId,
        catalogItemId: item,
        note: "spöknotis",
      }),
      ACTOR,
    );

    const destination = await loadListSnapshot(otherListId, new Date());
    expect(
      destination!.contributions.find(
        (c) => c.id === manualContributionId(entryId(otherListId, item)),
      )!.amount,
    ).toEqual({ value: 5, unit: "dl" });

    const source = await loadListSnapshot(listId, new Date());
    expect(
      source!.contributions.find(
        (c) => c.id === manualContributionId(entryId(listId, item)),
      ),
    ).toBeUndefined();

    // The emptied source row itself must still be there — it is where the
    // clocks that refused those two writes live.
    const [row] = await db
      .select()
      .from(contributions)
      .where(eq(contributions.id, manualContributionId(entryId(listId, item))));
    expect(row).toBeDefined();
    expect(row.amountValue).toBeNull();
    expect(row.note).toBeNull();
    expect(row.amountUpdatedAt?.toISOString()).toBe("2026-11-02T09:00:00.000Z");
    expect(row.noteUpdatedAt?.toISOString()).toBe("2026-11-02T09:00:00.000Z");
  });

  /**
   * A move concerns two lists, and the op log routes on a single id. Logging it
   * against the destination meant a device with the SOURCE list open never
   * received it — neither live (src/api/routes/stream.ts filters on this) nor on
   * catch-up (`opsCatchUpWhere`) — so it went on showing the item at the old shop
   * indefinitely. Null is what both of those already treat as household-wide.
   */
  it("logs the op household-wide so the source list hears about it too", async () => {
    const item = `${catalogItemId}-move-fanout`;
    await seedItem(item);
    const { seq } = await move(item, "2026-11-03T09:00:00.000Z");

    const [row] = await db
      .select({ listId: opsTable.listId })
      .from(opsTable)
      .where(eq(opsTable.seq, seq));
    expect(row.listId).toBeNull();
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

describe("the registry survives the database", () => {
  /**
   * The reconstruction, not the reducer.
   *
   * The pure reducer already converges on every op in this block — that is
   * covered by src/lib/sync/reducer.test.ts. What has broken three times in this
   * codebase is the trip through Postgres: a clock written to the wrong column, a
   * clock falling back to one that moves, a record loaded while tombstoned. None
   * of those are visible without a real database, and every one of them looked
   * correct when reasoned about.
   */

  /**
   * Two products, identical ops, opposite arrival orders.
   *
   * A rename at 17:00 and a placing-on-a-vara at 14:00, which cross. With four
   * independent clocks both edits stick whichever way round they arrive. With a
   * shared clock — or with a field clock falling back to the row's `updated_at`,
   * which moves whenever ANY field is written — the placing loses in one order
   * and wins in the other, and the two products end up different. That is the
   * shape of every clock bug this file has already paid for.
   */
  it("converges when a product rename and an older placing arrive in either order", async () => {
    const vara = `${catalogItemId}-placed`;
    await seedItem(vara);
    const first = `test-apply-op-prod-order-a-${RUN}`;
    const second = `test-apply-op-prod-order-b-${RUN}`;
    await seedProduct(first);
    await seedProduct(second);

    const rename = (id: string) =>
      applyOpToDatabase(
        op("update_product", "2026-09-05T17:00:00.000Z", {
          productId: id,
          patch: { name: "Arla Mellanmjölk 1,5 l" },
        }),
        ACTOR,
      );
    const place = (id: string) =>
      applyOpToDatabase(
        op("update_product", "2026-09-05T14:00:00.000Z", {
          productId: id,
          patch: { catalogItemId: vara },
        }),
        ACTOR,
      );

    // Newer rename first, then the older placing — the order that loses the
    // placing the moment the two facts share a clock.
    await rename(first);
    await place(first);

    await place(second);
    await rename(second);

    const read = async (id: string) => {
      const [row] = await db.select().from(products).where(eq(products.id, id));
      return { name: row.name, catalogItemId: row.catalogItemId };
    };

    expect(await read(first)).toEqual(await read(second));
    // And both edits actually landed, rather than converging on having lost both.
    expect(await read(first)).toEqual({
      name: "Arla Mellanmjölk 1,5 l",
      catalogItemId: vara,
    });
  });

  /**
   * A product's clock columns are NULLABLE, and NULL has to keep meaning
   * "nobody has written this field".
   *
   * A product born from Open Food Facts genuinely has never had its mapping
   * asserted by anyone, which is why these columns differ from `catalog_items`'.
   * If the loader filled a NULL in from the row clock, OFF's guess would outrank
   * a human correction made on a phone whose clock sat behind the server's — the
   * moving-clock bug, arriving where it would be least visible.
   */
  it("lets any write land on a field whose clock column is NULL", async () => {
    const vara = `${catalogItemId}-null-clock`;
    await seedItem(vara);
    const id = `test-apply-op-prod-nullclock-${RUN}`;
    extraProducts.push(id);

    // Inserted directly, the way a future Open Food Facts import would: a row
    // that exists with no opinion recorded about any of its four facts. The row
    // clock is deliberately far in the future, so a fallback to it would swallow
    // the correction below.
    await db.insert(products).values({
      id,
      name: "OFF-namn",
      createdBy: ACTOR,
      createdAt: new Date("2050-01-01T00:00:00.000Z"),
      updatedAt: new Date("2050-01-01T00:00:00.000Z"),
      updatedBy: "off",
    });

    await applyOpToDatabase(
      op("update_product", "2026-09-06T09:00:00.000Z", {
        productId: id,
        patch: { catalogItemId: vara },
      }),
      ACTOR,
    );

    const [row] = await db.select().from(products).where(eq(products.id, id));
    expect(row.catalogItemId).toBe(vara);
    expect(row.itemUpdatedAt?.toISOString()).toBe("2026-09-06T09:00:00.000Z");
    // The facts the op said nothing about keep their NULL. Stamping them would
    // invent a history and beat a later op that actually changes them.
    expect(row.nameUpdatedAt).toBeNull();
    expect(row.brandUpdatedAt).toBeNull();
  });

  /**
   * Two EANs, one product, and both have to survive.
   *
   * This is the entire argument for a row per barcode rather than an array on the
   * product: last-write-wins on an array silently drops one of two concurrent
   * additions, and `wins()` has nothing useful to say about merging them.
   */
  it("keeps two different barcodes for one product", async () => {
    const id = `test-apply-op-prod-barcodes-${RUN}`;
    await seedProduct(id);
    const swedish = `test-apply-op-ean-se-${RUN}`;
    const norwegian = `test-apply-op-ean-no-${RUN}`;
    extraEans.push(swedish, norwegian);

    await applyOpToDatabase(
      op("link_barcode", "2026-09-07T10:00:00.000Z", {
        ean: swedish,
        productId: id,
        source: "manual",
      }),
      ACTOR,
    );
    await applyOpToDatabase(
      op("link_barcode", "2026-09-07T10:00:01.000Z", {
        ean: norwegian,
        productId: id,
        source: "off",
      }),
      ACTOR,
    );

    const rows = await db
      .select()
      .from(barcodes)
      .where(inArray(barcodes.ean, [swedish, norwegian]));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.productId === id)).toBe(true);
    expect(rows.find((r) => r.ean === swedish)?.source).toBe("manual");
    expect(rows.find((r) => r.ean === norwegian)?.source).toBe("off");
  });

  /**
   * A merge, end to end.
   *
   * The reducer does exactly two things — tombstone the merged-away vara, record
   * its word as an alias — and it must NEVER rewrite entry or contribution rows,
   * because that is what makes it converge (see the op's own comment in
   * sync/ops.ts). Everything else moves as a bounded server-side effect on the
   * same boundary purchases already sit on, so both halves are asserted here: the
   * rows that MUST move, and the entry that must NOT.
   */
  it("tombstones the vara, keeps the alias, and leaves the entries alone", async () => {
    const from = `${catalogItemId}-merge-from`;
    const to = `${catalogItemId}-merge-to`;
    const older = `${catalogItemId}-merge-older`;
    await seedItem(from);
    await seedItem(to);
    await seedItem(older);

    const olderAlias = `test-apply-op-alias-older-${RUN}`;
    const mergedAlias = `test-apply-op-alias-merged-${RUN}`;
    extraAliases.push(olderAlias, mergedAlias);

    // An earlier merge, so this one has an existing alias to re-point. A chain of
    // merges is the case where "leave the alias where it is" leaves a word
    // pointing at a vara that no longer exists.
    await applyOpToDatabase(
      op("merge_catalog_items", "2026-09-08T09:00:00.000Z", {
        fromItemId: older,
        toItemId: from,
        aliasNorm: olderAlias,
      }),
      ACTOR,
    );

    // A live entry on the merged-away vara, and the two kinds of history that
    // point at it.
    await applyOpToDatabase(
      op("add_item", "2026-09-08T09:30:00.000Z", { listId, catalogItemId: from }),
      ACTOR,
    );
    const purchaseId = `test-apply-op-purchase-merge-${RUN}`;
    await db.insert(purchases).values({
      id: purchaseId,
      catalogItemId: from,
      listId,
      purchasedAt: new Date("2026-09-08T09:40:00.000Z"),
      actor: ACTOR,
      clientOpId: randomUUID(),
    });
    const recipeId = `test-apply-op-recipe-merge-${RUN}`;
    extraRecipes.push(recipeId);
    await db.insert(recipes).values({
      id: recipeId,
      title: "Köttfärssås",
      servings: 4,
      servingsUnit: "portioner",
      createdBy: ACTOR,
      updatedBy: ACTOR,
    });
    await db.insert(recipeIngredients).values({
      id: `${recipeId}-1`,
      recipeId,
      position: 0,
      rawText: "500 g köttfärs",
      amountValue: 500,
      amountUnit: "g",
      catalogItemId: from,
    });

    const merge = (at: string) =>
      applyOpToDatabase(
        op("merge_catalog_items", at, {
          fromItemId: from,
          toItemId: to,
          aliasNorm: mergedAlias,
        }),
        ACTOR,
      );
    await merge("2026-09-08T10:00:00.000Z");

    const [merged] = await db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.id, from));
    expect(merged.deletedAt?.toISOString()).toBe("2026-09-08T10:00:00.000Z");

    const aliasRows = await db
      .select()
      .from(catalogItemAliases)
      .where(inArray(catalogItemAliases.aliasNorm, [olderAlias, mergedAlias]));
    expect(
      aliasRows.find((a) => a.aliasNorm === mergedAlias)?.catalogItemId,
    ).toBe(to);
    // Re-pointed rather than left aiming at a vara that no longer exists.
    expect(aliasRows.find((a) => a.aliasNorm === olderAlias)?.catalogItemId).toBe(
      to,
    );

    // The entry is the thing that must NOT move. A merge that rewrote it would
    // stop converging: a long-offline `add_item(from)` arriving afterwards leaves
    // an entry for `from` in one arrival order and for `to` in the other.
    const [entry] = await db
      .select()
      .from(listEntries)
      .where(eq(listEntries.id, entryId(listId, from)));
    expect(entry.catalogItemId).toBe(from);
    expect(entry.removedAt).toBeNull();

    // History does move, because it has no clock of its own to disagree with.
    const [purchase] = await db
      .select()
      .from(purchases)
      .where(eq(purchases.id, purchaseId));
    expect(purchase.catalogItemId).toBe(to);
    const [ingredient] = await db
      .select()
      .from(recipeIngredients)
      .where(eq(recipeIngredients.id, `${recipeId}-1`));
    expect(ingredient.catalogItemId).toBe(to);

    // Applying the same merge again must not double-apply anything. The op log
    // already short-circuits an identical clientOpId, so this is the layer below
    // that: the effect itself has to be safe to run a second time. Dated LATER on
    // purpose, so it genuinely wins its comparison and the effect really does run
    // twice — an op that merely lost would prove nothing about idempotence.
    await merge("2026-09-08T11:00:00.000Z");
    const [purchaseAgain] = await db
      .select()
      .from(purchases)
      .where(eq(purchases.id, purchaseId));
    expect(purchaseAgain.catalogItemId).toBe(to);

  });

  /**
   * A merge that LOST its comparison must re-point nothing.
   *
   * The case that makes the gate load-bearing rather than decorative: the vara
   * was RETIRED at 11:00, and a merge from a phone that had been in a drawer
   * turns up afterwards dated 09:00. The reducer refuses it — the tombstone is
   * newer — so on every client the history stays where it is. Without the same
   * refusal here, the server would quietly drag it onto a vara no winning op ever
   * chose, and nothing would ever correct it: an ordinary losing write is fixed
   * by the next op, but history carries no clock to lose with.
   */
  it("re-points nothing when the merge lost to a newer retirement", async () => {
    const stale = `${catalogItemId}-merge-stale`;
    const target = `${catalogItemId}-merge-stale-to`;
    await seedItem(stale);
    await seedItem(target);

    const purchaseId = `test-apply-op-purchase-stale-${RUN}`;
    await db.insert(purchases).values({
      id: purchaseId,
      catalogItemId: stale,
      listId,
      purchasedAt: new Date("2026-09-08T08:00:00.000Z"),
      actor: ACTOR,
      clientOpId: randomUUID(),
    });

    await applyOpToDatabase(
      op("delete_catalog_item", "2026-09-08T11:00:00.000Z", { itemId: stale }),
      ACTOR,
    );

    const staleAlias = `test-apply-op-alias-stale-${RUN}`;
    extraAliases.push(staleAlias);
    await applyOpToDatabase(
      op("merge_catalog_items", "2026-09-08T09:00:00.000Z", {
        fromItemId: stale,
        toItemId: target,
        aliasNorm: staleAlias,
      }),
      ACTOR,
    );

    const [purchase] = await db
      .select()
      .from(purchases)
      .where(eq(purchases.id, purchaseId));
    expect(purchase.catalogItemId).toBe(stale);
  });

  /**
   * The merged-away vara must not travel to a hydrating client as a record —
   * only as a clock.
   *
   * That distinction is the fix for a live resurrection bug already recorded in
   * DECISIONS.md: a missing clock is not "no opinion", it is *anything wins*,
   * because `wins(op, undefined)` is true whatever the op's timestamp says. So a
   * stale `create_catalog_item` replayed from an outbox would bring the merged
   * word straight back.
   */
  it("sends a tombstoned vara's clock without its record", async () => {
    const gone = `${catalogItemId}-deleted-vara`;
    await seedItem(gone);

    await applyOpToDatabase(
      op("delete_catalog_item", "2026-09-09T11:00:00.000Z", { itemId: gone }),
      ACTOR,
    );

    const snapshot = await loadListSnapshot(listId, new Date());
    expect(snapshot!.catalog.find((c) => c.id === gone)).toBeUndefined();
    expect(snapshot!.meta[catalogKey(gone)]).toEqual({
      at: "2026-09-09T11:00:00.000Z",
      by: ACTOR,
      deleted: true,
    });
  });

  /**
   * The registry has to arrive with the snapshot, or it is empty until an op
   * happens to turn up — and on a cold open in a shop, none will.
   *
   * The meta matters as much as the records: without the product's `item` clock,
   * a stale `update_product` replayed from an outbox has nothing to lose against
   * and silently re-places the product on whatever vara it last guessed.
   */
  it("hydrates products, aliases and barcodes with their clocks", async () => {
    const vara = `${catalogItemId}-hydrated`;
    await seedItem(vara);
    const id = `test-apply-op-prod-hydrate-${RUN}`;
    await seedProduct(id);
    const ean = `test-apply-op-ean-hydrate-${RUN}`;
    extraEans.push(ean);
    const alias = `test-apply-op-alias-hydrate-${RUN}`;
    extraAliases.push(alias);
    const aliasFrom = `${catalogItemId}-alias-source`;
    await seedItem(aliasFrom);

    await applyOpToDatabase(
      op("update_product", "2026-09-10T12:00:00.000Z", {
        productId: id,
        patch: { catalogItemId: vara, defaultSize: { value: 1.5, unit: "l" } },
      }),
      ACTOR,
    );
    await applyOpToDatabase(
      op("link_barcode", "2026-09-10T12:05:00.000Z", {
        ean,
        productId: id,
        source: "manual",
      }),
      ACTOR,
    );
    await applyOpToDatabase(
      op("merge_catalog_items", "2026-09-10T12:10:00.000Z", {
        fromItemId: aliasFrom,
        toItemId: vara,
        aliasNorm: alias,
      }),
      ACTOR,
    );

    const snapshot = await loadListSnapshot(listId, new Date());

    const product = snapshot!.products.find((p) => p.id === id);
    expect(product?.catalogItemId).toBe(vara);
    expect(product?.defaultSize).toEqual({ value: 1.5, unit: "l" });
    expect(snapshot!.meta[productKey(id)]).toBeDefined();
    expect(snapshot!.meta[productFieldKey(id, "item")]).toEqual({
      at: "2026-09-10T12:00:00.000Z",
      by: ACTOR,
    });
    // Its own column, not the row's. The row clock moved when the barcode and
    // the size were written; the mapping's did not.
    expect(snapshot!.meta[productFieldKey(id, "size")]?.at).toBe(
      "2026-09-10T12:00:00.000Z",
    );

    expect(snapshot!.barcodes.find((b) => b.ean === ean)).toEqual({
      ean,
      productId: id,
      source: "manual",
    });
    expect(snapshot!.meta[barcodeKey(ean)]).toEqual({
      at: "2026-09-10T12:05:00.000Z",
      by: ACTOR,
    });

    expect(
      snapshot!.aliases.find((a) => a.aliasNorm === alias)?.catalogItemId,
    ).toBe(vara);
    expect(snapshot!.meta[aliasKey(alias)]).toEqual({
      at: "2026-09-10T12:10:00.000Z",
      by: ACTOR,
    });
  });
});

