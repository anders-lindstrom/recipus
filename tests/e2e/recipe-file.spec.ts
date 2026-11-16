import path from "node:path";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

/**
 * A recipe from a photo: picked, stored, reviewed, saved, and its original
 * still there afterwards.
 *
 * The dev server runs with no shim configured, so the real read answers
 * `draft: null` — which is exactly the failure path worth proving end to end:
 * the file is kept and the household types the recipe in beside it. The happy
 * path rewrites that one response with a draft, leaving the storing and the
 * saving real.
 */
const sql = postgres(
  process.env.DATABASE_URL ?? "postgres://recipus:recipus@localhost:5434/recipus",
  { max: 1 },
);

const CARD = path.join(__dirname, "files", "recipe-card.png");

test.afterAll(async () => {
  // Sources of saved recipes go with them by cascade; drafts do not.
  await sql`delete from recipe_sources where created_by = 'e2e'`;
  await sql`delete from recipes where created_by = 'e2e' and title like 'E2E Fil%'`;
  await sql.end();
});

test("a photo nobody could read still lands beside an empty form, and saves", async ({ page }) => {
  await page.goto("/recept/importera");
  await page.getByLabel("Välj bild eller PDF").setInputFiles(CARD);

  await expect(page.getByText("Kunde inte läsa receptet — skriv in det bredvid originalet.")).toBeVisible();
  await expect(page.getByRole("img", { name: "Originalet" })).toBeVisible();

  await page.getByLabel("Titel").fill("E2E Fil Kladdkaka");
  await page.getByLabel("Ingredienser, en per rad").fill("2 ägg\n2 dl socker");
  await page.getByLabel("Gör så här, ett steg per rad").fill("Rör ihop.\nGrädda.");
  await page.getByRole("button", { name: "Spara receptet" }).click();

  await expect(page.getByRole("heading", { name: "E2E Fil Kladdkaka" }).first()).toBeVisible();
  await expect(page.getByText("2 ingredienser")).toBeVisible();

  const original = page.getByRole("link", { name: "Visa original" });
  await expect(original).toBeVisible();
  const res = await page.request.get((await original.getAttribute("href"))!);
  expect(res.status()).toBe(200);
  // Re-encoded in the browser before it left: what is kept is a JPEG.
  expect(res.headers()["content-type"]).toBe("image/jpeg");
});

test("a read draft is shown for review, and what is saved is the edited one", async ({ page }) => {
  await page.route("**/api/recipes/read-file", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: {
        ...body,
        draft: {
          title: "E2E Fil Läst",
          servings: 12,
          servingsUnit: "bullar",
          ingredientLines: ["5 dl vetemjöl", "50 g jäst"],
          instructions: ["Knåda.", "Grädda."],
        },
      },
    });
  });

  await page.goto("/recept/importera");
  await page.getByLabel("Välj bild eller PDF").setInputFiles(CARD);

  const title = page.getByLabel("Titel");
  await expect(title).toHaveValue("E2E Fil Läst");
  await expect(page.getByLabel("Ingredienser, en per rad")).toHaveValue("5 dl vetemjöl\n50 g jäst");

  await title.fill("E2E Fil Kanelbullar");
  await page.getByRole("button", { name: "Spara receptet" }).click();

  await expect(page.getByRole("heading", { name: "E2E Fil Kanelbullar" }).first()).toBeVisible();
  await expect(page.getByText("12 bullar")).toBeVisible();
  await expect(page.getByRole("link", { name: "Visa original" })).toBeVisible();
});
