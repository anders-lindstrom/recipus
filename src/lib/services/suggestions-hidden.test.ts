import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { catalogItems, purchases } from "@/db/schema";
import { loadSuggestions } from "./list-data";

/**
 * A hidden vara must not be suggested, against the real database.
 *
 * The row is the most unprompted surface in the app, and it was the only offer
 * that ignored `hidden` — so hiding a vara silenced it everywhere except the
 * place that pushes hardest, and a day-scoped dismissal could not cover the gap.
 *
 * Both fixtures are given the SAME purchase history, so the only difference
 * between them is the flag. Without that, a passing test would not distinguish
 * "hidden was filtered" from "it never qualified".
 */

const RUN = randomUUID().slice(0, 8);
const LIST = `test-hidden-list-${RUN}`;
const VISIBLE = `test-hidden-visible-${RUN}`;
const HIDDEN = `test-hidden-hidden-${RUN}`;

const NOW = new Date("2026-08-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** Eight purchases seven days apart, the last six days ago: confidently due. */
const OFFSETS = [55, 48, 41, 34, 27, 20, 13, 6];

function catalogRow(id: string, hidden: boolean) {
  return {
    id,
    name: id,
    nameNorm: id,
    categoryId: "frukt-gront",
    iconRef: "1F34E",
    isCustom: true,
    hidden,
    nameUpdatedBy: "test-hidden",
    categoryUpdatedBy: "test-hidden",
    iconUpdatedBy: "test-hidden",
    homeUpdatedBy: "test-hidden",
    hiddenUpdatedBy: "test-hidden",
    updatedBy: "test-hidden",
  };
}

beforeAll(async () => {
  await db
    .insert(catalogItems)
    .values([catalogRow(VISIBLE, false), catalogRow(HIDDEN, true)]);

  await db.insert(purchases).values(
    [VISIBLE, HIDDEN].flatMap((itemId) =>
      OFFSETS.map((days, n) => ({
        id: `test-hidden-p-${RUN}-${itemId}-${n}`,
        catalogItemId: itemId,
        productId: null,
        listId: LIST,
        purchasedAt: new Date(NOW.getTime() - days * DAY),
        actor: "test-hidden",
        clientOpId: `test-hidden-op-${RUN}-${itemId}-${n}`,
      })),
    ),
  );
});

afterAll(async () => {
  await db.delete(purchases).where(inArray(purchases.catalogItemId, [VISIBLE, HIDDEN]));
  await db.delete(catalogItems).where(inArray(catalogItems.id, [VISIBLE, HIDDEN]));
});

describe("loadSuggestions and hidden varor", () => {
  it("suggests a vara that is not hidden", async () => {
    const ids = (await loadSuggestions(LIST, [], new Set(), NOW)).map(
      (s) => s.catalogItemId,
    );
    // The control: identical history, so this is what the hidden one would do.
    expect(ids).toContain(VISIBLE);
    expect(ids).toContain(HIDDEN);
  });

  it("does not suggest a hidden vara", async () => {
    const ids = (
      await loadSuggestions(LIST, [], new Set([HIDDEN]), NOW)
    ).map((s) => s.catalogItemId);
    expect(ids).not.toContain(HIDDEN);
    // ...and hiding one thing does not silence the row.
    expect(ids).toContain(VISIBLE);
  });
});
