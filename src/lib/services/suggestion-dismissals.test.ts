import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { catalogItems, suggestionDismissals } from "@/db/schema";
import {
  dismissSuggestion,
  dismissedOn,
  restoreSuggestion,
} from "./suggestion-dismissals";

/**
 * "Inte den här gången", against the real database.
 *
 * A dismissal is household-wide on purpose — Anders ruled that dismissing for
 * both of you is the wanted behaviour, not a compromise. So there is no actor
 * column and nothing here asserts one.
 */

const RUN = randomUUID().slice(0, 8);
const items = {
  dismissed: `test-dismiss-a-${RUN}`,
  untouched: `test-dismiss-b-${RUN}`,
};

const TODAY = new Date(2026, 6, 30, 14, 0);
const TOMORROW = new Date(2026, 6, 31, 9, 0);

beforeAll(async () => {
  // Inserted directly rather than through the seed helper: these rows exist
  // only to satisfy the dismissal table's foreign key, and the seed derives ids
  // from names, which would collide across parallel runs.
  await db.insert(catalogItems).values(
    Object.values(items).map((id) => ({
      id,
      name: id,
      nameNorm: id,
      categoryId: "frukt-gront",
      iconRef: "1F34E",
      isCustom: true,
      // The per-field clock owners are NOT NULL — a create genuinely establishes
      // all four facts at once, so there is no honest way to leave them unset.
      nameUpdatedBy: "test-dismiss",
      categoryUpdatedBy: "test-dismiss",
      iconUpdatedBy: "test-dismiss",
      homeUpdatedBy: "test-dismiss",
      updatedBy: "test-dismiss",
    })),
  );
});

afterAll(async () => {
  const all = Object.values(items);
  await db
    .delete(suggestionDismissals)
    .where(inArray(suggestionDismissals.catalogItemId, all));
  await db.delete(catalogItems).where(inArray(catalogItems.id, all));
});

describe("suggestion dismissals", () => {
  it("silences an item for the rest of the day, and only that item", async () => {
    await dismissSuggestion(items.dismissed, TODAY);

    const today = await dismissedOn(TODAY);
    expect(today.has(items.dismissed)).toBe(true);
    expect(today.has(items.untouched)).toBe(false);
  });

  /**
   * The whole point of keying on a calendar day rather than a 24-hour window:
   * "not this time" means "ask me again tomorrow", not "ask me in 24 hours".
   * Dismiss the milk at 14:00 and it should be back the next morning, not at
   * 14:00 the next day.
   */
  it("lets the suggestion come back the next day", async () => {
    await dismissSuggestion(items.dismissed, TODAY);
    const tomorrow = await dismissedOn(TOMORROW);
    expect(tomorrow.has(items.dismissed)).toBe(false);
  });

  /**
   * Two taps, or a retried request, must not fail. The primary key is
   * (item, day), so the second write has nothing to add — but an unguarded
   * insert would throw, and a dismissal that 500s on the second tap is a
   * dismissal the user assumes did not work.
   */
  it("is idempotent within a day", async () => {
    await dismissSuggestion(items.dismissed, TODAY);
    await expect(
      dismissSuggestion(items.dismissed, new Date(2026, 6, 30, 21, 30)),
    ).resolves.not.toThrow();

    const rows = await db
      .select()
      .from(suggestionDismissals)
      .where(inArray(suggestionDismissals.catalogItemId, [items.dismissed]));
    expect(rows).toHaveLength(1);
  });
  /**
   * Undo. The gesture that dismisses is a long-press on the tile, which acts
   * immediately rather than opening a sheet — so the safety valve is an "Ångra"
   * in the section heading, exactly as buying an item already works. That undo
   * has to reach the server, or the suggestion returns on this device and stays
   * gone on the other one.
   */
  it("can be taken back", async () => {
    await dismissSuggestion(items.dismissed, TODAY);
    await restoreSuggestion(items.dismissed, TODAY);
    expect((await dismissedOn(TODAY)).has(items.dismissed)).toBe(false);
  });

  it("is safe to take back something that was never dismissed", async () => {
    // The undo can be tapped twice, and a retry must not 500 — the outcome is
    // the same either way.
    await expect(
      restoreSuggestion(items.untouched, TODAY),
    ).resolves.not.toThrow();
  });
});
