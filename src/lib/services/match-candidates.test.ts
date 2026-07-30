import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { catalogItems, catalogItemAliases } from "@/db/schema";
import { matchIngredient } from "@/lib/ingredients";
import { loadMatchCandidates } from "./match-candidates";

/**
 * The wiring that makes alias-on-merge actually do anything.
 *
 * `buildMatchCandidates` is unit-tested on its own, and `merge_catalog_items`
 * records the alias. Neither is worth anything until a caller loads the aliases
 * alongside the items — and that caller is exactly the sort of one-line join
 * nobody tests, which is why the merged-away word silently stopping resolving
 * would only be noticed months later by a recipe import that came back empty.
 */

const RUN = randomUUID().slice(0, 8);
const survivor = `test-cand-notfars-${RUN}`;
const mergedAway = `test-cand-kottfars-${RUN}`;
const alias = `test-cand-alias-${RUN}`;

beforeAll(async () => {
  await db.insert(catalogItems).values(
    [survivor, mergedAway].map((id) => ({
      id,
      name: id,
      nameNorm: id,
      categoryId: "frukt-gront",
      iconRef: "1F34E",
      isCustom: true,
      nameUpdatedBy: "test-cand",
      categoryUpdatedBy: "test-cand",
      iconUpdatedBy: "test-cand",
      homeUpdatedBy: "test-cand",
      updatedBy: "test-cand",
    })),
  );
  // The merged-away vara is tombstoned, and its word survives pointing at the
  // one that is left — exactly the state `merge_catalog_items` produces.
  await db
    .update(catalogItems)
    .set({ deletedAt: new Date() })
    .where(inArray(catalogItems.id, [mergedAway]));
  await db.insert(catalogItemAliases).values({
    aliasNorm: alias,
    catalogItemId: survivor,
    createdBy: "test-cand",
    updatedBy: "test-cand",
  });
});

afterAll(async () => {
  await db
    .delete(catalogItemAliases)
    .where(inArray(catalogItemAliases.aliasNorm, [alias]));
  await db
    .delete(catalogItems)
    .where(inArray(catalogItems.id, [survivor, mergedAway]));
});

describe("loadMatchCandidates", () => {
  it("resolves a merged-away word to the vara that survived", async () => {
    const candidates = await loadMatchCandidates();
    const match = matchIngredient(alias, candidates);
    expect(match?.id).toBe(survivor);
  });

  /**
   * A tombstoned vara must not be offered.
   *
   * Filtering is deliberately the caller's job rather than the matcher's — the
   * matcher scores a list and knows nothing about deletion — so this is the only
   * place the rule exists, and the only place it can be got wrong. Without it a
   * recipe import would keep attaching ingredients to a vara the household has
   * explicitly merged away, and they would reappear on lists.
   */
  it("never offers a tombstoned vara", async () => {
    const candidates = await loadMatchCandidates();
    expect(candidates.some((c) => c.id === mergedAway)).toBe(false);
    // And the survivor is genuinely there, so the assertion above is not passing
    // because the query returned nothing at all.
    expect(candidates.some((c) => c.id === survivor)).toBe(true);
  });
});
