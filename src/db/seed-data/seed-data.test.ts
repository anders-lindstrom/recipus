import { describe, expect, it } from "vitest";
import { CATEGORIES } from "./categories";
import { CATALOG_ITEMS } from "./catalog";
import { STARTER_ITEMS } from "./starter-list";

const ICON_REF_RE = /^[0-9A-F]{4,6}(-[0-9A-F]{4,6})*$/;

function iconRefToEmoji(iconRef: string): string {
  return iconRef
    .split("-")
    .map((hex) => String.fromCodePoint(parseInt(hex, 16)))
    .join("");
}

describe("seed categories", () => {
  it("has unique slugs", () => {
    const slugs = CATEGORIES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("has positions that are unique and contiguous from 0", () => {
    const positions = CATEGORIES.map((c) => c.position).sort((a, b) => a - b);
    expect(positions).toEqual(CATEGORIES.map((_, i) => i));
  });

  it("puts produce first and ovrigt last", () => {
    const bySlug = new Map(CATEGORIES.map((c) => [c.slug, c.position]));
    expect(bySlug.get("frukt-gront")).toBe(0);
    expect(bySlug.get("ovrigt")).toBe(CATEGORIES.length - 1);
  });

  it("every category has at least 3 items", () => {
    const counts = new Map<string, number>();
    for (const item of CATALOG_ITEMS) {
      counts.set(item.categorySlug, (counts.get(item.categorySlug) ?? 0) + 1);
    }
    for (const category of CATEGORIES) {
      expect(counts.get(category.slug) ?? 0).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("seed catalog", () => {
  it("has an item count within the seeded range", () => {
    expect(CATALOG_ITEMS.length).toBeGreaterThanOrEqual(280);
    // Ceiling raised from 340: generic heads Swedish recipes actually use
    // (lök, grädde, olja, mjöl, köttfärs) were missing, so every recipe naming
    // them imported as NY VARA instead of matching a real item.
    expect(CATALOG_ITEMS.length).toBeLessThanOrEqual(380);
  });

  it("has no duplicate item names", () => {
    const names = CATALOG_ITEMS.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("references only category slugs that exist", () => {
    const slugs = new Set(CATEGORIES.map((c) => c.slug));
    for (const item of CATALOG_ITEMS) {
      expect(slugs.has(item.categorySlug)).toBe(true);
    }
  });

  it("has at least 20 items flagged hasAtHome", () => {
    const count = CATALOG_ITEMS.filter((i) => i.hasAtHome).length;
    expect(count).toBeGreaterThanOrEqual(20);
  });

  it("gives every item a non-empty emoji and a well-formed iconRef", () => {
    for (const item of CATALOG_ITEMS) {
      expect(item.emoji.length).toBeGreaterThan(0);
      expect(item.iconRef).toMatch(ICON_REF_RE);
    }
  });

  it("round-trips every iconRef back to its recorded emoji", () => {
    for (const item of CATALOG_ITEMS) {
      expect(iconRefToEmoji(item.iconRef)).toBe(item.emoji);
    }
  });
});

describe("starter list", () => {
  /**
   * The one that has to hold: a starter item naming a vara that does not exist
   * fails on `list_entries.catalog_item_id`'s foreign key, and only on a
   * genuinely fresh database — which is the single case nobody re-runs.
   */
  it("names only varor that exist in the catalog", () => {
    const names = new Set(CATALOG_ITEMS.map((i) => i.name));
    for (const name of STARTER_ITEMS) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(STARTER_ITEMS).size).toBe(STARTER_ITEMS.length);
  });

  /**
   * Enough aisles that the first screen shows the walking order doing something.
   * A starter list from one shelf renders as a single undifferentiated column
   * and teaches nothing about what the grouping is for.
   */
  it("spans at least four aisles", () => {
    const categoryOf = new Map(
      CATALOG_ITEMS.map((i) => [i.name, i.categorySlug]),
    );
    const aisles = new Set(STARTER_ITEMS.map((name) => categoryOf.get(name)));
    expect(aisles.size).toBeGreaterThanOrEqual(4);
  });

  /**
   * Short on purpose. This is a demonstration you delete in a minute, not a
   * shopping list somebody has to disagree with item by item before they can use
   * their own.
   */
  it("stays short enough to clear in one pass", () => {
    expect(STARTER_ITEMS.length).toBeGreaterThanOrEqual(4);
    expect(STARTER_ITEMS.length).toBeLessThanOrEqual(10);
  });
});
