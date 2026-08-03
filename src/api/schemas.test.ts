import { describe, expect, it } from "vitest";
import {
  emptyState,
  entryId,
  manualContributionId,
  recipeContributionId,
} from "@/lib/domain";
import { applyOp, type Op, type OpKind } from "@/lib/sync";
import { opSchema } from "./schemas";

/**
 * The wire schema against the type the reducer actually consumes.
 *
 * These are two independent declarations of the same shape — `Op` in
 * src/lib/sync/ops.ts and `opSchema` here — and nothing makes them agree. A
 * field present in one and missing from the other does not fail to compile: the
 * op is simply refused at the door with a 400, or parses with the field
 * stripped, and either way the client's outbox re-posts it forever while the
 * change never lands. Silent in exactly the way this codebase keeps being bitten
 * by.
 *
 * `move_item` is checked because it is the only op carrying a nested payload,
 * and because its whole correctness rests on that payload surviving the trip.
 */
describe("opSchema round trip", () => {
  const move = {
    kind: "move_item" as const,
    clientOpId: "op-1",
    actor: "anders",
    at: "2026-03-12T10:05:00.000Z",
    fromListId: "hemkop",
    toListId: "bauhaus",
    catalogItemId: "gradde",
    priority: "urgent" as const,
    manual: {
      amount: { value: 5, unit: "dl" as const },
      note: "helst ekologisk",
      modifier: "vispgrädde",
    },
  };

  it("keeps everything a move carries, all the way into the reducer", () => {
    const parsed = opSchema.parse(move);
    expect(parsed).toEqual(move);

    // Parsed, not the literal: a field zod quietly dropped would show up here as
    // a destination that arrived empty, which is the defect this op exists to
    // fix.
    const state = applyOp(emptyState(), parsed as Op);
    const arrived = state.contributions[manualContributionId(entryId("bauhaus", "gradde"))];
    expect(arrived.amount).toEqual({ value: 5, unit: "dl" });
    expect(arrived.note).toBe("helst ekologisk");
    expect(arrived.modifier).toBe("vispgrädde");
    expect(state.entries[entryId("bauhaus", "gradde")].priority).toBe("urgent");
  });

  it("accepts a move of an item nobody had qualified", () => {
    const bare = { ...move, priority: "normal" as const, manual: null };
    expect(opSchema.parse(bare)).toEqual(bare);
  });

  it("refuses a move that names no payload at all", () => {
    // The reducer has no sensible reading of a move with no priority: it would
    // have to invent one, and inventing "normal" would silently demote every
    // urgent item anyone ever moved.
    const { priority: _priority, ...withoutPriority } = move;
    expect(opSchema.safeParse(withoutPriority).success).toBe(false);
  });
});

/**
 * The other op whose whole point is a payload surviving the trip.
 *
 * A merge re-points a recipe's share of the ask with this, so a field stripped
 * at the door does not fail loudly: the share arrives with no amount, or the op
 * is refused with a 400 the outbox retries forever, and either way the recipe
 * quietly stops asking for what it asked for.
 */
describe("repoint_recipe_item round trip", () => {
  const repoint = {
    kind: "repoint_recipe_item" as const,
    clientOpId: "op-2",
    actor: "anders",
    at: "2026-08-02T09:00:00.000Z",
    listId: "hemkop",
    recipeAdditionId: "ra-1",
    fromCatalogItemId: "kycklingbrostfile",
    toCatalogItemId: "kycklingfile",
    amount: { value: 1200, unit: "g" as const },
  };

  it("carries the share onto the surviving vara, amount and all", () => {
    const parsed = opSchema.parse(repoint);
    expect(parsed).toEqual(repoint);

    const state = applyOp(emptyState(), parsed as Op);
    const moved = state.contributions[recipeContributionId("ra-1", "kycklingfile")];
    expect(moved).toMatchObject({
      sourceKind: "recipe",
      recipeAdditionId: "ra-1",
      amount: { value: 1200, unit: "g" },
    });
    expect(state.entries[entryId("hemkop", "kycklingfile")].removedAt).toBeNull();
  });

  it("accepts a share nobody put a quantity on", () => {
    const bare = { ...repoint, amount: null };
    expect(opSchema.parse(bare)).toEqual(bare);
  });
});

/**
 * Every op kind, carrying every field it is allowed to carry.
 *
 * The two suites above check the two ops whose payloads were known to be
 * fragile. They could not catch the defect that prompted this one, because the
 * defect was in an op nobody thought was fragile: `add_item` grew
 * `keepsPurchase`, `opSchema` did not, and zod strips what it does not declare.
 * The op parsed, applied, and quietly did the opposite of what the scanner
 * asked — a second bottle of the same thing retracted the purchase of the
 * first. No test failed, because every test of that behaviour called `applyOp`
 * directly and never went through the door the real op comes in by.
 *
 * So this is keyed by `OpKind` rather than written as an array. A new kind
 * added to `Op` does not compile until it appears here, and a new *field* on an
 * existing kind fails the round trip the moment it is set below — which is the
 * half that actually bit. Neither is caught by the type checker alone: `Op` and
 * `opSchema` are two independent declarations, and TypeScript has never had an
 * opinion about whether they agree.
 */
const MAXIMAL: { [K in OpKind]: Extract<Op, { kind: K }> } = {
  create_list: {
    kind: "create_list",
    clientOpId: "op-create-list",
    actor: "anders",
    at: "2026-08-03T10:00:00.000Z",
    listId: "hemkop",
    name: "Hemköp",
    icon: "1F6D2",
    position: 0,
    categoryOrder: ["frukt-gront", "mejeri"],
  },
  update_list: {
    kind: "update_list",
    clientOpId: "op-update-list",
    actor: "anders",
    at: "2026-08-03T10:01:00.000Z",
    listId: "hemkop",
    patch: {
      name: "Hemköp Centrum",
      icon: "1F3EA",
      position: 2,
      categoryOrder: ["mejeri", "frukt-gront"],
    },
  },
  delete_list: {
    kind: "delete_list",
    clientOpId: "op-delete-list",
    actor: "anders",
    at: "2026-08-03T10:02:00.000Z",
    listId: "bauhaus",
  },
  create_catalog_item: {
    kind: "create_catalog_item",
    clientOpId: "op-create-vara",
    actor: "anders",
    at: "2026-08-03T10:03:00.000Z",
    item: {
      id: "havremjolk",
      name: "havremjölk",
      nameNorm: "havremjolk",
      categoryId: "mejeri",
      iconRef: "1F95B",
      isCustom: true,
      hasAtHome: false,
      hidden: false,
      useCount: 4,
      lastUsedAt: "2026-07-30T08:00:00.000Z",
    },
  },
  update_catalog_item: {
    kind: "update_catalog_item",
    clientOpId: "op-update-vara",
    actor: "anders",
    at: "2026-08-03T10:04:00.000Z",
    itemId: "havremjolk",
    patch: {
      name: "havredryck",
      nameNorm: "havredryck",
      categoryId: "mejeri",
      iconRef: "1F95B",
      isCustom: true,
      hasAtHome: true,
      hidden: true,
      useCount: 5,
      lastUsedAt: "2026-08-01T08:00:00.000Z",
    },
  },
  add_item: {
    kind: "add_item",
    clientOpId: "op-add",
    actor: "anders",
    at: "2026-08-03T10:05:00.000Z",
    listId: "hemkop",
    catalogItemId: "mjolk",
    undoesClientOpId: "op-removed-earlier",
    // The field this suite exists for. Set deliberately: a schema that drops it
    // makes the second scan of an identical pack take back the first one's
    // purchase, which is the one direction that corrupts cadence silently.
    keepsPurchase: true,
  },
  remove_item: {
    kind: "remove_item",
    clientOpId: "op-remove",
    actor: "anders",
    at: "2026-08-03T10:06:00.000Z",
    listId: "hemkop",
    catalogItemId: "mjolk",
    bought: true,
    productId: "prod:7310865004703",
  },
  set_amount: {
    kind: "set_amount",
    clientOpId: "op-amount",
    actor: "anders",
    at: "2026-08-03T10:07:00.000Z",
    listId: "hemkop",
    catalogItemId: "gradde",
    amount: { value: 5, unit: "dl" },
  },
  set_note: {
    kind: "set_note",
    clientOpId: "op-note",
    actor: "anders",
    at: "2026-08-03T10:08:00.000Z",
    listId: "hemkop",
    catalogItemId: "gradde",
    note: "den i blå kartong",
  },
  set_modifier: {
    kind: "set_modifier",
    clientOpId: "op-modifier",
    actor: "anders",
    at: "2026-08-03T10:09:00.000Z",
    listId: "hemkop",
    catalogItemId: "gradde",
    modifier: "vispgrädde",
  },
  set_priority: {
    kind: "set_priority",
    clientOpId: "op-priority",
    actor: "anders",
    at: "2026-08-03T10:10:00.000Z",
    listId: "hemkop",
    catalogItemId: "gradde",
    priority: "urgent",
  },
  add_recipe: {
    kind: "add_recipe",
    clientOpId: "op-add-recipe",
    actor: "anders",
    at: "2026-08-03T10:11:00.000Z",
    listId: "hemkop",
    recipeId: "recept-1",
    recipeAdditionId: "ra-1",
    scaleFactor: 1.5,
    items: [
      { catalogItemId: "gradde", amount: { value: 3, unit: "dl" } },
      { catalogItemId: "salt", amount: null },
    ],
  },
  remove_recipe: {
    kind: "remove_recipe",
    clientOpId: "op-remove-recipe",
    actor: "anders",
    at: "2026-08-03T10:12:00.000Z",
    listId: "hemkop",
    recipeAdditionId: "ra-1",
  },
  repoint_recipe_item: {
    kind: "repoint_recipe_item",
    clientOpId: "op-repoint",
    actor: "anders",
    at: "2026-08-03T10:13:00.000Z",
    listId: "hemkop",
    recipeAdditionId: "ra-1",
    fromCatalogItemId: "kycklingbrostfile",
    toCatalogItemId: "kycklingfile",
    amount: { value: 1200, unit: "g" },
  },
  move_item: {
    kind: "move_item",
    clientOpId: "op-move",
    actor: "anders",
    at: "2026-08-03T10:14:00.000Z",
    fromListId: "hemkop",
    toListId: "bauhaus",
    catalogItemId: "gradde",
    priority: "convenient",
    manual: {
      amount: { value: 5, unit: "dl" },
      note: "helst ekologisk",
      modifier: "vispgrädde",
    },
  },
  create_product: {
    kind: "create_product",
    clientOpId: "op-create-product",
    actor: "anders",
    at: "2026-08-03T10:15:00.000Z",
    product: {
      id: "prod:7310865004703",
      name: "Arla Mellanmjölk",
      brand: "Arla",
      catalogItemId: "mjolk",
      defaultSize: { value: 1.5, unit: "l" },
      sourceSizeText: "1,5 l",
      imageUrl: "https://images.openfoodfacts.org/mjolk.jpg",
      createdAt: "2026-08-03T10:15:00.000Z",
      createdBy: "anders",
    },
  },
  update_product: {
    kind: "update_product",
    clientOpId: "op-update-product",
    actor: "anders",
    at: "2026-08-03T10:16:00.000Z",
    productId: "prod:7310865004703",
    patch: {
      name: "Arla Mellanmjölk 1,5 l",
      brand: "Arla",
      catalogItemId: "mjolk",
      defaultSize: { value: 1.5, unit: "l" },
      sourceSizeText: "1,5 l",
    },
  },
  link_barcode: {
    kind: "link_barcode",
    clientOpId: "op-link-barcode",
    actor: "anders",
    at: "2026-08-03T10:17:00.000Z",
    ean: "7310865004703",
    productId: "prod:7310865004703",
    source: "manual",
  },
  delete_catalog_item: {
    kind: "delete_catalog_item",
    clientOpId: "op-delete-vara",
    actor: "anders",
    at: "2026-08-03T10:18:00.000Z",
    itemId: "havremjolk",
  },
  merge_catalog_items: {
    kind: "merge_catalog_items",
    clientOpId: "op-merge",
    actor: "anders",
    at: "2026-08-03T10:19:00.000Z",
    fromItemId: "creme-fraiche",
    toItemId: "creme-fraiche-ratt",
    aliasNorm: "creme fraiche",
  },
};

describe("every op kind survives the wire", () => {
  const kinds = Object.keys(MAXIMAL) as OpKind[];

  it.each(kinds)("%s keeps every field it carries", (kind) => {
    const op = MAXIMAL[kind];
    const parsed = opSchema.parse(op);
    // toEqual rather than a field-by-field check: this has to fail for a field
    // nobody thought to assert on, since that is the only kind that has ever
    // gone missing here.
    expect(parsed).toEqual(op);
  });

  /**
   * The other field this suite found missing, and the one that was worse.
   *
   * `hidden` is a household opinion with its own last-write-wins clock
   * (`catalog:${id}:hidden`), its own database columns, and a reducer branch —
   * and `catalogItemSchema` did not declare it. So "dölj den här varan"
   * applied on the phone that asked, was stripped at the door, never persisted,
   * and never reached the other phone: two devices disagreeing forever with no
   * error anywhere, which is the exact failure the op log exists to rule out.
   */
  it("carries a hide all the way into the reducer", () => {
    const seeded = applyOp(emptyState(), MAXIMAL.create_catalog_item);
    const parsed = opSchema.parse(MAXIMAL.update_catalog_item) as Op;
    const hiddenState = applyOp(seeded, parsed);
    expect(hiddenState.catalog.havremjolk.hidden).toBe(true);
  });

  it("stays silent about hiding when the patch is", () => {
    // The half that makes the default safe. A rename must not stamp the hidden
    // clock, or an op with no opinion about hiding beats one that has one — the
    // moving-clock bug this codebase has now paid for four times.
    const rename = {
      ...MAXIMAL.update_catalog_item,
      patch: { name: "havredryck", nameNorm: "havredryck" },
    };
    const parsed = opSchema.parse(rename);
    expect(parsed).toEqual(rename);
    expect("hidden" in (parsed as { patch: object }).patch).toBe(false);
  });

  it("reads an op written before hiding existed as hiding nothing", () => {
    // Ops already in the log predate the field. They must parse and mean what
    // they meant the day they were written, which is "not hidden".
    const { hidden: _hidden, ...itemWithoutHidden } =
      MAXIMAL.create_catalog_item.item;
    const old = { ...MAXIMAL.create_catalog_item, item: itemWithoutHidden };
    const parsed = opSchema.parse(old) as Extract<Op, { kind: "create_catalog_item" }>;
    expect(parsed.item.hidden).toBe(false);
  });

  it("covers the union the reducer actually switches on", () => {
    // `opListId` switches over every kind exhaustively, so it throws nothing and
    // returns for all of them. If a kind existed that MAXIMAL had not declared,
    // the mapped type above would already have failed to compile — this asserts
    // the count is what a human expects, so an accidental deletion from the
    // table is visible rather than silently reducing coverage.
    expect(kinds).toHaveLength(20);
  });
});
