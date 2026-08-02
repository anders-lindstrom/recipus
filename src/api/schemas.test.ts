import { describe, expect, it } from "vitest";
import {
  emptyState,
  entryId,
  manualContributionId,
  recipeContributionId,
} from "@/lib/domain";
import { applyOp, type Op } from "@/lib/sync";
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
