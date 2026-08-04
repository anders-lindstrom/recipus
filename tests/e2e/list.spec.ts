import type { Page } from "@playwright/test";
import {
  accessibleText,
  catalogTile,
  entriesInIndexedDb,
  expect,
  longPressTile,
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

test("a vara added from the well says so before it goes", async ({
  freshPage: page,
}) => {
  /**
   * Adding from the well used to say nothing at all — the tile vanished, and
   * the only confirmation was a tile arriving in "Att handla", which is off the
   * top of the screen for anyone scrolled down among the 341 varor. So the tile
   * holds its place for one beat, wearing the green that means "on the list"
   * everywhere else in this app, and then leaves.
   *
   * The assertion that matters is not that it is drawn — it is that what is
   * drawn is INERT. It is a picture of something that already happened, and a
   * second tap on it would be aimed at a control whose vara has moved.
   */
  await catalogTile(page, "gurka").click();

  // The tile you tapped, still drawn — and no longer a catalog tile, which is
  // what keeps it out of every locator in this suite. Its box is deliberately
  // not asserted: it is scaling while this runs, which is the point of it.
  const ghost = page.locator('[data-tile-grid] > button[aria-hidden="true"]');
  await expect(ghost).toHaveCount(1);
  await expect(ghost).toContainText("gurka");
  await expect(ghost).toHaveJSProperty("tabIndex", -1);

  // And it goes on its own, leaving one vara on the list rather than two taps'
  // worth. The tile is gone from the well for good.
  await expect(ghost).toHaveCount(0);
  await expect(onListTile(page, "gurka")).toHaveCount(1);
  await expect(catalogTile(page, "gurka")).toHaveCount(0);
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
  await expect(page.getByRole("option", { name: /räkor/ }).first()).toBeVisible();
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
  const modePill = page.getByRole("button", { name: /byt till/i });
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
  await expect(page.getByRole("button", { name: /byt till/i })).toHaveText(
    /Handlar/,
  );
});

test("buy mode's long-press escape hatch records no purchase", async ({
  freshPage: page,
  listId,
}) => {
  // Asserted, not assumed: if mode state ever leaked between tests this would
  // fail here rather than quietly exercising the wrong branch below.
  const modePill = page.getByRole("button", { name: /byt till/i });
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

test("the panel opens on what you buy most, and never drops the keyboard", async ({
  freshPage: page,
  listId,
}) => {
  const field = page.getByLabel("Sök eller lägg till vara");
  const panel = page.getByRole("group", { name: "Vanligast" });

  // A household with no shops behind it has no answer to "what do you buy
  // most", and offering the catalog's first six alphabetically would be a lie
  // dressed as help. Nothing opens.
  await field.click();
  await expect(panel).toHaveCount(0);

  // So give it one real shop. `use_count` is incremented by a purchase and by
  // nothing else — not by adding, not by tapping around — which is exactly what
  // lets the panel mean "what you buy" rather than "what you last touched".
  const modePill = page.getByRole("button", { name: /byt till/i });
  await modePill.click();
  await expect(modePill).toHaveText(/Handlar/);

  await catalogTile(page, "citron").click();
  await onListTile(page, "citron").click();
  await expect.poll(() => purchaseCount(listId), { timeout: 5000 }).toBe(1);

  await page.reload();
  await expect(page.getByText("Att handla")).toBeVisible();

  // Now focusing the field is worth the keyboard it costs.
  await field.click();
  const inPanel = panel.getByRole("button", { name: "citron" });
  await expect(inPanel).toBeVisible();
  await inPanel.click();

  // The two halves that make this a rapid-add surface rather than a menu, and
  // both are asserted before the panel is dismissed because both are about what
  // the panel does while it is still open.
  //
  // Focus never leaves the field, so the phone keyboard never animates shut and
  // open between varor — six things is one errand, not six. And the grid stays
  // put: the vara you just added turns green where it stands instead of leaving
  // and sliding the next one under a thumb already on its way to it.
  await expect(field).toBeFocused();
  await expect(panel).toBeVisible();
  await expect(inPanel).toHaveAttribute("aria-pressed", "true");

  // Only now is `onListTile` unambiguous: while the panel is open the same vara
  // is legitimately on screen twice, once in the grid and once in the zone.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(onListTile(page, "citron")).toBeVisible();
});

/**
 * The gesture that opens a sheet must not also act on it.
 *
 * Reported from production as "long pressing something, changing something, then
 * pressing out of the dialog modifies the thing behind it — marking something
 * bought while I just wanted to get out of the popover".
 *
 * The cause is one stray click. A touchscreen hit-tests the click a touch
 * synthesizes at the finger's position when it LIFTS, and by then the sheet the
 * long-press opened is sitting under that finger — so the press delivers a final
 * click into a surface that did not exist when it began. Where it lands is pure
 * geometry: on the backdrop the sheet shuts inside its own opening gesture, and
 * lower down the page it hits the action row and takes the item off the list.
 *
 * Only reproducible with real touch events. `page.mouse` sends its click to the
 * common ancestor of down and up, which is a container that does nothing — which
 * is exactly why the existing long-press tests never caught this.
 */
test("a long-press opens the breakdown, and its own click does not act on it", async ({
  freshPage: page,
}) => {
  await catalogTile(page, "banan").click();
  await expect(onListTile(page, "banan")).toBeVisible();

  await longPressTile(page, onListTile(page, "banan"));

  // Both halves. The sheet survived the gesture that opened it...
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("banan");
  // ...and the item is still on the list: no action row was pressed on the way.
  await expect(onListTile(page, "banan")).toHaveCount(1);
});

test("a click with no press behind it does nothing, however destructive the button", async ({
  freshPage: page,
  listId,
}) => {
  // The invariant stated directly, without depending on the sheet's height or on
  // where a tile happens to sit. A `click` that no `pointerdown` inside the sheet
  // preceded is the stray one, and it must be inert even when it is aimed at the
  // one control that empties the list.
  await catalogTile(page, "banan").click();
  await longPressTile(page, onListTile(page, "banan"));
  await expect(page.getByRole("dialog")).toBeVisible();

  const remove = page.getByRole("button", { name: "Ta bort" });
  await expect(remove).toBeVisible();
  await remove.dispatchEvent("click");

  await expect(onListTile(page, "banan")).toHaveCount(1);
  await expect(page.getByRole("dialog")).toBeVisible();

  // And the button still works when a real press asks for it — the guard must
  // not have made the sheet inert.
  await remove.click();
  await expect(onListTile(page, "banan")).toHaveCount(0);
  // "Ta bort" is the change-of-mind path, so it records no purchase.
  expect(await purchaseCount(listId)).toBe(0);
});

/** Is the thing with focus the dialog, or something inside it? */
async function focusInsideDialog(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return !!dialog && !!document.activeElement && dialog.contains(document.activeElement);
  });
}

/**
 * `aria-modal="true"` has to be true.
 *
 * The sheets declared themselves modal and then behaved like an ordinary div:
 * opening one left focus on the trigger, so a few Tabs later a screen-reader
 * user was reading the header behind the backdrop — a page the same markup had
 * just told them was unreachable. None of it is visible to anyone who does not
 * press Tab, which is why it survived twelve sheets and a design review.
 *
 * Driven from the keyboard throughout, because that is the only input this
 * behaviour exists for. The "Hoppa till" sheet is the one worth using here: it
 * opens on a plain click rather than a long-press, so the trigger keeps focus
 * and there is something real to hand it back to.
 */
test("a sheet takes focus, keeps it, and gives it back", async ({
  freshPage: page,
}) => {
  const trigger = page.getByRole("button", { name: "Alla avdelningar" });
  await trigger.focus();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect.poll(() => focusInsideDialog(page)).toBe(true);

  // Enough presses to walk off the end and round again — asked of the sheet
  // rather than hardcoded, since the aisle grid grows with the household's
  // categories and a fixed count would quietly stop testing the wrap.
  const stops = await dialog
    .locator('button, a[href], input, [tabindex]:not([tabindex="-1"])')
    .count();
  expect(stops).toBeGreaterThan(0);

  for (let i = 0; i < stops + 2; i++) {
    await page.keyboard.press("Tab");
    expect(await focusInsideDialog(page)).toBe(true);
  }
  // Backwards off the first stop is the other way out, and needs its own wrap.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await focusInsideDialog(page)).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Focus used to land on <body>, so the next Tab restarted from the top of the
  // document — several screens from what you were doing.
  await expect(trigger).toBeFocused();
});

/**
 * A sheet that opens onto a field has to still have it a moment later.
 *
 * Two different things could take it away, and on a real phone both did. React
 * honours `autoFocus` during the commit, so a trap that then claimed the dialog
 * unconditionally would shut the keyboard in the frame it opened. And the
 * long-press that opened the sheet synthesizes one last mousedown into it — the
 * quiet sibling of the stray click above — which moved focus to whatever sat
 * under the finger.
 *
 * So this is measured with a REAL touch. `page.mouse` passes it either way,
 * which is the same reason the stray-click bug went unnoticed for so long.
 */
test("a sheet that opens on a field keeps that field's focus", async ({
  freshPage: page,
}) => {
  // Long-pressing in the catalog is the one gesture that opens straight onto an
  // amount, and the sheet exists to be typed into: "två mogna bananer" is one
  // errand, not a sheet followed by a tap followed by a keyboard.
  await longPressTile(page, catalogTile(page, "banan"));
  await expect(page.getByRole("dialog")).toBeVisible();

  await expect(page.getByLabel("Mängd")).toBeFocused();
});

/**
 * How this shop is laid out, and how you want to read it.
 *
 * `lists.category_order` has been per-list since the first migration — Hemköp
 * and Bauhaus share the household's vocabulary and nothing about their layout —
 * but nothing in the app could edit it, so every list walked in seed order. That
 * falls hardest on exactly the varor a household invents, because the add bar
 * files anything new under Övrigt and Övrigt sorts last.
 *
 * The view is the other half and deliberately NOT the same kind of thing: the
 * order is a fact about a shop and syncs to everyone, the choice of headings is
 * a fact about a person and stays on the device.
 */
test("the walking order is editable per list, and survives a reload", async ({
  freshPage: page,
}) => {
  await page.getByRole("button", { name: "Vy och ordning" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("Ordning i E2E");

  // The order is stated as positions, so "first" is a claim the test can read
  // rather than infer from pixel geometry.
  const rows = sheet.locator("ul li");
  const [firstAisle, secondAisle] = (await accessibleText(rows))
    .slice(0, 2)
    .map((t) => t.replace(/^\d+/, "").trim());
  expect(firstAisle).not.toBe(secondAisle);

  await sheet
    .getByRole("button", { name: `Flytta ${secondAisle} tidigare` })
    .click();

  await expect(rows.first()).toContainText(secondAisle);
  await expect(rows.nth(1)).toContainText(firstAisle);

  // It is an ordinary `update_list` op, so it reaches the server and comes back.
  await expect.poll(() => outboxSize(page), { timeout: 8000 }).toBe(0);
  await page.reload();
  await expect(page.getByText("Att handla")).toBeVisible();
  await page.getByRole("button", { name: "Vy och ordning" }).click();
  await expect(page.getByRole("dialog").locator("ul li").first()).toContainText(
    secondAisle,
  );
});

test("the view choice turns aisle headings off without unsorting the list", async ({
  freshPage: page,
}) => {
  // Enough varo across enough aisles that "auto" would group them: the point of
  // the flat choice is that it overrides the count, and the point of the flat
  // VIEW is that it keeps the walk.
  const names = ["banan", "citron", "gurka", "tomat", "morot", "potatis", "lök", "vitlök", "äpple", "mjölk", "smör", "ost", "ägg"];
  for (const n of names) await catalogTile(page, n).click();
  for (const n of names) await expect(onListTile(page, n)).toHaveCount(1);

  // Thirteen items is past AISLE_GROUPING_THRESHOLD, so the zone grows headings.
  // The catalog well below is ALWAYS grouped, so the same aisle name legitimately
  // appears twice while the zone is grouped and once when it is not — which makes
  // the count the honest assertion here, not visibility.
  const dairy = page.getByRole("heading", { name: "Mejeri & ägg" });
  await expect(dairy).toHaveCount(2);

  await page.getByRole("button", { name: "Vy och ordning" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "En lång lista" }).click();
  await sheet.getByRole("button", { name: "Stäng" }).or(page.locator("body")).first().press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The zone's heading is gone; the well keeps its own.
  await expect(dairy).toHaveCount(1);
  // …and every item still there, in one grid.
  for (const n of names) await expect(onListTile(page, n)).toHaveCount(1);

  // The order is not "whatever the entry map produced": items from one aisle
  // stay adjacent. Milk, butter, cheese and eggs are all Mejeri & ägg, so their
  // positions in the flat grid must be consecutive.
  const positions = await accessibleText(
    page.locator('button[aria-pressed="true"]'),
  );
  const dairyIdx = ["mjölk", "smör", "ost", "ägg"]
    .map((n) => positions.findIndex((p) => p.startsWith(n)))
    .sort((a, b) => a - b);
  expect(dairyIdx[0]).toBeGreaterThanOrEqual(0);
  expect(dairyIdx[3] - dairyIdx[0]).toBe(3);
});
