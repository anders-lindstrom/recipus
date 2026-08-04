import {
  accessibleText,
  catalogTile,
  expect,
  markFrequentlyBought,
  onListTile,
  test,
} from "./fixtures";

/**
 * The app from a keyboard.
 *
 * The list screen is a touch surface first and always will be, but the list is
 * *filled* at a desk — planning the week, typing six things in a row — and that
 * half had no story at all. Measured before any of this: ArrowDown in the add
 * bar did nothing, Enter could only ever take the first match, the confirmation
 * strip's "Ångra" had no route to it, and Escaping out of any sheet that opens
 * onto a field dropped focus to `<body>`.
 *
 * These assert the routes rather than the implementation, so the widget can be
 * rebuilt as a real combobox later without rewriting them.
 */

const FIELD = "Sök eller lägg till vara";

/**
 * The vara a result row is offering, without its icon or its "på listan" chip.
 *
 * Read off the focused element rather than asserted against a fixed name: which
 * varor a household already has on its list decides what the rows say, and a
 * test that hard-codes one is asserting on the seed rather than on the widget.
 */
const focusedVara = () =>
  (document.activeElement?.textContent ?? "")
    .replace(/på listan|dold/g, "")
    .replace(/[^\p{L}\s-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

test("arrow keys walk the search results and Enter takes the highlighted one", async ({
  freshPage: page,
}) => {
  const field = page.getByLabel(FIELD);
  await field.click();
  await field.pressSequentially("bröd");

  const rows = page.getByRole("listbox", { name: "Sökträffar" }).getByRole("option");
  await expect(rows.first()).toBeVisible();
  const first = await page.evaluate(
    () =>
      (
        document
          .querySelector('ul[aria-label="Sökträffar"] [role="option"]')
          ?.textContent ?? ""
      )
        .replace(/på listan|dold/g, "")
        .replace(/[^\p{L}\s-]/gu, "")
        .trim(),
  );

  // Three presses down, so the row taken is emphatically not the first one —
  // which is the only row Enter could reach before any of this.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");

  const highlighted = await page.evaluate(focusedVara);
  expect(highlighted).not.toBe("");
  expect(highlighted).not.toBe(first);

  await page.keyboard.press("Enter");

  // The confirmation strip names what the press actually did, so it is the one
  // witness that cannot be confused by what was already on the list.
  await expect(
    page.getByText(new RegExp(`^${highlighted} (—|står redan)`)).first(),
  ).toBeVisible();
  await expect(onListTile(page, highlighted)).toBeVisible();
});

test("ArrowUp off the top of the results goes back to the field", async ({
  freshPage: page,
}) => {
  const field = page.getByLabel(FIELD);
  await field.click();
  await field.pressSequentially("bröd");

  await page.keyboard.press("ArrowDown");
  await expect(field).not.toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(field).toBeFocused();

  // Escape from a result row is the other way out, and must not also clear the
  // query — you are going back to type MORE of it.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("bröd");
});

test("the undo in the confirmation strip is reachable without a pointer", async ({
  freshPage: page,
}) => {
  const field = page.getByLabel(FIELD);
  await field.click();
  await field.pressSequentially("ananas");
  await page.keyboard.press("Enter");
  await expect(onListTile(page, "ananas")).toBeVisible();

  // The strip is the only thing left in the panel once the query has cleared,
  // so one press down is the whole journey.
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("button", { name: /^Ångra/ })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(onListTile(page, "ananas")).toHaveCount(0);
});

test("the panel does not outlive the focus that opened it", async ({
  freshPage: page,
}) => {
  const field = page.getByLabel(FIELD);
  await field.click();
  await field.pressSequentially("brö");
  await expect(page.getByRole("listbox", { name: "Sökträffar" })).toBeVisible();

  // Blur used to close the panel's own state and leave the suggestion list
  // rendered off the query alone — a full-width dropdown hanging over the list
  // until you came back and cleared the field.
  await field.blur();
  await expect(page.getByRole("listbox", { name: "Sökträffar" })).toHaveCount(0);
});

test("Escape gets out of the panel, one step at a time", async ({
  freshPage: page,
}) => {
  /**
   * The bug this pins down: Escape could not dismiss the panel AT ALL.
   *
   * The field's own handler blurred on an empty Escape, and the widget-wide
   * handler above it then asked whether the field still had focus — a question
   * about state the first handler had just changed — decided it did not, and
   * focused it back. Focusing the field opens the panel. So the "Vanligast" pane
   * survived any number of presses, which is how it was reported.
   *
   * Asserted as the whole escalation rather than as the one press, because the
   * steps only mean anything as a sequence: each Escape has to give up exactly
   * one thing, and the last one has to actually end.
   */
  await markFrequentlyBought(["banan", "citron", "gurka"]);
  await page.reload();
  await expect(page.getByText("Att handla")).toBeVisible();

  const field = page.getByLabel(FIELD);
  const frequent = page.getByRole("group", { name: "Vanligast" });
  const results = page.getByRole("listbox", { name: "Sökträffar" });

  await field.click();
  await expect(frequent).toBeVisible();
  await field.pressSequentially("citr");
  await expect(results).toBeVisible();

  // One: out of the results and back to the field. The panel stays — you are
  // still in the middle of the errand that opened it.
  await page.keyboard.press("ArrowDown");
  await expect(results.getByRole("option").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(field).toBeFocused();
  await expect(results).toBeVisible();

  // Two: gives up the query. What is left is what the panel opened as.
  await page.keyboard.press("Escape");
  await expect(field).toHaveValue("");
  await expect(frequent).toBeVisible();

  // Three: and out. This is the press that used to do nothing whatsoever.
  await page.keyboard.press("Escape");
  await expect(frequent).toHaveCount(0);
  await expect(field).not.toBeFocused();
});

test("Escape dismisses the confirmation strip left behind by an add", async ({
  freshPage: page,
}) => {
  // The same defect on the path a fresh household actually takes: no shopping
  // history, so nothing is offered until something is added — and the strip that
  // confirms the add is then the only thing holding the panel open.
  const field = page.getByLabel(FIELD);
  await field.click();
  await field.pressSequentially("ananas");
  await page.keyboard.press("Enter");
  await expect(onListTile(page, "ananas")).toBeVisible();

  const strip = page.getByText(/^ananas —/);
  await expect(strip).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(strip).toHaveCount(0);
  await expect(field).not.toBeFocused();
});

test("arrow keys walk the tiles instead of scrolling the page", async ({
  freshPage: page,
}) => {
  /**
   * The list from a keyboard, which Tab alone does not give you: the catalog
   * well runs to a few hundred tiles, so "the next tile" has to be one press in
   * the direction you mean rather than one press per tile in document order.
   *
   * Before this the arrows had no handler at all on this screen, so they did
   * what arrows do to a scroller — a tile could be focused and moving away from
   * you at the same time.
   */
  for (const vara of ["banan", "citron", "gurka"]) {
    const field = page.getByLabel(FIELD);
    await field.click();
    await field.pressSequentially(vara);
    await page.keyboard.press("Enter");
    await expect(onListTile(page, vara)).toBeVisible();
  }
  // Out of the add bar, so the panel is not over the list and its own arrow
  // handling is not the thing under test.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  const listed = page.locator('[data-tile-grid] > button[aria-pressed="true"]');
  await expect(listed).toHaveCount(3);

  // Relationally, never by name: what order the three sit in belongs to the
  // walking order and the priorities, and asserting on it here would be
  // asserting on something else entirely.
  const first = listed.nth(0);
  await first.focus();
  await page.keyboard.press("ArrowRight");
  await expect(listed.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(listed.nth(2)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(listed.nth(1)).toBeFocused();

  // No wrapping at the end of a row: ArrowLeft off the first tile has nowhere to
  // go, and must not take the page with it.
  await first.focus();
  const scrolled = await page.evaluate(() => window.scrollY);
  await page.keyboard.press("ArrowLeft");
  await expect(first).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);

  // Down out of the list lands in the next grid down the page — the sections are
  // not walls, because the stepping only knows about boxes.
  await page.keyboard.press("ArrowDown");
  await expect(first).not.toBeFocused();
  await expect(
    page.locator('[data-tile-grid] > button:focus'),
  ).toHaveCount(1);
});

test("Space hands focus to the next tile, so a run of them clears a row", async ({
  freshPage: page,
}) => {
  /**
   * The core loop, from a keyboard, more than once.
   *
   * Space takes the item off the list and the tile it was on stops existing, so
   * focus fell to `<body>` — where the arrows scroll the page again and the next
   * Space does nothing. Ticking off three things meant three journeys back in
   * with Tab, which is not a keyboard story, it is a keyboard demo.
   */
  for (const vara of ["banan", "citron", "gurka"]) {
    const field = page.getByLabel(FIELD);
    await field.click();
    await field.pressSequentially(vara);
    await page.keyboard.press("Enter");
    await expect(onListTile(page, vara)).toBeVisible();
  }
  await page.keyboard.press("Escape");

  const listed = page.locator('[data-tile-grid] > button[aria-pressed="true"]');
  await expect(listed).toHaveCount(3);
  // Whatever order the walking rank put them in — the run has to work on the
  // sequence the screen is actually showing, not on the one it was typed in.
  const order = await accessibleText(listed);

  await listed.nth(0).focus();
  await page.keyboard.press("Space");

  // The tile that slid into the gap now has focus, and is the next vara along.
  await expect(onListTile(page, order[0])).toHaveCount(0);
  expect(await page.evaluate(focusedVara)).toBe(order[1]);

  // …and the run continues without ever going back for the mouse.
  await page.keyboard.press("Space");
  await expect(onListTile(page, order[1])).toHaveCount(0);
  expect(await page.evaluate(focusedVara)).toBe(order[2]);

  await page.keyboard.press("Space");
  await expect(listed).toHaveCount(0);
});

test("a tap with a thumb leaves no focus ring behind on the next tile", async ({
  freshPage: page,
}) => {
  // The other half of the same rule: the hand-off is for keyboards only. Moving
  // focus after a touch would put a ring on a tile nobody chose, on the surface
  // where the ring means nothing at all.
  const field = page.getByLabel(FIELD);
  for (const vara of ["banan", "citron"]) {
    await field.click();
    await field.pressSequentially(vara);
    await page.keyboard.press("Enter");
    await expect(onListTile(page, vara)).toBeVisible();
  }
  await page.keyboard.press("Escape");

  const listed = page.locator('[data-tile-grid] > button[aria-pressed="true"]');
  const order = await accessibleText(listed);
  await listed.first().tap();

  await expect(onListTile(page, order[0])).toHaveCount(0);
  await expect(onListTile(page, order[1])).not.toBeFocused();
});

test("pressing away from the panel dismisses it without touching the list", async ({
  freshPage: page,
}) => {
  /**
   * "I pressed outside to get rid of the panel and it took an item off my
   * list." Blur closed the panel, so it LOOKED like a dismissal — but the press
   * carried on through to the tile underneath, and a tile is the one control on
   * this screen that both mutates the list and, in buy mode, records a purchase.
   *
   * The panel is opened here with nothing typed, which is the state it is in
   * when someone opens the field, changes their mind, and presses away.
   */
  await markFrequentlyBought(["banan", "citron", "gurka"]);
  await page.reload();

  const field = page.getByLabel(FIELD);
  const frequent = page.getByRole("group", { name: "Vanligast" });
  await field.click();
  await expect(frequent).toBeVisible();

  /**
   * A tile the panel is NOT covering, which is the only kind this can happen
   * to. A press inside the panel's own box lands on the panel and always did;
   * the tiles that took the stray press are the ones below it, and any tile far
   * enough down the page stands for all of them.
   */
  const tile = catalogTile(page, "ost");
  await tile.tap();

  await expect(frequent).toHaveCount(0);
  // The finding: "ost" used to be on the list now, put there by a press that
  // meant "go away".
  await expect(onListTile(page, "ost")).toHaveCount(0);

  // And the press after it works normally — one dismissal, not a mode.
  await tile.tap();
  await expect(onListTile(page, "ost")).toBeVisible();
});

test("Escape out of a sheet that opens onto a field returns focus to the trigger", async ({
  freshPage: page,
}) => {
  // Reached through search rather than through the catalog well, so the test
  // does not depend on which varor the household happens to have listed.
  const field = page.getByLabel(FIELD);
  await field.click();
  await field.pressSequentially("broccoli");
  await page.keyboard.press("ArrowDown");
  const row = await page.evaluate(focusedVara);
  expect(row).toContain("broccoli");

  // Shift+F10 is the keyboard's long-press — see `useLongPress`.
  await page.keyboard.press("Shift+F10");
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  /**
   * What this covers: the panel stayed mounted under the sheet. Tearing it down
   * on the blur into the dialog unmounts the row the sheet belongs to, and there
   * is then nothing connected to hand focus back to.
   *
   * It does NOT cover the focus trap's own half — Chrome declines `autoFocus`
   * on a text field under this suite's Pixel 7 profile, so the sheet never takes
   * focus into itself and the failure cannot arise there. That half is the
   * describe block at the foot of this file.
   */
  expect(await page.evaluate(focusedVara)).toContain("broccoli");
});

/**
 * At a desk, where the sheets' focus story actually breaks.
 *
 * Everything above runs as a Pixel 7, which is right — the phone is the prime
 * use. But Chrome will not honour `autoFocus` on a text field under a mobile
 * profile, and a sheet that never takes focus into itself cannot exhibit the
 * bug these two assert. Overriding the viewport per-describe rather than adding
 * a project keeps the whole thing inside this file, where a reader looking for
 * "why is this one desktop" can see the answer next to it.
 */
test.describe("at a desktop viewport, where sheets do autofocus", () => {
  test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

  test("the sheet's own field takes focus, and Escape still returns it", async ({
    freshPage: page,
  }) => {
    const field = page.getByLabel(FIELD);
    await field.click();
    await field.pressSequentially("broccoli");
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(focusedVara)).toContain("broccoli");

    await page.keyboard.press("Shift+F10");
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    /**
     * The amount field, not the dialog wrapper — and this is the assertion that
     * catches the StrictMode hazard rather than the original bug.
     *
     * `reactStrictMode` defaults to true for the App Router, so dev runs
     * setup → cleanup → setup. Once the trap records the TRIGGER instead of
     * whatever had focus after the commit, an unguarded cleanup fires between
     * those two setups and pulls focus out of a sheet still on screen; the
     * second setup then finds nothing focused inside and falls back to the
     * wrapper, which is focusable. The visible symptom is exactly this line
     * failing, and on a phone it is a keyboard that opens and shuts in a frame.
     */
    await expect(sheet.locator("input").first()).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    // And the original bug: the trap must have recorded the row, not the
    // sheet's own field, which is gone by the time the cleanup wants it.
    expect(await page.evaluate(focusedVara)).toContain("broccoli");
  });
});
