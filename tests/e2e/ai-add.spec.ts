import { dropCatalogItems, expect, onListTile, test } from "./fixtures";

/**
 * The AI dialog, against a stubbed parse.
 *
 * The endpoint is routed rather than called, deliberately. What is worth
 * proving here is that what the model said arrives on the list correctly —
 * grouping, unticking, the new vara — and a real call would make that
 * assertion depend on a paid, non-deterministic third party. The parse itself
 * is covered by `src/lib/ai-add/*.test.ts`.
 */

/** The one vara these tests invent, so teardown can take it back out. */
const INVENTED = ["krabbklor"];

/**
 * After the suite rather than at the end of the test, and that ordering is
 * load-bearing.
 *
 * Dropping the vara inline races the client's own outbox: the `add_item` naming
 * it may still be in flight, and deleting the catalog row out from under it is
 * a foreign key violation logged as "op refused by server" — the exact
 * harness-induced failure `settle` exists to prevent. `afterAll` runs once the
 * page fixture has closed the client and drained it.
 */
test.afterAll(async () => {
  await dropCatalogItems(INVENTED);
});

test("reads a list, lets you untick, and adds the rest", async ({
  freshPage: page,
}) => {
  await page.route("**/api/ai/parse", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        usedModel: true,
        rows: [
          {
            id: "r0",
            said: "2 l mjölk",
            name: "mjölk",
            amount: { value: 2, unit: "l" },
            catalogItemId: "mjolk",
            group: "list",
          },
          {
            id: "r1",
            said: "ägg",
            name: "ägg",
            amount: null,
            catalogItemId: "agg",
            group: "list",
          },
          {
            id: "r2",
            said: "krabbklor",
            name: "krabbklor",
            amount: null,
            catalogItemId: null,
            group: "list",
          },
          {
            id: "r3",
            said: "salt",
            name: "salt",
            amount: null,
            catalogItemId: "salt",
            group: "other",
          },
        ],
      }),
    });
  });

  await page.getByRole("button", { name: "Lägg till flera med AI" }).click();
  await page
    .getByRole("textbox", { name: /skriv och klistra in/i })
    .fill("mjölk, ägg, krabbklor");
  await page.getByRole("button", { name: "Läs listan" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Ny vara")).toBeVisible();

  // The suggestion group is present but unticked, so it must not be counted.
  await expect(
    dialog.getByRole("button", { name: /Lägg till 3 varor/ }),
  ).toBeVisible();

  // Untick the egg, add the rest.
  await dialog.getByRole("button", { name: /^ägg/ }).click();
  await dialog.getByRole("button", { name: /Lägg till 2 varor/ }).click();

  await expect(onListTile(page, "mjölk")).toHaveCount(1);
  await expect(onListTile(page, "krabbklor")).toHaveCount(1);
  await expect(onListTile(page, "ägg")).toHaveCount(0);
  // "Också på bilden" was never ticked, so salt stayed off.
  await expect(onListTile(page, "salt")).toHaveCount(0);
  // The amount came off the row rather than out of the catalog.
  await expect(onListTile(page, "mjölk")).toContainText("2 l");
});

/**
 * The share path, which is the one that has actually broken.
 *
 * `?ai=share&t=…` has to reach the sheet AND the sheet's mount effect has to
 * reach `show()` under StrictMode's setup → cleanup → setup — which is what
 * `pnpm dev` runs, and therefore what Playwright drives. Before commit 47ee770
 * the effect's run-once ref and its cancellation flag deadlocked each other:
 * the second setup started nothing, the first fetch resolved into a closure
 * that had been told to discard its result, and the dialog sat on "Läser…" for
 * ever. Nothing else in the suite would notice that, because nothing else opens
 * the sheet from a URL.
 */
test("a shared image opens the dialog already reading it", async ({
  freshPage: page,
  listId,
}) => {
  await page.route("**/api/ai/parse", async (route) => {
    // The share sends the token and nothing else — no image is re-uploaded from
    // the browser, because the server already has it under that token.
    expect(route.request().postDataJSON()).toEqual({
      kind: "share",
      token: "faketoken",
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        usedModel: true,
        rows: [
          {
            id: "s0",
            said: "2 l mjölk",
            name: "mjölk",
            amount: { value: 2, unit: "l" },
            catalogItemId: "mjolk",
            group: "list",
          },
        ],
      }),
    });
  });

  // What `/dela` redirects to once it has parked the shared image.
  await page.goto(`/?ai=share&t=faketoken&list=${listId}`);

  // Opened by the URL alone: nothing was pressed on this page.
  const dialog = page.getByRole("dialog", { name: /Lägg till flera i/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^mjölk/ })).toBeVisible();
  // The spinner is the failure mode, so say so rather than implying it.
  await expect(dialog.getByText("Läser…")).toHaveCount(0);

  await dialog.getByRole("button", { name: /Lägg till 1 vara/ }).click();

  await expect(onListTile(page, "mjölk")).toHaveCount(1);

  /**
   * And the token is spent, so reopening must not present it again.
   *
   * `takeSharedImage` empties the slot on first read. The URL still said
   * `?ai=share&t=…` after the dialog closed, and the sheet's `sharedTried` ref
   * only guards one mount — so tapping the sparkle re-fetched a consumed token
   * and dropped the person into the error card on the very path this feature
   * exists to make work. The dialog must come back as a text field.
   */
  await page.getByRole("button", { name: "Lägg till flera med AI" }).click();
  const reopened = page.getByRole("dialog", { name: /Lägg till flera i/ });
  await expect(reopened.getByRole("button", { name: "Läs listan" })).toBeVisible();
  await expect(
    reopened.getByRole("textbox", { name: /skriv och klistra in/i }),
  ).toBeVisible();
  await expect(reopened.getByRole("alert")).toBeEmpty();

  // And the address no longer carries it, so a reload cannot resurrect it
  // either — with `?list=` left alone, because that decides which list this is.
  await expect(page).toHaveURL(new RegExp(`\\?list=${listId}$`));
});
