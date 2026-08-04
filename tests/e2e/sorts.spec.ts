import type { Page } from "@playwright/test";
import {
  catalogTile,
  dismissAddBar,
  dropCatalogItems,
  expect,
  longPressTile,
  onListTile,
  test,
} from "./fixtures";

/**
 * Two kinds of one thing.
 *
 * Every test here comes from one report, and they are all the same underlying
 * fact: a list entry is `(listId, catalogItemId)`, so one vara appears at most
 * once per list, while a sort ("mogna") lives on that entry's manual
 * contribution. The app therefore could not hold "blåbär" and "mogna blåbär" at
 * the same time — and rather than say so, it overwrote one with the other.
 *
 * Quoting the report, because it is the acceptance criterion: "I end up with
 * just blåbär — the mogna version disappeared. This is just bad and/or bug?"
 */

/**
 * Varor these tests invent, and one they must never invent.
 *
 * `mogna-blabar` is the belt-and-braces entry. Setting the fixture up through
 * the add bar used to mean typing "mogna blåbär" and trusting `resolveQuery` to
 * read it as blåbär + a sort — and when anything perturbed that, Enter fell
 * through to "create a new vara" and made one literally called "mogna blåbär".
 * That vara then matched the next run's query EXACTLY, so every subsequent run
 * failed for a reason that had nothing to do with the code under test. The setup
 * below no longer goes near the parser, and this entry cleans up after any run
 * that did.
 */
const INVENTED = ["blabar-mogna", "broccoli-fryst", "gurka-inlagd", "mogna-blabar"];

test.afterAll(async () => {
  // These are real varor now, in a catalog shared by the whole suite, so they
  // have to go the same way `varor.spec.ts` cleans up the ones it invents.
  await dropCatalogItems(INVENTED);
});

/**
 * Put a vara on the list carrying a sort, without going through the parser.
 *
 * Deliberately the long way round — tile, hold, type — rather than typing
 * "mogna blåbär" into the add bar. The short way depends on `resolveQuery`
 * reading the query as vara + sort, and when it does not, Enter silently CREATES
 * a vara by that name instead. That is a fine behaviour and a terrible fixture:
 * it makes the setup for the bug under test depend on the very parsing the test
 * is not about, and it poisons the shared catalog for every later run.
 */
async function addWithSort(page: Page, vara: string, sort: string) {
  await catalogTile(page, vara).click();
  const tile = onListTile(page, vara);
  await expect(tile).toBeVisible();

  await longPressTile(page, tile);
  await page.getByLabel("Sort").fill(sort);
  // Commits the field. The entry sheet has no primary action, so this does
  // nothing else — and Escape is then the only way out.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");

  await expect(tile).toContainText(sort);
}

test("asking for the plain kind keeps the sort you already asked for", async ({
  freshPage: page,
}) => {
  await addWithSort(page, "blåbär", "mogna");

  // Now ask for ordinary blueberries as well — the exact reported gesture.
  await page.getByLabel("Sök eller lägg till vara").fill("blåbär");
  await page.getByRole("option", { name: /blåbär/ }).first().click();

  // The sheet that used to offer only "keep it" or "destroy it".
  await page.getByRole("button", { name: /båda sorterna/i }).click();

  const name = page.getByLabel("Vad heter den andra sorten?");
  // Prefilled with base + sort, so the common case is one tap.
  await expect(name).toHaveValue("blåbär mogna");
  await page.getByRole("button", { name: "Skapa", exact: true }).click();

  // The whole report, inverted: BOTH kinds on the list, as two tiles.
  await expect(onListTile(page, "blåbär mogna")).toBeVisible();
  await expect(onListTile(page, "blåbär")).toBeVisible();
  // And the sort travelled to the vara that now carries it in its name, rather
  // than staying behind on the plain one.
  await expect(onListTile(page, "blåbär")).not.toContainText("mogna");
});

test("a split-off sort is findable and addable again afterwards", async ({
  freshPage: page,
}) => {
  await addWithSort(page, "blåbär", "mogna");
  await page.getByLabel("Sök eller lägg till vara").fill("blåbär");
  await page.getByRole("option", { name: /blåbär/ }).first().click();
  await page.getByRole("button", { name: /båda sorterna/i }).click();
  await page.getByRole("button", { name: "Skapa", exact: true }).click();
  await expect(onListTile(page, "blåbär mogna")).toBeVisible();

  // Buy it, so it leaves the list and goes back to being vocabulary.
  //
  // The panel is still open on the confirmation of the add, and a press outside
  // it is spent dismissing it rather than delivered to whatever is underneath.
  await dismissAddBar(page);
  await onListTile(page, "blåbär mogna").click();
  await expect(onListTile(page, "blåbär mogna")).toHaveCount(0);

  // "It should be able to be directly selected up ahead easily" — so typing the
  // sort's own name has to reach it, months later, with no ceremony.
  await page.getByLabel("Sök eller lägg till vara").fill("blåbär mogna");
  await page.keyboard.press("Enter");
  await expect(onListTile(page, "blåbär mogna")).toBeVisible();
});

test("adding something already on the list does not claim it was added", async ({
  freshPage: page,
}) => {
  await catalogTile(page, "broccoli").click();
  await expect(onListTile(page, "broccoli")).toBeVisible();

  await page.getByLabel("Sök eller lägg till vara").fill("broccoli");
  await page.getByRole("option", { name: /broccoli/ }).first().click();

  // It used to say "broccoli tillagd" — a confirmation for something that did
  // not happen, on the same strip that carries undo.
  await expect(page.getByText("broccoli står redan på listan")).toBeVisible();
  await expect(page.getByText(/broccoli — .*tillagd/)).toHaveCount(0);
  // And no "Ångra", because there is nothing to take back.
  await expect(page.getByRole("button", { name: /^Ångra/ })).toHaveCount(0);
  // The way out of the dead end, said where the dead end is.
  await expect(page.getByText(/Håll in raden/)).toBeVisible();
});

test("a search result can be held to add a second sort of it", async ({
  freshPage: page,
}) => {
  await catalogTile(page, "broccoli").click();
  await expect(onListTile(page, "broccoli")).toBeVisible();

  // Anything on the list is filtered out of the catalog well and the frequent
  // grid, so typing is the ONLY way back to it — and holding a search row did
  // nothing at all until now.
  await page.getByLabel("Sök eller lägg till vara").fill("broccoli");
  const row = page.getByRole("option", { name: /broccoli/ }).first();
  await longPressTile(page, row);

  await page.getByLabel("Sort").fill("fryst");
  // Defaults to "Egen vara" because the vara is already on the list, which is
  // the only thing typing a sort there can sensibly mean.
  await expect(page.getByLabel("Namn")).toHaveValue("broccoli fryst");
  await page.getByRole("button", { name: /Lägg till som egen vara/ }).click();

  await expect(onListTile(page, "broccoli fryst")).toBeVisible();
  await expect(onListTile(page, "broccoli")).toBeVisible();
});

test("a sort you regret can be hidden, and typing its name brings it back", async ({
  freshPage: page,
}) => {
  // Its own invented sort rather than the one above: these tests share a
  // catalog, so reusing that name would find the vara the previous test created
  // and the "create" row would correctly not be offered at all.
  await page.getByLabel("Sök eller lägg till vara").fill("gurka inlagd");
  await page.getByRole("option", { name: /som egen vara/ }).click();
  await expect(onListTile(page, "gurka inlagd")).toBeVisible();

  // Off the list, so it is back in the catalog well where it clutters. The
  // panel is still up on the confirmation of the create, and a press outside it
  // now dismisses rather than acts — see the note in the split test above.
  await dismissAddBar(page);
  await onListTile(page, "gurka inlagd").click();
  const tile = catalogTile(page, "gurka inlagd");
  await expect(tile).toBeVisible();

  await longPressTile(page, tile);
  await page.getByRole("button", { name: /Dölj gurka inlagd/ }).click();

  // Gone from the well — which is the point, since that is 341 tiles you scroll
  // past on the way to something else.
  await expect(catalogTile(page, "gurka inlagd")).toHaveCount(0);

  // But NOT gone. Demoted rather than dropped, so hiding is never a trap.
  await page.getByLabel("Sök eller lägg till vara").fill("gurka inlagd");
  const row = page.getByRole("option", { name: /gurka inlagd/ }).first();
  await expect(row).toContainText("dold");
  await row.click();
  await expect(onListTile(page, "gurka inlagd")).toBeVisible();
});

test("Enter commits a field, and Enter again commits the sheet", async ({
  freshPage: page,
}) => {
  await longPressTile(page, catalogTile(page, "citron"));

  // The sheet opens with the amount focused, so this is pure keyboard from here.
  await page.keyboard.type("3 st");
  // First Enter: the field commits and lets go.
  await page.keyboard.press("Enter");
  await expect(page.getByText("Sparas som 3 st")).toBeVisible();
  // Second Enter: with no field holding it, it means "yes, do the thing".
  await page.keyboard.press("Enter");

  const tile = onListTile(page, "citron");
  await expect(tile).toBeVisible();
  await expect(tile).toContainText("3 st");
});

test("the breakdown does not appear for an item that is simply on the list", async ({
  freshPage: page,
}) => {
  await catalogTile(page, "gurka").click();
  await longPressTile(page, onListTile(page, "gurka"));

  // It used to read "BEHÖVS TILL → Tillagd" on every ordinary item: a heading
  // promising a recipe, and a row that named no recipe. Reported as
  // incomprehensible, and it was.
  await expect(page.getByText("Behövs till")).toHaveCount(0);
  await expect(page.getByText("Därför står den här")).toHaveCount(0);
  // The controls it exists for are still there.
  await expect(page.getByLabel("Mängd")).toBeVisible();
});
