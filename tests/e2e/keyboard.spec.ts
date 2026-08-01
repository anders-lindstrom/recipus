import { expect, onListTile, test } from "./fixtures";

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

  const rows = page.getByRole("list", { name: "Sökträffar" }).getByRole("button");
  await expect(rows.first()).toBeVisible();
  const first = await page.evaluate(
    () =>
      (
        document
          .querySelector('ul[aria-label="Sökträffar"] button')
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
  await expect(page.getByRole("list", { name: "Sökträffar" })).toBeVisible();

  // Blur used to close the panel's own state and leave the suggestion list
  // rendered off the query alone — a full-width dropdown hanging over the list
  // until you came back and cleared the field.
  await field.blur();
  await expect(page.getByRole("list", { name: "Sökträffar" })).toHaveCount(0);
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
   * What this covers, and what it deliberately does not.
   *
   * Covered: the panel stayed mounted under the sheet. Tearing it down on the
   * blur into the dialog unmounts the row the sheet belongs to, and there is
   * then nothing connected to hand focus back to.
   *
   * NOT covered here, because this suite runs as a Pixel 7 and Chrome declines
   * to honour `autoFocus` on a text field under a mobile profile: the other half
   * of the same failure, where the trap recorded the sheet's OWN amount field as
   * the trigger because it read `document.activeElement` after React had already
   * moved focus there. That half was measured in desktop Chromium — focus landed
   * on `<body>` before the fix and on the trigger after — and needs a
   * desktop-viewport project to regress against, which this config has no room
   * for. See `useFocusTrap`.
   */
  expect(await page.evaluate(focusedVara)).toContain("broccoli");
});
