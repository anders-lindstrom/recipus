import { describe, expect, it } from "vitest";
import type { CatalogItem } from "@/lib/domain";
import { normalizeName } from "@/lib/utils";
import { frequentVaror } from "./frequent";

const NOW = new Date("2026-08-01T12:00:00Z");
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

function item(
  name: string,
  useCount: number,
  lastUsedAt: string | null,
  hidden = false,
): CatalogItem {
  return {
    id: name,
    name,
    nameNorm: normalizeName(name),
    categoryId: "test",
    iconRef: "1F4E6",
    isCustom: false,
    hasAtHome: false,
    hidden,
    useCount,
    lastUsedAt,
  };
}

describe("frequentVaror", () => {
  /*
   * The shape that motivated this, taken from a synthetic twelve-week history.
   * Sorted by raw `useCount` the panel led with cucumber bought the day before
   * and spent two of its six slots on a finished strawberry season and a
   * four-times-in-three-months spice.
   */
  const HOUSEHOLD = [
    item("gurka", 12, daysAgo(1)),
    item("yoghurt", 12, daysAgo(6)),
    item("smör", 6, daysAgo(13)),
    item("bryggkaffe", 5, daysAgo(15)),
    item("jordgubbar", 4, daysAgo(51)),
    item("kanel", 4, daysAgo(8)),
    item("ananas", 0, null),
  ];

  it("puts the abandoned season below everything still being bought", () => {
    const names = frequentVaror(HOUSEHOLD, { now: NOW, limit: 6 }).map(
      (c) => c.name,
    );
    expect(names.indexOf("jordgubbar")).toBe(names.length - 1);
    expect(names.indexOf("kanel")).toBeLessThan(names.indexOf("jordgubbar"));
  });

  it("prefers a lightly-used recent vara to a heavily-used stale one", () => {
    const catalog = [
      item("lättmjölk", 40, daysAgo(200)),
      item("mellanmjölk", 8, daysAgo(3)),
    ];
    expect(
      frequentVaror(catalog, { now: NOW, limit: 6 }).map((c) => c.name),
    ).toEqual(["mellanmjölk", "lättmjölk"]);
  });

  it("never offers a vara with no shops behind it", () => {
    const names = frequentVaror(HOUSEHOLD, { now: NOW, limit: 10 }).map(
      (c) => c.name,
    );
    expect(names).not.toContain("ananas");
  });

  it("excludes hidden varor outright rather than demoting them", () => {
    const catalog = [item("mjölk", 5, daysAgo(2)), item("mjölkpulver", 9, daysAgo(1), true)];
    expect(
      frequentVaror(catalog, { now: NOW, limit: 6 }).map((c) => c.name),
    ).toEqual(["mjölk"]);
  });

  it("excludes what is already on the list", () => {
    const names = frequentVaror(HOUSEHOLD, {
      now: NOW,
      limit: 6,
      excludeItemIds: new Set(["gurka", "yoghurt"]),
    }).map((c) => c.name);
    expect(names).not.toContain("gurka");
    expect(names).not.toContain("yoghurt");
    expect(names[0]).toBe("smör");
  });

  it("respects the limit", () => {
    expect(frequentVaror(HOUSEHOLD, { now: NOW, limit: 3 })).toHaveLength(3);
  });

  it("falls back to use count on a fresh install, where nothing has a last-used date", () => {
    // Every score is 0 here; the ordering must not collapse to alphabetical.
    const catalog = [item("ost", 2, null), item("bröd", 9, null)];
    expect(
      frequentVaror(catalog, { now: NOW, limit: 6 }).map((c) => c.name),
    ).toEqual(["bröd", "ost"]);
  });
});
