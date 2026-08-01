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
