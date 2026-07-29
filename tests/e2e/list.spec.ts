import {
  catalogTile,
  entriesInIndexedDb,
  expect,
  onListTile,
  outboxSize,
  test,
} from "./fixtures";

/**
 * The core loop, end to end.
 *
 * These assert the behaviours that make this app worth using rather than the
 * ones that are easy to test: tapping is instant, a quantity survives the round
 * trip, and — the one that matters most — the list works with the network gone.
 */

test("tapping a catalog tile moves it onto the list", async ({ freshPage: page }) => {
  await catalogTile(page, "citron").click();

  await expect(onListTile(page, "citron")).toBeVisible();
  // And it leaves the catalog — showing it in both places would be two ways to
  // tap the same thing.
  await expect(catalogTile(page, "citron")).toHaveCount(0);
});

test("tapping an item on the list buys it and it can be undone", async ({
  freshPage: page,
}) => {
  await catalogTile(page, "banan").click();
  await expect(onListTile(page, "banan")).toBeVisible();

  await onListTile(page, "banan").click();
  await expect(onListTile(page, "banan")).toHaveCount(0);

  // The undo affordance is the safety valve for a one-tap destructive action.
  await expect(page.getByRole("button", { name: "Ångra" })).toBeVisible();
});

test("typing a quantity puts it on the tile", async ({ freshPage: page }) => {
  await page.getByLabel("Sök eller lägg till vara").fill("mjölk 2 l");
  await page.keyboard.press("Enter");

  const tile = onListTile(page, "mjölk");
  await expect(tile).toBeVisible();
  // The amount is the whole point — it must reach the tile, not just the store.
  await expect(tile).toContainText("2 l");
});

test("search folds Swedish diacritics", async ({ freshPage: page }) => {
  // Nobody reaches for ä while walking through a shop.
  await page.getByLabel("Sök eller lägg till vara").fill("rakor");
  await expect(page.getByRole("button", { name: /räkor/ }).first()).toBeVisible();
});

test("the list survives a reload, from IndexedDB", async ({ freshPage: page, listId }) => {
  await catalogTile(page, "gurka").click();
  await expect(onListTile(page, "gurka")).toBeVisible();
  await expect.poll(() => entriesInIndexedDb(page)).toContain(`${listId}:gurka`);

  await page.reload();
  await expect(onListTile(page, "gurka")).toBeVisible();
});

test("the offline banner appears when the server is unreachable", async ({
  freshPage: page,
  context,
}) => {
  // navigator.onLine alone is not enough: wifi can be perfectly healthy while
  // the home server is unreachable, and an indicator that says "online" then
  // is lying at exactly the moment you need to trust it.
  await expect(page.getByText(/Offline|väntar/)).toHaveCount(0);

  await context.setOffline(true);
  await catalogTile(page, "paprika").click();

  await expect(page.getByText(/Offline|väntar/).first()).toBeVisible();
});

test("the list works with the network gone, and drains on reconnect", async ({
  freshPage: page,
  listId,
  context,
}) => {
  // The requirement the whole design exists for: a shop basement.
  await context.setOffline(true);

  await catalogTile(page, "tomat").click();

  // The tap lands immediately — no spinner, no waiting on a round trip.
  await expect(onListTile(page, "tomat")).toBeVisible();
  await expect.poll(() => entriesInIndexedDb(page)).toContain(`${listId}:tomat`);
  // …and it is queued rather than lost.
  await expect.poll(() => outboxSize(page)).toBeGreaterThan(0);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  // The outbox drains itself; nothing in the UI has to ask.
  await expect.poll(() => outboxSize(page), { timeout: 20_000 }).toBe(0);
});
