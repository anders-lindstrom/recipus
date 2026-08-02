import type { Page } from "@playwright/test";
import { slugify } from "@/lib/utils";
import {
  catalogTile,
  dropCatalogItems,
  dropProducts,
  entriesInIndexedDb,
  expect,
  longPressTile,
  onListTile,
  outboxSize,
  purchaseCount,
  test,
} from "./fixtures";

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
  const productId = await createProduct(page, productName, "Provmärket");

  await page.goto(`/varor?list=${listId}`);

  // What the screen is, before anything else on it. The same things, with the
  // same pictures and the same names, are tiles on the list — where a tap BUYS
  // one — and rows here, where a tap edits. The screen said nothing at all
  // about which of the two it was, and this is the sentence that says it.
  await expect(page.getByText(/Inget läggs på listan härifrån/)).toBeVisible();

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
  const varaRow = page.getByRole("button", { name: new RegExp(varaName) });
  await expect(varaRow).toContainText("1 produkt");

  // And the row states its verb before it states the name. The whole row stays
  // the tap target — the specs below click one in its middle and get the sheet —
  // so the thing that had to change was what it promises, not its size. The
  // pencil that carries the promise visually is aria-hidden decoration, which is
  // why the word itself has to be in the accessible name.
  await expect(varaRow).toHaveAccessibleName(/^Ändra\b/);

  // A mis-tap here sends a product under the wrong word and it vanishes from the
  // queue with no trace, so the safety valve has to actually work rather than
  // merely be offered.
  await page.getByRole("button", { name: /^Ångra/ }).click();
  await expect(queueRow).toBeVisible();

  await settle(page);
  // The product is unplaced again, so it needs removing in its own right — left
  // behind it would turn up in every later run's review queue.
  await dropProducts([productId]);
  await dropCatalogItems([varaId]);
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
  await dropCatalogItems([goneId, keptId]);
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
  // Both varor go, and the two products go with them — `dropCatalogItems` takes
  // out whatever points at them, which is the only reason this teardown is one
  // line rather than a dependency graph.
  await dropCatalogItems([sourceId, slug(splitName)]);
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
  // Deleted through the UI, but that delete is soft by design — the row is still
  // there, tombstoned, and teardown is what actually removes it.
  await dropCatalogItems([varaId]);
});

test("an item you invented can be moved out of Övrigt, and it stays moved", async ({
  page,
  listId,
}) => {
  const suffix = unique();
  // One token, no trailing digits: the add bar splits a trailing quantity off a
  // query ("mjölk 2 l"), so a name ending in numbers would be created without
  // them and nothing here would match.
  const varaName = `Surdegsbrod${suffix.replace(/-/g, "")}x`;

  // Created the way the household actually creates things: typed into the add
  // bar. Everything that route makes lands in Övrigt on purpose — guessing an
  // aisle sends you to the wrong end of the shop — and Övrigt sorts LAST, so an
  // item left there is one you walk back for on every trip. Being able to re-file
  // it is the whole reason the category carries a clock of its own.
  await page.goto(`/?list=${listId}`);
  await page.getByLabel("Sök eller lägg till vara").fill(varaName);
  // An `option`, not a button: the add bar's results are a listbox under the
  // field's combobox, so every row in it carries that role and `getByRole`
  // resolves the explicit one. The label wraps the name in curly quotes, so
  // match on the suffix rather than reproducing the punctuation.
  await page
    .getByRole("option", { name: new RegExp(`Lägg till.*${varaName}`) })
    .click();
  await expect(onListTile(page, varaName)).toBeVisible();

  await page.goto(`/varor?list=${listId}`);
  await page.getByRole("button", { name: new RegExp(varaName) }).click();

  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("button", { name: /Byt avdelning/ })).toContainText(
    "övrigt",
  );
  await sheet.getByRole("button", { name: /Byt avdelning/ }).click();
  await page.getByRole("button", { name: /Bröd/ }).first().click();

  // Survives a reload, which is the half that matters: the op has to have
  // reached the server and come back in the snapshot, not merely repainted.
  await page.reload();
  await page.getByRole("button", { name: new RegExp(varaName) }).click();
  const moved = page.getByRole("dialog");
  await expect(
    moved.getByRole("button", { name: /Byt avdelning/ }),
  ).not.toContainText("övrigt");

  // The icon follows the aisle. An add-bar item never had one picked for it — it
  // inherited Övrigt's box — so leaving it as a box after re-filing would make
  // "a default icon per category" true only at creation and wrong forever after.
  // The offer to reuse the category's icon names the NEW category, which is only
  // possible if the item actually moved.
  await expect(moved.getByRole("button", { name: /Byt ikon/ })).toBeVisible();
  await moved.getByRole("button", { name: /Byt ikon/ }).click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: /Använd bröds ikon/ }),
  ).toBeVisible();

  // slugify folds diacritics, so "Surdegsbröd" becomes "surdegsbrod-…" —
  // reproducing that by hand here would leave the row behind on every run.
  await dropCatalogItems([slugify(varaName)]);
});

test("a listed item links straight to its own vara", async ({ page, listId }) => {
  // The gap this closes: the list is about *this shop, today*, the registry is
  // about what the thing IS. Noticing mid-shop that something is filed in the
  // wrong aisle used to mean remembering it until you were home, and then
  // finding it again among everything else.
  await page.goto(`/?list=${listId}`);
  await catalogTile(page, "banan").click();
  await expect(onListTile(page, "banan")).toBeVisible();

  const tile = onListTile(page, "banan");
  const box = await tile.boundingBox();
  if (!box) throw new Error("no tile");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();

  await page.getByRole("button", { name: /Om banan/ }).click();

  // Lands ON the item, not on a screen of all of them — otherwise the link has
  // saved you nothing over navigating there yourself.
  await expect(page).toHaveURL(/\/varor\?.*vara=banan/);
  await expect(page.getByRole("dialog")).toContainText("banan");
  await expect(
    page.getByRole("dialog").getByRole("button", { name: /Byt avdelning/ }),
  ).toBeVisible();
});

/**
 * Editing a vara leaves you on the vara.
 *
 * Reported from production: "when editing an item and saving a category change,
 * the app jumps out into the varor view — if I just changed the category, maybe I
 * also want to change the icon. And I was in my shopping list, then ended up in
 * the items view."
 *
 * Four facts hang off one word — its name, its aisle, its picture, and whether
 * you always have it — and they are wanted together: you re-file surdegsbröd
 * into Bröd and immediately want it to stop being a cardboard box. Each save used
 * to close the whole sheet, which dropped you on a screen of three hundred other
 * varor with this one to find again. Arriving from the list via `?vara=`, as this
 * test does, it did not even drop you back where you came from.
 *
 * The `hasAtHome` toggle already behaved: closing makes trying something feel
 * like a commit. This asserts the other three now behave the same.
 */
test("changing a vara's category keeps the sheet open, ready for the next change", async ({
  page,
  listId,
}) => {
  // Its own vara, never a seeded one. This suite shares a catalog, and re-filing
  // banan into Bröd leaves it there for every later test and every later run —
  // which is how a tile ends up below the fold in a spec that measures before it
  // scrolls. Created here, dropped in teardown, visible to nobody else.
  const varaName = `Surdegsbrod${unique().replace(/-/g, "")}`;
  const varaId = await createVara(page, varaName);

  await page.goto(`/?list=${listId}`);
  const field = page.getByLabel("Sök eller lägg till vara");
  await field.fill(varaName);
  await field.press("Enter");
  await expect(onListTile(page, varaName)).toBeVisible();

  await longPressTile(page, onListTile(page, varaName));
  await page.getByRole("button", { name: new RegExp(`Om ${varaName}`, "i") }).click();
  await expect(page).toHaveURL(new RegExp(`/varor\\?.*vara=${varaId}`));

  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText(varaName);

  await sheet.getByRole("button", { name: /Byt avdelning/ }).click();
  await sheet.getByRole("button", { name: "Bröd", exact: true }).click();

  // Still here, on this vara, with the new aisle showing — not back on a list of
  // everything with the edit to take on trust.
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(varaName);
  await expect(sheet.getByRole("button", { name: /Byt avdelning/ })).toContainText(
    /bröd/i,
  );

  // And the second edit is reachable without navigating back, which is the whole
  // point of not closing.
  await sheet.getByRole("button", { name: /Byt ikon/ }).click();
  await expect(sheet.getByRole("textbox", { name: "Emoji" })).toBeVisible();

  await settle(page);
  await dropCatalogItems([varaId]);
});

test("renaming a vara returns to the vara, not to the whole registry", async ({
  page,
  listId,
}) => {
  const varaName = `Kesella${unique().replace(/-/g, "")}`;
  const varaId = await createVara(page, varaName);

  await page.goto(`/varor?list=${listId}&vara=${varaId}`);
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText(varaName);

  await sheet.getByRole("button", { name: /Byt namn/ }).click();
  await sheet.getByRole("textbox", { name: "Namn" }).fill(`${varaName}er`);
  await sheet.getByRole("button", { name: "Spara" }).click();

  // The rename sub-editor collapses back to the vara it belongs to. It used to
  // rely on the parent unmounting the entire sheet to hide itself, so saving a
  // name was indistinguishable from abandoning the vara.
  await expect(sheet.getByRole("textbox", { name: "Namn" })).toHaveCount(0);
  await expect(sheet).toContainText(`${varaName}er`);
  await expect(sheet.getByRole("button", { name: /Byt avdelning/ })).toBeVisible();

  await settle(page);
  await dropCatalogItems([varaId]);
});

/**
 * A merge takes today's shopping with it.
 *
 * The production report, in the reporter's words: "I added a recipe from ICA and
 * it put kycklingbröstfilé on my list. Later I merged that into just
 * kycklingbröst — and then if I add the recipe again it adds a new line of the
 * other one, and they potentially go double."
 *
 * Both halves came from one omission. `merge_catalog_items` correctly refuses to
 * rewrite entry rows — a merge that rewrote rows would not converge — but nothing
 * else moved them either, so the loser's entry stayed live on a vara the catalog
 * no longer had. The screen could not draw it and no gesture could reach it, so
 * the thing you needed silently vanished; and re-adding the recipe, which the
 * server had re-pointed at the survivor, then built a second entry beside the
 * invisible one.
 *
 * Asserted through the UI rather than against the tables, because "is it on my
 * list" is a question about what the screen shows — and a row nothing renders was
 * exactly the failure.
 */
test("merging a vara that is on the list moves the shopping to the survivor", async ({
  page,
  listId,
}) => {
  const suffix = unique();
  const goneName = `Kycklingfile ${suffix}`;
  const keptName = `Kycklingbrost ${suffix}`;
  const goneId = await createVara(page, goneName);
  const keptId = await createVara(page, keptName);

  // Put the doomed vara on the list, with a quantity — the number is the thing
  // that must survive the merge.
  await page.goto(`/?list=${listId}`);
  const field = page.getByLabel("Sök eller lägg till vara");
  await field.fill(`${goneName} 600 g`);
  await field.press("Enter");
  await expect(onListTile(page, goneName)).toContainText("600 g");

  await page.goto(`/varor?list=${listId}`);
  await page.getByRole("button", { name: new RegExp(goneName) }).click();
  const sheet = page.getByRole("dialog");

  // The consequence is stated before the choice, as every consequence on this
  // screen is. It used to promise the item would disappear off the list, which
  // was true of the tile and not of the row underneath it.
  await sheet.getByRole("button", { name: "Slå samman med annan vara" }).click();
  await expect(sheet.getByText(/flyttas över till varan du väljer/)).toBeVisible();

  await sheet.getByLabel("Sök vara att slå samman med").fill(keptName);
  await sheet.getByRole("button", { name: new RegExp(keptName) }).click();

  await page.goto(`/?list=${listId}`);
  // The survivor took its place, carrying the amount…
  await expect(onListTile(page, keptName)).toContainText("600 g");
  // …and the merged-away word left nothing behind. Before the fix this assertion
  // passed for the wrong reason: the tile was gone because nothing could draw it,
  // while the entry sat there live and unreachable.
  await expect(onListTile(page, goneName)).toHaveCount(0);

  // Exactly one thing on the list — the count is what "they go double" was about.
  const live = await entriesInIndexedDb(page);
  expect(live.filter((id) => id.startsWith(`${listId}:`))).toEqual([
    `${listId}:${keptId}`,
  ]);

  await settle(page);
  await dropCatalogItems([goneId, keptId]);
});

/**
 * A stand-in tile is repair work, and repair never records a purchase.
 *
 * An entry can outlive its vara — the reducer allows it deliberately, because a
 * merge that rewrote entry rows would not converge — and `tileVaror` draws that
 * orphan as a stand-in so it can be cleared instead of sitting there invisibly.
 * The trap is what happens when you clear it in a shop. Deletes here are SOFT,
 * so the `catalog_items` row is still present and a purchase against it is
 * accepted rather than rejected; and the merge's server-side re-pointing is
 * gated on the merge op, so it has long since run and will never collect this
 * one. The credit would sit on a word nobody uses, for ever, and the survivor
 * would under-record — the exact "invented purchase" this app's mode system
 * exists to rule out.
 *
 * The orphan is built the way the reducer really produces one: an op log that
 * tombstones a vara while an entry for it is still live.
 */
test("clearing a stand-in tile in buy mode records no purchase", async ({
  freshPage: page,
  listId,
}) => {
  const varaName = `Spokvara${unique().replace(/-/g, "")}`;
  const varaId = await createVara(page, varaName);

  await page.goto(`/?list=${listId}`);
  const field = page.getByLabel("Sök eller lägg till vara");
  await field.fill(varaName);
  await field.press("Enter");
  await expect(onListTile(page, varaName)).toBeVisible();
  await expect.poll(() => outboxSize(page), { timeout: 8000 }).toBe(0);

  // Tombstone the vara out from under the live entry.
  await postOps(page, [
    { ...envelope(), kind: "delete_catalog_item", itemId: varaId },
  ]);

  await page.reload();
  await expect(page.getByText("Att handla")).toBeVisible();

  // The row is still on the list and still reachable — that is `tileVaror`'s
  // whole job. It renders under the id, because the vara that knew the spelling
  // is precisely what is gone.
  const standIn = onListTile(page, varaId);
  await expect(standIn).toBeVisible();

  const modePill = page.getByRole("button", { name: /byt till/i });
  await modePill.click();
  await expect(modePill).toHaveText(/Handlar/);

  await standIn.click();
  await expect(onListTile(page, varaId)).toHaveCount(0);

  // Gone from the list, and nothing written to history. A buy-mode tap on any
  // ordinary tile would have recorded exactly one.
  await expect.poll(() => outboxSize(page), { timeout: 8000 }).toBe(0);
  expect(await purchaseCount(listId)).toBe(0);

  await dropCatalogItems([varaId]);
});
