import {
  catalogTile,
  entriesInIndexedDb,
  expect,
  onListTile,
  outboxSize,
  purchaseCount,
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
  // It lives in the "Att handla" heading rather than in a toast, so it cannot
  // end up covering the buttons of a sheet opened over it.
  const undo = page.getByRole("button", { name: /^Ångra/ });
  await expect(undo).toBeVisible();

  // And it has to actually put the item back, not merely offer to.
  await undo.click();
  await expect(onListTile(page, "banan")).toBeVisible();
  await expect(undo).toHaveCount(0);
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

test("plan mode records no purchase; buy mode records exactly one", async ({
  freshPage: page,
  listId,
}) => {
  // The difference between the two modes is invisible on screen — the tile
  // leaves the zone either way — so this asserts against the purchases table,
  // which is the only place the difference exists.
  const modePill = page.getByRole("button", { name: /Byt till/ });
  await expect(modePill).toHaveText(/Planerar/);

  await catalogTile(page, "banan").click();
  await onListTile(page, "banan").click();
  await expect(onListTile(page, "banan")).toHaveCount(0);
  expect(await purchaseCount(listId)).toBe(0);

  await modePill.click();
  await expect(modePill).toHaveText(/Handlar/);

  await catalogTile(page, "banan").click();
  await onListTile(page, "banan").click();
  await expect(onListTile(page, "banan")).toHaveCount(0);
  await expect
    .poll(() => purchaseCount(listId), { timeout: 5000 })
    .toBe(1);

  // The mode survives a reload within the session — walking out of the recipe
  // screen and back mid-shop must not silently drop you into plan mode.
  await page.reload();
  await expect(page.getByRole("button", { name: /Byt till/ })).toHaveText(
    /Handlar/,
  );
});

test("buy mode's long-press escape hatch records no purchase", async ({
  freshPage: page,
  listId,
}) => {
  // Asserted, not assumed: if mode state ever leaked between tests this would
  // fail here rather than quietly exercising the wrong branch below.
  const modePill = page.getByRole("button", { name: /Byt till/ });
  await expect(modePill).toHaveText(/Planerar/);
  await modePill.click();
  await expect(modePill).toHaveText(/Handlar/);

  await catalogTile(page, "banan").click();

  const tile = onListTile(page, "banan");
  const box = await tile.boundingBox();
  if (!box) throw new Error("no tile");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();

  // In buy mode the sheet offers the plan-mode answer, so neither mode traps you.
  await page.getByRole("button", { name: "Köpte inte" }).click();
  await expect(onListTile(page, "banan")).toHaveCount(0);
  expect(await purchaseCount(listId)).toBe(0);
});

test("moving an item takes its amount with it and leaves this list", async ({
  freshPage: page,
  otherListId,
}) => {
  // The second list is created after the first render, so the client has not
  // heard of it yet — and with one list there is deliberately nowhere to move
  // to, so the affordance is absent. Reloading is the honest way to get the
  // household the test actually describes.
  await page.reload();
  await expect(page.getByText("Att handla")).toBeVisible();

  await page.getByLabel("Sök eller lägg till vara").fill("mjölk 2 l");
  await page.getByLabel("Sök eller lägg till vara").press("Enter");
  await expect(onListTile(page, "mjölk")).toContainText("2 l");

  const tile = onListTile(page, "mjölk");
  const box = await tile.boundingBox();
  if (!box) throw new Error("no tile");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();

  await page.getByRole("button", { name: "Flytta till annan lista" }).click();
  // Said before the choice, not after: what does not travel is invisible once
  // the move has happened.
  await expect(page.getByText("2 l följer med")).toBeVisible();
  await page.getByRole("button", { name: "E2E Andra" }).click();

  // The move must actually empty this list. The store holds one list's state
  // until a move writes an entry belonging to another, and that entry is LIVE —
  // unfiltered, the item went on rendering here exactly as before and the move
  // looked like it had done nothing.
  await expect(onListTile(page, "mjölk")).toHaveCount(0);

  // And it arrives at the other end with the quantity, which is the whole point:
  // this is the defect that made a moved item show up as "mjölk, some".
  await page.goto(`/?list=${otherListId}`);
  await expect(onListTile(page, "mjölk")).toContainText("2 l");
});
