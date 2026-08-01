import { expect, onListTile, outboxSize, test } from "./fixtures";

/**
 * Two phones on one list.
 *
 * The design doc asks for this in as many words — "two browser contexts editing
 * one list to prove live sharing works" — and it has never existed. That is a
 * strange gap to have left: the decision table calls live sharing "the feature
 * that makes Bring worth using", and it is the one headline feature with no
 * end-to-end proof. The reducer's convergence is tested to death in unit tests,
 * and none of that says the SSE stream is attached, that the fan-out picks the
 * right listeners, or that a client applies what arrives.
 *
 * A second BrowserContext rather than a second tab, deliberately: contexts have
 * separate IndexedDB, so this is genuinely two devices rather than one device
 * talking to itself through a shared store — which would pass with the network
 * unplugged.
 *
 * Both pages are closed before the fixture drops the list. A live client with a
 * draining outbox and a reconnecting stream, pointed at a list that has just
 * been deleted, is the harness-induced "op refused by server" this suite once
 * spent a session mistaking for a sync bug.
 */
test("an item added on one phone appears on the other without a reload", async ({
  freshPage: page,
  browser,
  listId,
}) => {
  const other = await browser.newContext();
  const partner = await other.newPage();

  try {
    await partner.goto(`/?list=${listId}`);
    await expect(partner.getByText("Att handla")).toBeVisible();

    // Nothing up either sleeve.
    await expect(onListTile(page, "ananas")).toHaveCount(0);
    await expect(onListTile(partner, "ananas")).toHaveCount(0);

    // One tap on the first phone…
    await page.getByRole("button", { name: "ananas" }).first().click();
    await expect(onListTile(page, "ananas")).toHaveCount(1);

    /*
     * …and it arrives on the second one, with no reload and no interaction.
     *
     * The stream is the only thing that can deliver this. The client has no
     * `setInterval` anywhere and catch-up runs on reconnect and on
     * visibilitychange — neither of which an idle, visible, untouched page
     * fires. So a broken fan-out fails here rather than being papered over by
     * a poll, which is the only reason the assertion is worth writing.
     */
    await expect(onListTile(partner, "ananas")).toHaveCount(1, {
      timeout: 15000,
    });

    /*
     * And back the other way, because the two directions are not the same code
     * path from either client's point of view: one is "my optimistic write,
     * later confirmed", the other is "somebody else's write, arriving cold".
     * A removal also carries `bought`, which is the flag the cadence engine
     * learns from — so a fan-out that dropped it would be silent and expensive.
     */
    await onListTile(partner, "ananas").click();
    await expect(onListTile(partner, "ananas")).toHaveCount(0);
    await expect(onListTile(page, "ananas")).toHaveCount(0, { timeout: 15000 });

    await expect.poll(() => outboxSize(page), { timeout: 15000 }).toBe(0);
    await expect.poll(() => outboxSize(partner), { timeout: 15000 }).toBe(0);
  } finally {
    await partner.close();
    await other.close();
  }
});

/**
 * A smoke test for `/statistik`, and deliberately only that.
 *
 * The counts themselves are asserted against Postgres in
 * `src/lib/services/statistics.test.ts`, where the fixture can state exactly
 * which purchases exist. Re-asserting numbers here would mean either seeding
 * from the browser or reading whatever the shared dev database happens to hold,
 * and both produce a test that fails for reasons that have nothing to do with
 * the screen.
 *
 * What it does pin is the thing a unit test cannot: that the route renders at
 * all. It is a server component doing four database queries behind an auth
 * check, which is a shape that fails as a 500 rather than as a type error.
 */
test("the statistics screen renders, in both periods", async ({ page }) => {
  await page.goto("/statistik");
  await expect(page.getByRole("heading", { name: "Statistik" })).toBeVisible();

  await page.getByRole("link", { name: "Allt" }).click();
  await expect(page).toHaveURL(/period=allt/);
  await expect(page.getByRole("heading", { name: "Statistik" })).toBeVisible();

  // Reachable without knowing the URL — the header is full, so it lives behind
  // the same affordance as everything else you look at once a month.
  await page.goto("/installningar");
  await page.getByRole("link", { name: /Statistik/ }).click();
  await expect(page).toHaveURL(/\/statistik/);
});
