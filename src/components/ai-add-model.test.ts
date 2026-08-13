import { describe, expect, it } from "vitest";
import type { AiRow } from "@/lib/ai-add";
import type { CatalogItem, Id } from "@/lib/domain";
import { initialTicked, planAdditions } from "./ai-add-model";

function row(over: Partial<AiRow> & { id: string }): AiRow {
  return {
    said: over.name ?? over.id,
    name: over.name ?? over.id,
    amount: null,
    catalogItemId: null,
    group: "list",
    ...over,
  };
}

function vara(id: Id, name: string): CatalogItem {
  return {
    id,
    name,
    nameNorm: name,
    categoryId: "mejeri",
    iconRef: "1F95B",
    isCustom: false,
    hasAtHome: false,
    hidden: false,
    useCount: 0,
    lastUsedAt: null,
  };
}

describe("initialTicked", () => {
  it("ticks the list group", () => {
    const rows = [row({ id: "r0", catalogItemId: "mjolk" })];
    expect(initialTicked(rows, new Set())).toEqual(new Set(["r0"]));
  });

  it("leaves the suggestion grid alone", () => {
    const rows = [row({ id: "r0", catalogItemId: "mjolk", group: "other" })];
    expect(initialTicked(rows, new Set())).toEqual(new Set());
  });

  it("ticks a vara that does not exist yet", () => {
    const rows = [row({ id: "r0", name: "oatly ikaffe" })];
    expect(initialTicked(rows, new Set())).toEqual(new Set(["r0"]));
  });

  it("does NOT tick something already on the list", () => {
    /*
     * Not tidiness. `applyOpToDatabase` retracts a purchase of the same vara
     * from the last half hour when it is added back (RETRACT_WINDOW_MS), so a
     * ticked row here would silently delete köphistorik for a vara somebody
     * ticked off in the shop twenty minutes ago.
     */
    const rows = [row({ id: "r0", catalogItemId: "mjolk" })];
    expect(initialTicked(rows, new Set(["mjolk"]))).toEqual(new Set());
  });
});

describe("planAdditions", () => {
  const catalog: Record<Id, CatalogItem> = { mjolk: vara("mjolk", "mjölk") };

  it("adds a matched vara with its amount", () => {
    const rows = [
      row({ id: "r0", catalogItemId: "mjolk", amount: { value: 2, unit: "l" } }),
    ];
    expect(planAdditions(rows, new Set(["r0"]), catalog)).toEqual({
      creates: [],
      adds: [{ catalogItemId: "mjolk", amount: { value: 2, unit: "l" } }],
    });
  });

  it("skips a row that was unticked", () => {
    const rows = [row({ id: "r0", catalogItemId: "mjolk" })];
    expect(planAdditions(rows, new Set(), catalog).adds).toEqual([]);
  });

  it("creates an unmatched vara in Övrigt and adds it", () => {
    const rows = [row({ id: "r0", name: "Oatly iKaffe" })];
    const plan = planAdditions(rows, new Set(["r0"]), catalog);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]!.name).toBe("Oatly iKaffe");
    expect(plan.creates[0]!.categoryId).toBe("ovrigt");
    expect(plan.creates[0]!.isCustom).toBe(true);
    expect(plan.adds).toEqual([
      { catalogItemId: plan.creates[0]!.id, amount: null },
    ]);
  });

  it("reuses a vara whose name already exists rather than re-creating it", () => {
    /*
     * `create_catalog_item` REPLACES the row wholesale when it wins on clock,
     * so re-creating mjölk would reset its aisle, icon and hidden flag —
     * silently undoing a re-filing somebody did on /varor. Same guard as
     * `ensureVara` in list-client.
     */
    const rows = [row({ id: "r0", name: "mjolk" })];
    const plan = planAdditions(rows, new Set(["r0"]), catalog);
    expect(plan.creates).toEqual([]);
    expect(plan.adds).toEqual([{ catalogItemId: "mjolk", amount: null }]);
  });

  it("creates one vara when two ticked rows name the same new thing", () => {
    const rows = [row({ id: "r0", name: "krabbklor" }), row({ id: "r1", name: "krabbklor" })];
    const plan = planAdditions(rows, new Set(["r0", "r1"]), catalog);
    expect(plan.creates).toHaveLength(1);
    expect(plan.adds).toHaveLength(1);
  });
});
