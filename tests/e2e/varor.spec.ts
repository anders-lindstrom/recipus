import type { Page } from "@playwright/test";
import { expect, outboxSize, test } from "./fixtures";

/**
 * The registry screen, end to end.
 *
 * Two behaviours are worth this much machinery, and they are the two the whole
 * two-level model rests on:
 *
 *   1. A scanned product's purchases count for nothing until a human says which
 *      of the household's words it belongs under. The review queue is what makes
 *      the numbers true, so "place one and it lands under the vara" is the load
 *      -bearing interaction on the screen.
 *
 *   2. A merge must not destroy history. The merged-away word survives as an
 *      alias, and if it stopped resolving, every recipe line already written
 *      against it would silently stop matching — so this asserts that the old
 *      word still finds the survivor, which is the only place that promise is
 *      visible to a person.
 *
 * Everything is created through the op log rather than through SQL, because the
 * op log IS the registry's interface — the whole reason it does not live behind
 * server CRUD is that unknown barcodes are met in a shop, offline. Seeding by
 * hand would test a path the app never takes.
 *
 * Nothing seeded is touched. These build their own varor with names unique to
 * the run and tombstone them afterwards, for the same reason each test gets its
 * own list: a merge that ate `citron` would break a completely unrelated spec an
 * hour later, and the failure would look nothing like the cause.
 */

let seq = 0;
function unique(): string {
  return `${process.pid}-${++seq}`;
}

/**
 * Post ops the way the client does.
 *
 * `page.request` inherits the browser context, and dev auth comes from
 * `DEV_AUTH_USER` on the server, so no headers are needed. Each result is
 * checked individually: the route reports partial success per op, so a batch
 * that "succeeded" can still contain a refusal, and a silent refusal here would
 * show up as a mystifying missing row three assertions later.
 */
async function postOps(page: Page, ops: object[]): Promise<void> {
  const response = await page.request.post("/api/ops", { data: { ops } });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    results: Array<{ clientOpId: string; error?: string }>;
  };
  for (const result of body.results) {
    expect(result.error, `op ${result.clientOpId} refused`).toBeUndefined();
  }
}

function envelope() {
  return {
    clientOpId: crypto.randomUUID(),
    actor: "e2e",
    at: new Date().toISOString(),
  };
}

/**
 * `normalizeName` and `slugify`, mirrored rather than imported.
 *
 * Playwright compiles this file with its own transform, outside the app's module
 * resolution, so the `@/` alias is not available here. Mirrored deliberately and
 * kept trivial: a vara created with a `nameNorm` that did not match what the app
 * would have derived is a vara the search box cannot find, which would make this
 * spec fail for a reason that has nothing to do with the registry.
 */
function norm(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slug(name: string): string {
  return norm(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function createVara(page: Page, name: string): Promise<string> {
  const id = slug(name);
  await postOps(page, [
    {
      ...envelope(),
      kind: "create_catalog_item",
      item: {
        id,
        name,
        nameNorm: norm(name),
        categoryId: "ovrigt",
        iconRef: "1F4E6",
        isCustom: true,
        hasAtHome: false,
        useCount: 0,
        lastUsedAt: null,
      },
    },
  ]);
  return id;
}

/** A product, unplaced when `catalogItemId` is null — what an unknown barcode leaves behind. */
async function createProduct(
  page: Page,
  name: string,
  brand: string,
  catalogItemId: string | null = null,
): Promise<string> {
  const id = `prod:e2e-${unique()}`;
  await postOps(page, [
    {
      ...envelope(),
      kind: "create_product",
      product: {
        id,
        name,
        brand,
        catalogItemId,
        defaultSize: null,
        sourceSizeText: "1 l",
        imageUrl: null,
        createdAt: new Date().toISOString(),
        createdBy: "e2e",
      },
    },
  ]);
  return id;
}

/**
 * Tombstone whatever the test invented.
 *
 * Soft, like every delete here, and enough: a tombstoned vara is filtered out of
 * every catalog query, so it cannot turn up as a stray tile in another spec.
 */
async function dropVaror(page: Page, ids: string[]): Promise<void> {
  await postOps(
    page,
    ids.map((itemId) => ({ ...envelope(), kind: "delete_catalog_item", itemId })),
  );
}

/** Let the client's outbox drain, so teardown never pulls a table out from under it. */
async function settle(page: Page): Promise<void> {
  await expect.poll(() => outboxSize(page), { timeout: 5000 }).toBe(0);
}

test("a scanned product is placed on a vara from the review queue", async ({
  page,
  listId,
}) => {
  const suffix = unique();
  const varaName = `Provmjolk ${suffix}`;
  const productName = `Provprodukt ${suffix}`;
  const varaId = await createVara(page, varaName);
  await createProduct(page, productName, "Provmärket");

  await page.goto(`/varor?list=${listId}`);

  // The debt is advertised rather than tucked away — the entire argument for
  // the queue being prominent is that these purchases are already recorded and
  // are simply not counted yet.
  await expect(page.getByText(/väntar på en vara/)).toBeVisible();

  // Scoped to the queue itself. Unscoped, "the product is no longer listed"
  // would also match the undo control in the queue's own heading, which names
  // the product on purpose — the assertion would then never be able to pass.
  const queue = page.getByRole("list", { name: "Produkter att placera" });
  const queueRow = queue.getByRole("button", { name: new RegExp(productName) });
  await expect(queueRow).toBeVisible();
  await expect(queueRow).toContainText("Provmärket");

  await queueRow.click();

  // Placing is one tap inside the sheet. A queue that costs three taps per item
  // is a queue that stays full.
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Sök vara").fill(varaName);
  await sheet.getByRole("button", { name: new RegExp(varaName) }).click();

  // The product has left the queue…
  await expect(queueRow).toHaveCount(0);
  // …and the vara now says so, which is the only thing on the screen that makes
  // the second level discoverable at all.
  await expect(
    page.getByRole("button", { name: new RegExp(varaName) }),
  ).toContainText("1 produkt");

  // A mis-tap here sends a product under the wrong word and it vanishes from the
  // queue with no trace, so the safety valve has to actually work rather than
  // merely be offered.
  await page.getByRole("button", { name: /^Ångra/ }).click();
  await expect(queueRow).toBeVisible();

  // Put it back before leaving. There is no `delete_product` op — a product is a
  // thing the household has met, and meeting it is not undoable — so an unplaced
  // one left behind here turns up in every later run's review queue. Under the
  // vara that is about to be tombstoned it is invisible to every screen.
  await queueRow.click();
  await sheet.getByLabel("Sök vara").fill(varaName);
  await sheet.getByRole("button", { name: new RegExp(varaName) }).click();

  await settle(page);
  await dropVaror(page, [varaId]);
});

test("merging keeps the merged-away word finding the survivor", async ({
  page,
  listId,
}) => {
  const suffix = unique();
  const goneName = `Kottfars ${suffix}`;
  const keptName = `Notfars ${suffix}`;
  const goneId = await createVara(page, goneName);
  const keptId = await createVara(page, keptName);

  await page.goto(`/varor?list=${listId}`);

  await page.getByRole("button", { name: new RegExp(goneName) }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Slå samman med annan vara" }).click();

  // Said before the choice, not after: none of a merge's consequences are
  // visible once it has happened.
  await expect(sheet.getByText(/fortsätter fungera/)).toBeVisible();

  await sheet.getByLabel("Sök vara att slå samman med").fill(keptName);
  await sheet.getByRole("button", { name: new RegExp(keptName) }).click();

  // The word is gone as a vara of its own…
  await expect(page.getByText(goneName, { exact: true })).toHaveCount(0);

  // …but it still reaches the survivor, which is the entire promise of the
  // merge. If this came back empty the household would reasonably re-create the
  // word, restoring the duplicate the merge existed to remove.
  await page.getByLabel("Sök vara eller produkt").fill(goneName);
  const survivor = page.getByRole("button", { name: new RegExp(keptName) });
  await expect(survivor).toBeVisible();
  await expect(survivor).toContainText("även");

  await settle(page);
  await dropVaror(page, [goneId, keptId]);
});

test("a split moves only the ticked products, and the source vara stays", async ({
  page,
  listId,
}) => {
  const suffix = unique();
  const sourceName = `Smorprov ${suffix}`;
  const splitName = `Osaltat ${suffix}`;
  const movedName = `Flyttprodukt ${suffix}`;
  const stayName = `Kvarprodukt ${suffix}`;
  const sourceId = await createVara(page, sourceName);
  await createProduct(page, movedName, "Provmärket", sourceId);
  await createProduct(page, stayName, "Provmärket", sourceId);

  await page.goto(`/varor?list=${listId}`);

  const source = page.getByRole("button", { name: new RegExp(sourceName) });
  await expect(source).toContainText("2 produkter");
  await source.click();

  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Dela upp" }).click();
  await sheet.getByLabel("Ny vara").fill(splitName);

  // Only one of the two is ticked. This is the whole design: nothing but a human
  // knows which of fourteen products are osaltat, so nothing starts ticked and
  // the checkbox list IS the split.
  await sheet.getByRole("button", { name: new RegExp(movedName) }).click();
  await sheet.getByRole("button", { name: new RegExp(`Skapa ${splitName}`) }).click();

  // The new vara got exactly what was ticked…
  await expect(
    page.getByRole("button", { name: new RegExp(splitName) }),
  ).toContainText("1 produkt");
  // …and the source is still here, one product lighter rather than emptied.
  await expect(source).toContainText("1 produkt");

  // And the source can now be deleted, while the new vara cannot: a vara with
  // products pointing at it would leave them stranded under a word that no
  // longer exists, so the screen refuses and says how to proceed.
  await page.getByRole("button", { name: new RegExp(splitName) }).click();
  await expect(sheet.getByText("Går inte att ta bort än")).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: `Ta bort ${splitName}` }),
  ).toHaveCount(0);

  await settle(page);
  await dropVaror(page, [sourceId, slug(splitName)]);
});

test("a vara on the list cannot be deleted until it is taken off it", async ({
  page,
  listId,
}) => {
  const suffix = unique();
  const varaName = `Prisprov ${suffix}`;
  const varaId = await createVara(page, varaName);
  await postOps(page, [
    { ...envelope(), kind: "add_item", listId, catalogItemId: varaId },
  ]);

  await page.goto(`/varor?list=${listId}`);

  await page.getByRole("button", { name: new RegExp(varaName) }).click();
  const sheet = page.getByRole("dialog");

  // Reaching into today's shopping from a taxonomy screen is the surprise this
  // refusal exists to prevent — so it refuses, names the shop, and offers the fix
  // in place rather than sending you to another screen to find it.
  await expect(sheet.getByText("Går inte att ta bort än")).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: `Ta bort ${varaName}` }),
  ).toHaveCount(0);

  await sheet.getByRole("button", { name: "Ta bort från E2E" }).click();

  // The blocker clears without the sheet closing, so the fix and the thing it
  // unblocks are one continuous action.
  await expect(sheet.getByText("Går inte att ta bort än")).toHaveCount(0);
  await sheet.getByRole("button", { name: `Ta bort ${varaName}` }).click();

  await expect(page.getByText(varaName, { exact: true })).toHaveCount(0);

  await settle(page);
});
