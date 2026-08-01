import type { Page } from "@playwright/test";
import {
  barcodeRow,
  catalogTile,
  dropProducts,
  expect,
  onListTile,
  outboxSize,
  purchaseCount,
  test,
} from "./fixtures";

/**
 * The scan path, driven through manual entry.
 *
 * DECISIONS.md has called this "the one flow this repo cannot test" since the
 * scanner shipped, on the grounds that headless Chromium has no camera. That is
 * true of the *decoder* and false of everything after it: with no camera the
 * scanner falls back to a barcode field, and every line that decides what a scan
 * MEANS sits downstream of that field. So the four-cell mode table, the local
 * EAN map, the queueing of an unknown code and the placement question are all
 * reachable — and they are exactly the parts where a mistake costs a real
 * purchase in a real shop.
 *
 * What stays untested is `createDetector` and the frame loop. That is a much
 * smaller and much more honest gap than "the scanner is untestable".
 */

let seq = 0;
/**
 * A unique EAN per test, so one run cannot teach another run's barcode — the
 * household's EAN map is deliberately global, unlike the per-test list.
 */
function unique(): string {
  const tail = String(process.pid).slice(-5).padStart(5, "0");
  return `999${tail}${String(++seq).padStart(5, "0")}`;
}

async function openScanner(page: Page) {
  await page.getByRole("button", { name: "Skanna streckkod" }).click();
  // No camera in headless Chromium, so the scanner offers its manual field.
  // That fallback exists for creased and worn barcodes, not for tests — this
  // just happens to be the same door.
  // `exact`, because the floating scan button is labelled "Skanna streckkod"
  // and a substring match resolves to it instead — which passes this assertion
  // without the scanner ever having opened.
  await expect(page.getByLabel("Streckkod", { exact: true })).toBeVisible();
}

async function scan(page: Page, ean: string) {
  await page.getByLabel("Streckkod", { exact: true }).fill(ean);
  await page.getByRole("button", { name: "Sök" }).click();
}

/** The question a scan asks when nobody has told the app what a barcode is. */
function placeSheet(page: Page) {
  return page.getByText("Vilken av era varor är det här?");
}

/**
 * Scoped to the dialog on purpose. The list screen behind it has a catalog tile
 * for the same vara, and an unscoped match picks that one — where the click is
 * then blocked by the sheet's own backdrop, which reads as "the row does not
 * work" rather than "the test aimed at the wrong element".
 */
async function place(page: Page, name: string) {
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Sök vara").fill(name);
  await sheet.getByRole("button", { name, exact: false }).first().click();
}

/**
 * The headline: a barcode nobody has met, scanned with no signal, is WRITTEN
 * rather than dropped.
 *
 * The old path fetched first and acted on the response, so offline it fell
 * straight into a catch and said "Kunde inte slå upp streckkoden" — in buy mode
 * that is a lost purchase, which is the failure the whole registry-in-the-op-log
 * decision was made to prevent.
 */
test("an unknown barcode scanned offline is queued and asks what it is", async ({
  freshPage: page,
  context,
}) => {
  const ean = unique();
  await context.setOffline(true);

  await openScanner(page);
  await scan(page, ean);

  // No network, and still a question rather than an error.
  await expect(placeSheet(page)).toBeVisible();

  // The product and its barcode are already written — before any answer, and
  // before any server. This is the assertion that the scan survived.
  expect(await outboxSize(page)).toBeGreaterThan(0);

  await place(page, "mjölk");
  await expect(onListTile(page, "mjölk")).toHaveCount(1);

  await context.setOffline(false);
  // Everything drains: create_product, link_barcode, update_product, add_item.
  await expect.poll(() => outboxSize(page), { timeout: 20000 }).toBe(0);

  // …and the server kept them. Draining is not acceptance — a refused op is
  // retried a bounded number of times and then dropped, emptying the outbox in
  // exactly the same way — so the row is the only honest proof that a scan made
  // with no signal survived the trip.
  await expect.poll(() => barcodeRow(ean), { timeout: 10000 }).toEqual({
    productId: `prod:${ean}`,
    catalogItemId: "mjolk",
  });

  await dropProducts([`prod:${ean}`]);
});

/**
 * The local EAN map, which the design doc promised and which never existed.
 *
 * The point is not that a second scan is faster. It is that it works at all
 * with the server unreachable, which is the condition every scan in a shop is
 * made under.
 */
test("a barcode the household has answered for resolves with no network", async ({
  freshPage: page,
  context,
}) => {
  const ean = unique();

  // Teach it once, online.
  await openScanner(page);
  await scan(page, ean);
  await expect(placeSheet(page)).toBeVisible();
  await place(page, "citron");
  await expect(onListTile(page, "citron")).toHaveCount(1);
  await expect.poll(() => outboxSize(page), { timeout: 20000 }).toBe(0);

  // The scanner stays open across a session by design — you work through a
  // basket — so it has to be dismissed before the list underneath is reachable.
  await page.getByRole("button", { name: "Stäng", exact: true }).click();

  // Take it off again so the next scan has something to do.
  await onListTile(page, "citron").click();
  await expect(onListTile(page, "citron")).toHaveCount(0);

  // Now with the server gone entirely.
  await context.setOffline(true);
  await openScanner(page);
  await scan(page, ean);

  // Straight onto the list: no lookup, no question, no error.
  await expect(page.getByText("citron tillagd")).toBeVisible();
  await expect(placeSheet(page)).toHaveCount(0);

  await context.setOffline(false);
  await expect.poll(() => outboxSize(page), { timeout: 20000 }).toBe(0);
  await dropProducts([`prod:${ean}`]);
});

/**
 * Under-record, never invent — the invariant `use-mode.ts` states outright.
 *
 * Dismissing the placement question leaves a product with no vara, and a
 * purchase against nothing is not a purchase this app is willing to write. The
 * scan is still not lost: it is in the review queue, which is what the toast
 * says and what the outbox carries.
 */
test("dismissing the placement question records no purchase", async ({
  freshPage: page,
  listId,
}) => {
  const ean = unique();
  await page.getByRole("button", { name: /byt till handla-läge/ }).click();

  await openScanner(page);
  await scan(page, ean);
  await expect(placeSheet(page)).toBeVisible();

  await page.getByRole("button", { name: "Avbryt" }).click();
  await expect(page.getByText("Sparad i granskningskön")).toBeVisible();

  await expect.poll(() => outboxSize(page), { timeout: 20000 }).toBe(0);
  expect(await purchaseCount(listId)).toBe(0);

  await dropProducts([`prod:${ean}`]);
});

/**
 * Buy mode, all the way through: the answer completes the scan rather than
 * merely filing it. Telling somebody at a till that their answer was recorded
 * and their item was not is the failure this pins.
 */
test("placing a scanned product in buy mode records exactly one purchase", async ({
  freshPage: page,
  listId,
}) => {
  const ean = unique();
  await page.getByRole("button", { name: /byt till handla-läge/ }).click();

  await openScanner(page);
  await scan(page, ean);
  await expect(placeSheet(page)).toBeVisible();
  await place(page, "gurka");

  // Added and bought in one gesture — the unplanned-pickup cell.
  await expect(page.getByText("gurka tillagd och köpt")).toBeVisible();
  await expect.poll(() => outboxSize(page), { timeout: 20000 }).toBe(0);
  await expect.poll(() => purchaseCount(listId), { timeout: 10000 }).toBe(1);

  // And it is genuinely off the list, not merely reported as bought.
  // `exact`, or this also matches the catalog tile for *saltstänger*.
  await page.getByRole("button", { name: "Stäng", exact: true }).click();
  await expect(onListTile(page, "gurka")).toHaveCount(0);
  await expect(catalogTile(page, "gurka")).toBeVisible();

  await dropProducts([`prod:${ean}`]);
});
