import { expect, test as base, type Locator, type Page } from "@playwright/test";
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
  /**
   * The op log too, and this is not tidiness.
   *
   * Nothing deleted these, so they accumulated across every run this suite has
   * ever had — a thousand of them within a few days. Household-wide ops
   * (`list_id IS NULL`: catalog edits, the registry, and every `move_item`) are
   * delivered to EVERY list's catch-up from seq 0, so each new test's client
   * replayed the entire backlog before its own snapshot landed. That is slow,
   * it gets slower forever, and it made hydrate lose races it should win.
   *
   * It also hid a bug: those replayed `move_item` ops create entries on lists the
   * client is not looking at, and a locator matching an item by NAME happily
   * matched one of those instead of the entry under test.
   *
   * Scoped to the e2e actor rather than to this list, because the ops worth
   * removing are exactly the ones no list owns.
   */
  await sql`delete from ops where actor = 'e2e'`;
}

/**
 * Remove varor a test invented, along with everything pointing at them.
 *
 * `delete_catalog_item` is a SOFT delete — deliberately, so a stale create from a
 * phone in a drawer loses instead of resurrecting the vara — which makes it the
 * wrong tool for teardown: tombstoning is invisible to the app but leaves the row
 * behind forever, and a suite run a few hundred times would quietly accumulate
 * thousands of them. So the harness reaches past the op log, exactly as
 * `dropTestList` does, and takes the rows out.
 *
 * The dependants are deleted by hand rather than left to cascades, because the
 * interesting ones do not cascade: a product's mapping to a vara is a plain FK,
 * and a test that placed one would otherwise fail teardown with a constraint
 * violation that looks like a bug in the registry.
 */
export async function dropCatalogItems(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await sql`delete from purchases where product_id in (select id from products where catalog_item_id in ${sql(ids)})`;
  await sql`delete from products where catalog_item_id in ${sql(ids)}`;
  await sql`delete from purchases where catalog_item_id in ${sql(ids)}`;
  await sql`delete from catalog_item_aliases where catalog_item_id in ${sql(ids)}`;
  await sql`delete from list_entries where catalog_item_id in ${sql(ids)}`;
  // Emptied rather than deleted: an ingredient line pointing at a vara is a
  // recipe's own row, and a test that borrowed the vara has no business taking
  // the line with it. Adding a recipe to a list now WRITES this mapping — see
  // the PATCH in src/api/routes/recipes.ts — so a vara a recipe has ever asked
  // for is a vara this delete could not remove until the pointer let go.
  await sql`update recipe_ingredients set catalog_item_id = null where catalog_item_id in ${sql(ids)}`;
  await sql`delete from catalog_items where id in ${sql(ids)}`;
}

/** Recipes a test invented, with the ingredient rows that hang off them. */
export async function dropRecipes(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await sql`delete from recipe_additions where recipe_id in ${sql(ids)}`;
  await sql`delete from recipes where id in ${sql(ids)}`; // ingredients cascade
}

/**
 * Give a few varor a shopping history.
 *
 * "Vanligast" is built from `use_count`, which counts SHOPS — and `dropTestList`
 * resets every one of them to zero between tests, deliberately, so a test that
 * bought something cannot decide what the next test is offered. The panel is
 * therefore empty on a fresh list, and a test about the panel has to say so out
 * loud. By name rather than by id: the ids are derived through `slugify`, and a
 * test naming derived keys is a test that breaks when the derivation changes.
 *
 * Takes effect on the next page load — the client gets the catalog in its
 * snapshot.
 */
export async function markFrequentlyBought(names: string[]): Promise<void> {
  if (names.length === 0) return;
  await sql`
    update catalog_items set use_count = 5, last_used_at = now()
    where name in ${sql(names)}
  `;
}

/**
 * What the server actually stored for a scanned barcode.
 *
 * Worth having as its own assertion because "the outbox drained" does NOT mean
 * "the server accepted it": a refused op is retried a bounded number of times
 * and then dropped, which empties the outbox exactly as success does. Asserting
 * on the drain alone would pass for an op the server threw away.
 */
export async function barcodeRow(
  ean: string,
): Promise<{ productId: string; catalogItemId: string | null } | null> {
  const rows = await sql<Array<{ productId: string; catalogItemId: string | null }>>`
    select b.product_id as "productId", p.catalog_item_id as "catalogItemId"
    from barcodes b join products p on p.id = b.product_id
    where b.ean = ${ean}
  `;
  return rows[0] ?? null;
}

/** Products a test created that never landed on one of its own varor. */
export async function dropProducts(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await sql`delete from purchases where product_id in ${sql(ids)}`;
  // Barcodes before products, because the pointer is the FK holder. Nothing in
  // this suite created a barcode link until the scan specs did, so this
  // omission was invisible rather than absent.
  await sql`delete from barcodes where product_id in ${sql(ids)}`;
  await sql`delete from products where id in ${sql(ids)}`;
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
 *
 * Two things here are load-bearing and were not:
 *
 * A read that THROWS is not evidence the outbox is empty. IndexedDB rejects
 * transiently while a navigation is in flight, and treating that as "nothing
 * left to drain" made this give up instantly at exactly the moment ops were most
 * likely to still be queued. It keeps polling now and only the deadline ends it.
 *
 * And the budget has to cover a real POST round trip. At 2s a slow one was
 * routinely still open when the list was dropped, which is what produced the
 * foreign-key errors this function exists to prevent — and worse, the failed
 * transactions delayed the NEXT test's ops enough to lose a race of its own.
 */
async function settle(page: Page, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await outboxSize(page)) === 0) return;
    } catch {
      // Transient — a navigation, or IndexedDB briefly unavailable. Not proof of
      // anything, so keep waiting rather than declaring victory.
      if (page.isClosed()) return;
    }
    await page.waitForTimeout(50);
  }
}

export { expect };

/**
 * A long-press made of REAL touch events, not `page.mouse`.
 *
 * The difference is not pedantry — it is the only way the sheet bug reproduces.
 * A mouse dispatches its click to the nearest common ancestor of where the
 * button went down and where it came up, so once a sheet has opened under the
 * cursor the click lands on some harmless container and evaporates. A touch does
 * not: it hit-tests the click at the finger's position when it LIFTS, which by
 * then is a sheet that was not on screen when the press began. So the press that
 * opens a sheet delivers one extra click straight into it, aimed at whichever
 * control now sits under that thumb — the backdrop, or "Ta bort".
 *
 * Every phone this app runs on is a touchscreen, so this is the honest input.
 * Dispatched over CDP because Playwright's `touchscreen.tap` cannot hold.
 */
export async function touchLongPress(
  page: Page,
  x: number,
  y: number,
  holdMs = 700,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }],
  });
  await page.waitForTimeout(holdMs);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
}

/** Long-press a locator by its centre, with a real touch. */
export async function longPressTile(
  page: Page,
  tile: ReturnType<Page["locator"]>,
): Promise<void> {
  await tile.scrollIntoViewIfNeeded();
  const box = await tile.boundingBox();
  if (!box) throw new Error("tile has no box to press");
  await touchLongPress(page, box.x + box.width / 2, box.y + box.height / 2);
}

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

/**
 * The text an accessible name is built from, per element.
 *
 * `textContent` is the obvious thing to reach for and it is the wrong one.
 * `ItemIcon` falls back to the system emoji as a real text node whenever the
 * OpenMoji sprite is missing — and it is ALWAYS missing in CI, because the
 * sprite is gitignored and only `pnpm icons:build` produces it. So a locally
 * green assertion on `textContent` reads "Bröd" on a laptop and "🍞Bröd" on
 * the runner, which is how two of these tests passed here and blocked a deploy
 * there.
 *
 * Dropping `aria-hidden` subtrees is not a workaround for that one fallback: it
 * is what the browser itself does when it computes an accessible name, so this
 * asserts on the string a screen reader is given rather than on the artwork
 * that happens to sit beside it.
 */
export async function accessibleText(locator: Locator): Promise<string[]> {
  return locator.evaluateAll((els) =>
    els.map((el) => {
      const clone = el.cloneNode(true) as HTMLElement;
      for (const hidden of clone.querySelectorAll("[aria-hidden='true']")) {
        hidden.remove();
      }
      return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
    }),
  );
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
