import { expect, test as base, type Page } from "@playwright/test";
import postgres from "postgres";

/**
 * Test isolation.
 *
 * These tests share one database and one browser origin, so without a reset
 * each run inherits whatever the last one left behind — and a test asserting
 * "citron is not on the list yet" passes or fails depending on what happened
 * an hour ago. Both stores get cleared: Postgres for the server's view, and
 * IndexedDB for the client's, since the whole point of this app is that the
 * client keeps its own copy.
 */

const sql = postgres(
  process.env.DATABASE_URL ??
    "postgres://recipus:recipus@localhost:5434/recipus",
  { max: 1 },
);

/**
 * Each test gets its own list.
 *
 * Sharing one list and resetting between tests is fragile in a way that cost me
 * real time: the client keeps its own copy in IndexedDB, so "clear the server"
 * and "clear the client" have to both land, in order, before the next page
 * load — and any gap shows up as a tile mysteriously missing or already on the
 * list. A fresh list id per test sidesteps the whole class: there is nothing to
 * reset because nothing is shared.
 */
let listSeq = 0;

async function createTestList(): Promise<string> {
  const id = `e2e-${process.pid}-${++listSeq}`;
  const [{ categoryOrder }] = await sql<[{ categoryOrder: string[] }]>`
    select category_order as "categoryOrder" from lists where id = 'hemkop'
  `;
  await sql`
    insert into lists (id, name, icon, position, category_order, updated_by)
    values (${id}, 'E2E', '1F6D2', 99, ${sql.json(categoryOrder ?? [])}, 'e2e')
  `;
  return id;
}

async function dropTestList(id: string) {
  await sql`delete from purchases where list_id = ${id}`;
  await sql`delete from lists where id = ${id}`; // entries cascade
  await sql`update catalog_items set use_count = 0, last_used_at = null`;
}

export const test = base.extend<{ freshPage: Page; listId: string }>({
  listId: async ({}, use) => {
    const id = await createTestList();
    await use(id);
    await dropTestList(id);
  },
  freshPage: async ({ page, listId }, use) => {
    await page.goto(`/?list=${listId}`);
    await expect(page.getByText("Att handla")).toBeVisible();
    await use(page);
  },
});

test.afterAll(async () => {
  await sql.end();
});

export { expect };

/**
 * How many purchases this list has recorded.
 *
 * The mode's entire justification is that a plan-time tap records nothing and a
 * shop-time tap records exactly one, and neither is visible on screen — the tile
 * leaves the zone either way. So the only honest assertion is against the table.
 */
export async function purchaseCount(listId: string): Promise<number> {
  const [{ count }] = await sql<[{ count: string }]>`
    select count(*)::text as count from purchases where list_id = ${listId}
  `;
  return Number(count);
}

/**
 * Locate a tile by its EXACT name.
 *
 * `:has-text()` is a substring match, so "tomat" also matches
 * "körsbärstomat" — which silently tested the wrong tile and produced a
 * failure that looked like a store bug.
 */
export function onListTile(page: Page, name: string) {
  return page.locator(
    `button[aria-pressed="true"]:has(:text-is("${name}"))`,
  );
}

export function catalogTile(page: Page, name: string) {
  return page
    .locator(`button[aria-pressed="false"]:has(:text-is("${name}"))`)
    .first();
}

/** Live entries as the client has them persisted, not as the server sees them. */
export async function entriesInIndexedDb(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("recipus");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const rows = await new Promise<
      Array<{ state?: { entries?: Record<string, { removedAt: string | null }> } }>
    >((res, rej) => {
      const rq = db.transaction("state", "readonly").objectStore("state").getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const entries = rows[0]?.state?.entries ?? {};
    return Object.entries(entries)
      .filter(([, e]) => e.removedAt === null)
      .map(([id]) => id);
  });
}

export async function outboxSize(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("recipus");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<number>((res, rej) => {
      const rq = db.transaction("outbox", "readonly").objectStore("outbox").getAll();
      rq.onsuccess = () => res(rq.result.length);
      rq.onerror = () => rej(rq.error);
    });
  });
}
