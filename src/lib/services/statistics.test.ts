import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { catalogItems, products, purchases } from "@/db/schema";
import { loadStatistics } from "./statistics";

/**
 * The statistics screen, against the real database.
 *
 * A DB test rather than a pure one, because the whole risk here is in the SQL:
 * the attribution COALESCE, the LEFT join that must not become an INNER one,
 * and the window. None of that is reachable from a unit test, and all three
 * fail in the same direction — quietly under-counting rather than erroring.
 *
 * The scan-sourced rows are the ones that matter. A purchase made with the
 * scanner carries `{null, product}` and no vara at all, so a query that read
 * `purchases.catalog_item_id` directly would return a plausible number that
 * silently omitted every purchase made in a shop with the camera — which is
 * most of the real shopping this app exists for.
 */

const RUN = randomUUID().slice(0, 8);
const VARA = `test-stat-vara-${RUN}`;
const OTHER = `test-stat-other-${RUN}`;
const PLACED = `test-stat-prod-placed-${RUN}`;
const UNPLACED = `test-stat-prod-unplaced-${RUN}`;
const LIST = `test-stat-list-${RUN}`;

const NOW = new Date("2026-08-01T12:00:00.000Z");
/**
 * Wide enough to include RECENT (two days back) and to exclude ANCIENT, with
 * `NOW` pinned so the window is a fact about the fixture rather than about the
 * day the suite happens to run.
 */
const WINDOW_DAYS = 7;
const RECENT = new Date("2026-07-30T12:00:00.000Z");
const ANCIENT = new Date("2026-01-01T12:00:00.000Z");

function purchaseRow(
  n: number,
  row: {
    catalogItemId?: string | null;
    productId?: string | null;
    actor: string;
    at: Date;
  },
) {
  return {
    id: `test-stat-p-${RUN}-${n}`,
    catalogItemId: row.catalogItemId ?? null,
    productId: row.productId ?? null,
    listId: LIST,
    purchasedAt: row.at,
    actor: row.actor,
    clientOpId: `test-stat-op-${RUN}-${n}`,
  };
}

beforeAll(async () => {
  await db.insert(catalogItems).values(
    [VARA, OTHER].map((id) => ({
      id,
      name: id,
      nameNorm: id,
      categoryId: "frukt-gront",
      iconRef: "1F34E",
      isCustom: true,
      nameUpdatedBy: "test-stat",
      categoryUpdatedBy: "test-stat",
      iconUpdatedBy: "test-stat",
      homeUpdatedBy: "test-stat",
      updatedBy: "test-stat",
    })),
  );

  await db.insert(products).values([
    {
      id: PLACED,
      name: PLACED,
      catalogItemId: VARA,
      createdBy: "test-stat",
      itemUpdatedBy: "test-stat",
      updatedBy: "test-stat",
    },
    {
      // Placed on nobody — the review-queue debt this screen has to admit to.
      id: UNPLACED,
      name: UNPLACED,
      catalogItemId: null,
      createdBy: "test-stat",
      updatedBy: "test-stat",
    },
  ]);

  await db.insert(purchases).values([
    // Tile taps: the vara is known because the vara was on the list.
    purchaseRow(1, { catalogItemId: VARA, actor: "anders", at: RECENT }),
    purchaseRow(2, { catalogItemId: VARA, actor: "jannica", at: RECENT }),
    purchaseRow(3, { catalogItemId: OTHER, actor: "anders", at: RECENT }),
    // A scan of a placed product: no vara on the row, and it must still count.
    purchaseRow(4, { productId: PLACED, actor: "anders", at: RECENT }),
    // A scan of a product nobody placed: counted only as debt.
    purchaseRow(5, { productId: UNPLACED, actor: "anders", at: RECENT }),
    // Outside any recent window.
    purchaseRow(6, { catalogItemId: VARA, actor: "jannica", at: ANCIENT }),
  ]);
});

afterAll(async () => {
  await db.delete(purchases).where(
    inArray(
      purchases.id,
      Array.from({ length: 6 }, (_, i) => `test-stat-p-${RUN}-${i + 1}`),
    ),
  );
  await db.delete(products).where(inArray(products.id, [PLACED, UNPLACED]));
  await db.delete(catalogItems).where(inArray(catalogItems.id, [VARA, OTHER]));
});

describe("loadStatistics", () => {
  /**
   * The assertion the whole module exists for: a scan counts.
   *
   * Four attributed purchases in the window — two tile taps on VARA, one on
   * OTHER, and one SCAN of a product placed on VARA. Read without the COALESCE
   * the scan vanishes and the answer is a believable three.
   */
  it("counts a scan-sourced purchase through its product", async () => {
    const stats = await loadStatistics(WINDOW_DAYS, NOW);
    const vara = stats.topVaror.find((v) => v.catalogItemId === VARA);
    expect(vara?.purchases).toBe(3);
  });

  it("leaves an unplaced product's purchases out of the counts, and says so", async () => {
    const stats = await loadStatistics(WINDOW_DAYS, NOW);
    // Present in the debt…
    expect(stats.unplacedPurchases).toBeGreaterThanOrEqual(1);
    // …and absent from every vara total, because there is no vara to add it to.
    const named = stats.topVaror.reduce((n, v) => n + v.purchases, 0);
    expect(named).toBeLessThanOrEqual(stats.totalPurchases);
    expect(
      stats.topVaror.some((v) => v.name === UNPLACED),
    ).toBe(false);
  });

  /**
   * Two people, distinct without a `users` table between them. The roster comes
   * from the actor Authelia already stamps on every row.
   */
  it("splits the count by who bought it", async () => {
    const stats = await loadStatistics(WINDOW_DAYS, NOW);
    const anders = stats.people.find((p) => p.actor === "anders");
    const jannica = stats.people.find((p) => p.actor === "jannica");
    // anders: VARA tap, OTHER tap, and the placed scan. jannica: one VARA tap.
    expect(anders?.purchases).toBeGreaterThanOrEqual(3);
    expect(jannica?.purchases).toBeGreaterThanOrEqual(1);
  });

  it("honours the window", async () => {
    const recent = await loadStatistics(WINDOW_DAYS, NOW);
    const all = await loadStatistics(null, NOW);
    const inWindow = recent.topVaror.find((v) => v.catalogItemId === VARA);
    const ever = all.topVaror.find((v) => v.catalogItemId === VARA);
    // The ANCIENT row is jannica's fourth VARA purchase, and only "all" sees it.
    expect(ever!.purchases).toBe(inWindow!.purchases + 1);
  });

  it("reports the most recent purchase of each vara", async () => {
    const stats = await loadStatistics(null, NOW);
    const vara = stats.topVaror.find((v) => v.catalogItemId === VARA);
    expect(new Date(vara!.lastPurchasedAt).getTime()).toBe(RECENT.getTime());
    expect(new Date(vara!.lastPurchasedAt).getTime()).toBeLessThan(
      NOW.getTime(),
    );
  });
});
