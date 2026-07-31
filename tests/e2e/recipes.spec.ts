import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";

/**
 * Getting a recipe in when the page will not give one up.
 *
 * The URL importer reads schema.org markup and, with a key configured, falls
 * back to asking an LLM. Neither can be relied on: plenty of pages publish
 * nothing, and a household running this without `ANTHROPIC_API_KEY` has no
 * fallback at all. What used to happen then was a message and a "Försök igen"
 * that would fail in precisely the same way — the recipe visible in the tab the
 * person had just come from, and nowhere to put it.
 *
 * Its own database connection rather than the pool in fixtures.ts. That one is a
 * module-level client ended by a worker-scoped fixture, and reaching into it
 * from here would tie this file's teardown to a lifetime it does not own — the
 * exact mistake fixtures.ts documents having already made once.
 */
const sql = postgres(
  process.env.DATABASE_URL ??
    "postgres://recipus:recipus@localhost:5434/recipus",
  { max: 1 },
);

/**
 * The live region carrying a given message.
 *
 * Picked by its text rather than by position, because Next renders a
 * `role="alert"` of its own — the route announcer — at the end of every page.
 * Selecting the first or last alert on screen therefore says nothing about
 * which one is the app's, and the assertion worth making here is precisely
 * that the message a failed import produces is inside a live region at all.
 */
function alertSaying(page: Page, text: string) {
  return page.getByRole("alert").filter({ hasText: text });
}

test.afterAll(async () => {
  // Scoped to the actor rather than to a title, matching how `dropTestList`
  // clears the op log: `DEV_AUTH_USER` is "e2e" for this whole suite, so this
  // is exactly what these tests wrote and nothing else. Ingredients cascade.
  await sql`delete from recipes where created_by = 'e2e'`;
  await sql.end();
});

test("a pasted ingredient list becomes a recipe", async ({ page }) => {
  await page.goto("/recept/importera");
  await page
    .getByRole("button", { name: "Klistra in ingredienserna i stället" })
    .click();

  await page.getByLabel("Vad heter receptet?").fill("E2E Pannkakor");

  // Pasted the way a copy off a web page actually arrives: the heading above
  // the list, the serving count, a list marker, a blank line, and the heading
  // of the next section caught by a selection that ran on a little too far.
  await page
    .getByLabel("Ingredienser")
    .fill("Ingredienser:\n4 portioner\n- 3 dl mjöl\n\n6 dl mjölk\n3 ägg\nGör så här");

  await page.getByRole("button", { name: "Spara receptet" }).click();

  // The screen header and the recipe's own display title both carry it.
  await expect(
    page.getByRole("heading", { name: "E2E Pannkakor" }).first(),
  ).toBeVisible();

  // Three, not seven. The count is the assertion that the tidying happened:
  // every line that was not an ingredient is gone, and no line that was one
  // went with it.
  await expect(page.getByText("3 ingredienser")).toBeVisible();

  // Scoped to the ingredient list by name. An unscoped `getByRole("listitem")`
  // also matches sonner's toast — toasts are `<li>` — so "E2E Pannkakor sparat"
  // joined the array whenever the run before this one had been slow enough for
  // the toast to still be up. Passed alone, failed in the full suite.
  const ingredients = page
    .getByRole("list", { name: "Ingredienser" })
    .getByRole("listitem");
  await expect(ingredients).toHaveText([/3 dl mjöl/, /6 dl mjölk/, /3 ägg/]);
});

test("a failed import offers a way through, not just a way to repeat itself", async ({
  page,
}) => {
  await page.goto("/recept/importera");

  // A URL the server rejects before it touches the network, so this test states
  // something about the dead end rather than about somebody's website. The
  // message differs from the one the audit found — that one needs a page with
  // no recipe markup — but the shape being tested is the same: an import has
  // failed, and what the screen offers next is the whole point.
  await page.getByLabel("Receptlänk").fill("inte en länk");
  await page.getByRole("button", { name: "Importera" }).click();

  const alert = alertSaying(page, "Ogiltig webbadress");
  await expect(alert).toBeVisible();

  // Both offers, and the second one is the fix: retrying alone would ask the
  // server the same question and get the same answer.
  await expect(alert.getByRole("button", { name: "Försök igen" })).toBeVisible();
  await alert.getByRole("button", { name: "Klistra in i stället" }).click();

  await expect(page.getByLabel("Ingredienser")).toBeVisible();
  await expect(page.getByLabel("Vad heter receptet?")).toBeVisible();
});

test("text with nothing usable in it is refused rather than stored empty", async ({
  page,
}) => {
  await page.goto("/recept/importera");
  await page
    .getByRole("button", { name: "Klistra in ingredienserna i stället" })
    .click();

  await page.getByLabel("Vad heter receptet?").fill("E2E Tomt");
  // Headings only. A recipe saved from this would hold no ingredients at all,
  // which adds nothing to a list and says nothing about why.
  await page.getByLabel("Ingredienser").fill("Ingredienser:\nGör så här");
  await page.getByRole("button", { name: "Spara receptet" }).click();

  await expect(alertSaying(page, "Hittade inga ingredienser")).toBeVisible();
  // Still on the form, with the text intact to correct.
  await expect(page.getByLabel("Ingredienser")).toHaveValue(
    "Ingredienser:\nGör så här",
  );
});
