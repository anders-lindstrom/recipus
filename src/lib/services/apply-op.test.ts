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
} from "@/db/schema";
import { entryId, manualContributionId } from "@/lib/domain";
import type { Op } from "@/lib/sync";
import { applyOpToDatabase } from "./apply-op";

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
  await db.delete(purchases).where(eq(purchases.catalogItemId, catalogItemId));
  await db
    .delete(opsTable)
    .where(inArray(opsTable.actor, [ACTOR]));
  await db.delete(listEntries).where(eq(listEntries.listId, listId));
  await db.delete(catalogItems).where(eq(catalogItems.id, catalogItemId));
  await db.delete(lists).where(eq(lists.id, listId));
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
