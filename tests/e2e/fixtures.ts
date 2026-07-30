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

async function createTestList(name = "E2E"): Promise<string> {
  const id = `e2e-${process.pid}-${++listSeq}`;
  const [{ categoryOrder }] = await sql<[{ categoryOrder: string[] }]>`
    select category_order as "categoryOrder" from lists where id = 'hemkop'
  `;
  await sql`
    insert into lists (id, name, icon, position, category_order, updated_by)
    values (${id}, ${name}, '1F6D2', 99, ${sql.json(categoryOrder ?? [])}, 'e2e')
  `;
  return id;
}

async function dropTestList(id: string) {
  await sql`delete from purchases where list_id = ${id}`;
  await sql`delete from lists where id = ${id}`; // entries cascade
  await sql`update catalog_items set use_count = 0, last_used_at = null`;
}

export const test = base.extend<
  {
    freshPage: Page;
    listId: string;
    otherListId: string;
  },
  { closeDb: void }
>({
  /**
   * Closing the pool, once per WORKER rather than once per file.
   *
   * This was a `test.afterAll`, and that was invisible until there was a second
   * spec file. A module-level hook registers into the suite of whichever file
   * imported the module first, so `sql.end()` ran the moment `list.spec.ts`
   * finished — and every later file got `write CONNECTION_ENDED` from its very
   * first fixture, which reads like a database problem and is not one.
   *
   * A worker-scoped auto fixture tears down when the worker does, which is
   * exactly when the connection is genuinely finished with. It has to exist at
   * all because postgres.js keeps an idle connection open and with it the event
   * loop, so a worker that never ends the pool never exits.
   */
  closeDb: [
    async ({}, use) => {
      await use();
      await sql.end();
    },
    { scope: "worker", auto: true },
  ],

  /**
   * Depends on `page` purely for the teardown ORDER, and that dependency is
   * load-bearing.
   *
   * Without it, teardown ran: drop the list, then close the page — and the page
   * is a live client with an outbox and an SSE reconnect loop. Anything it
   * posted in that window hit a list that no longer existed, so every full run
   * logged one `op refused by server` against a foreign key violation, on a
   * different op and a different test each time. It looked like a real sync bug
   * for a while; it was the harness pulling the table out from under the client.
   *
   * Closing the page first makes the teardown mean what it says: the client is
   * gone, so nothing can be in flight when the list goes.
   */
  listId: async ({ page }, use) => {
    const id = await createTestList();
    await use(id);
    await page.close();
    await dropTestList(id);
  },
  freshPage: async ({ page, listId }, use) => {
    await page.goto(`/?list=${listId}`);
    await expect(page.getByText("Att handla")).toBeVisible();
    await use(page);
    await settle(page);
  },
  /**
   * A second list, for the one thing that needs two: `move_item`.
   *
   * Depends on `freshPage` rather than on `page` so the ordering is decided
   * rather than incidental — it is set up last and so torn down first, while the
   * client is still alive. Hence the `settle` before the drop: a move op naming
   * this list arriving after the row is gone is a foreign key violation, which
   * is exactly the harness-induced "op refused by server" this suite already
   * spent a session mistaking for a sync bug.
   *
   * Opt-in, so the other tests keep seeing a household with a single list and
   * the move affordance stays absent from them.
   */
  otherListId: async ({ freshPage }, use) => {
    const id = await createTestList("E2E Andra");
    await use(id);
    await settle(freshPage);
    await dropTestList(id);
  },
});

/**
 * Wait for the client to stop having anything to say.
 *
 * Every assertion in this suite passes on the OPTIMISTIC state — that is the
 * app's whole design, and testing it any other way would be testing something
 * else. But it means a test can finish while its ops are still in flight, and
 * teardown then drops the list out from under a POST the server has already
 * accepted: `insert or update on table "list_entries" violates foreign key
 * constraint`, logged once per run against a different op each time. It read
 * like an intermittent sync bug for a while. It was the harness.
 *
 * Best-effort on purpose. A test that deliberately ends offline still has a full
 * outbox, and making that a failure would break the tests this app most needs.
 */
async function settle(page: Page, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await outboxSize(page)) === 0) return;
    } catch {
      // Page already closing, or IndexedDB gone. Nothing left to drain.
      return;
    }
    await page.waitForTimeout(50);
  }
}

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
