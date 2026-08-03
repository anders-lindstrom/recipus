import { describe, expect, it } from "vitest";
import {
  emptyState,
  entryId,
  manualContributionId,
  type CatalogItem,
  type SyncState,
} from "@/lib/domain";
import { applyOps } from "@/lib/sync/reducer";
import type { Op } from "@/lib/sync/ops";
import { normalizeName } from "@/lib/utils";
import { newVaraLike, splitSortOps, visibleSuggestions } from "./list-model";
import type { OpDraft } from "./varor-model";

/**
 * Splitting a sort into a vara of its own.
 *
 * The whole feature exists because an entry is `(listId, catalogItemId)` and a
 * sort lives on its manual contribution, so "blåbär" and "mogna blåbär" could
 * not both be on one list — and the app's answer was to overwrite one with the
 * other in silence. These tests are about the two things that could put that
 * bug back: what travels to the new vara, and what is left behind on the old
 * one.
 *
 * The interesting assertions are made by REPLAYING the plan through the real
 * reducer rather than by reading the op list, because the ordering bug this is
 * guarding against is invisible in a list of ops and obvious in the state they
 * produce.
 */

const LIST = "hemkop";

function at(minutes: number): string {
  // Fixed clock, as everywhere else in this codebase: a test that depends on
  // wall time is a test that fails at midnight.
  return new Date(Date.UTC(2026, 6, 30, 9, minutes, 0)).toISOString();
}

function item(id: string, name = id): CatalogItem {
  return {
    id,
    name,
    nameNorm: normalizeName(name),
    categoryId: "frukt-gront",
    iconRef: "1FAD0",
    isCustom: false,
    hasAtHome: false,
    hidden: false,
    useCount: 0,
    lastUsedAt: null,
  };
}

/**
 * Build state the way the app does — by applying ops — so a fixture can never
 * describe a state the reducer cannot reach.
 */
function stateFrom(ops: OpDraft[]): SyncState {
  return applyOps(
    emptyState(),
    ops.map((op, i) => ({
      ...op,
      clientOpId: `op-${i}`,
      actor: "anders",
      at: at(i),
    })) as Op[],
  );
}

/** The plan, replayed through the reducer, starting from `before`. */
function after(
  before: SyncState,
  plan: OpDraft[],
): SyncState {
  return applyOps(
    before,
    plan.map((op, i) => ({
      ...op,
      clientOpId: `split-${i}`,
      actor: "anders",
      // Strictly after everything `stateFrom` wrote, and strictly increasing —
      // two ops sharing a timestamp cannot be ordered by last-write-wins, so the
      // second would silently lose.
      at: at(100 + i),
    })) as Op[],
  );
}

/** "blåbär" on the list, asked for as 2 kg of the ripe ones. */
function ripeBlueberriesOnList(): SyncState {
  return stateFrom([
    { kind: "create_catalog_item", item: item("blabar", "Blåbär") },
    {
      kind: "create_list",
      listId: LIST,
      name: "Hemköp",
      icon: "1F6D2",
      position: 0,
      categoryOrder: [],
    },
    { kind: "add_item", listId: LIST, catalogItemId: "blabar" },
    {
      kind: "set_amount",
      listId: LIST,
      catalogItemId: "blabar",
      amount: { value: 2, unit: "kg" },
    },
    {
      kind: "set_modifier",
      listId: LIST,
      catalogItemId: "blabar",
      modifier: "mogna",
    },
  ]);
}

const BASE_ENTRY = entryId(LIST, "blabar");
const NEW_ENTRY = entryId(LIST, "blabar-mogna");

describe("splitSortOps", () => {
  it("gives the sort its own vara, filed beside the original", () => {
    const state = ripeBlueberriesOnList();
    const next = after(
      state,
      splitSortOps(state, LIST, "blabar", "blåbär mogna", { keepPlain: true }),
    );

    const created = next.catalog["blabar-mogna"];
    expect(created).toBeDefined();
    expect(created.name).toBe("blåbär mogna");
    // Inherited, and this is the point of inheriting at all: a vara created
    // without an aisle lands in Övrigt, which sorts LAST, so the supported way
    // to keep two kinds apart used to put one of them at the wrong end of the
    // shop.
    expect(created.categoryId).toBe("frukt-gront");
    expect(created.iconRef).toBe("1FAD0");
    expect(created.isCustom).toBe(true);
    expect(created.hidden).toBe(false);
  });

  it("moves the amount onto the new vara and off the old one", () => {
    const state = ripeBlueberriesOnList();
    const next = after(
      state,
      splitSortOps(state, LIST, "blabar", "blåbär mogna", { keepPlain: true }),
    );

    expect(next.contributions[manualContributionId(NEW_ENTRY)]?.amount).toEqual({
      value: 2,
      unit: "kg",
    });
    // The 2 kg was an ask for the RIPE ones. Leaving it on the plain entry would
    // silently double the household's blueberries.
    expect(
      next.contributions[manualContributionId(BASE_ENTRY)]?.amount ?? null,
    ).toBeNull();
  });

  it("keeps both kinds on the list when the plain one was just asked for", () => {
    const state = ripeBlueberriesOnList();
    const next = after(
      state,
      splitSortOps(state, LIST, "blabar", "blåbär mogna", {
        keepPlain: true,
        plainAmountText: "1 st",
      }),
    );

    // The whole reported bug, in one assertion: two entries, both live.
    expect(next.entries[BASE_ENTRY]?.removedAt).toBeNull();
    expect(next.entries[NEW_ENTRY]?.removedAt).toBeNull();
    // And the plain one carries what was actually typed for it.
    expect(next.contributions[manualContributionId(BASE_ENTRY)]?.amount).toEqual({
      value: 1,
      unit: "st",
    });
    expect(
      next.contributions[manualContributionId(BASE_ENTRY)]?.modifier ?? null,
    ).toBeNull();
  });

  it("takes the plain kind off the list when nobody asked for it", () => {
    const state = ripeBlueberriesOnList();
    const next = after(
      state,
      splitSortOps(state, LIST, "blabar", "blåbär mogna", { keepPlain: false }),
    );

    expect(next.entries[BASE_ENTRY]?.removedAt).not.toBeNull();
    expect(next.entries[NEW_ENTRY]?.removedAt).toBeNull();
  });

  it("does not record a purchase when the plain kind comes off", () => {
    const state = ripeBlueberriesOnList();
    const plan = splitSortOps(state, LIST, "blabar", "blåbär mogna", {
      keepPlain: false,
    });

    const removal = plan.find((op) => op.kind === "remove_item");
    expect(removal).toBeDefined();
    // Tidying your own vocabulary is not shopping. `bought: true` here would
    // teach the cadence engine that this household buys blueberries every time
    // it renames something.
    expect(removal).toMatchObject({ bought: false });
  });

  /**
   * The ordering bug, and the reason this plan is a pure function.
   *
   * `remove_item` tombstones the entry and leaves its contributions exactly
   * where they are. Emit the removal before clearing the sort and the row
   * survives under the tombstone — so re-adding plain blåbär next week
   * resurrects "2 kg mogna" on it, which is the very ghost this feature exists
   * to remove, reintroduced by the fix for it.
   */
  it("clears the old ask before the entry is removed, so re-adding is clean", () => {
    const state = ripeBlueberriesOnList();
    const removed = after(
      state,
      splitSortOps(state, LIST, "blabar", "blåbär mogna", { keepPlain: false }),
    );

    const readded = applyOps(removed, [
      {
        kind: "add_item",
        listId: LIST,
        catalogItemId: "blabar",
        clientOpId: "later",
        actor: "anders",
        at: at(500),
      } as Op,
    ]);

    expect(readded.entries[BASE_ENTRY]?.removedAt).toBeNull();
    const manual = readded.contributions[manualContributionId(BASE_ENTRY)];
    expect(manual?.modifier ?? null).toBeNull();
    expect(manual?.amount ?? null).toBeNull();
  });

  it("leaves the plain entry standing when a recipe still wants it", () => {
    const base = ripeBlueberriesOnList();
    const state = applyOps(base, [
      {
        kind: "add_recipe",
        listId: LIST,
        recipeId: "pannkakor",
        recipeAdditionId: "add-1",
        scaleFactor: 1,
        items: [{ catalogItemId: "blabar", amount: { value: 3, unit: "dl" } }],
        clientOpId: "recipe",
        actor: "anders",
        at: at(50),
      } as Op,
    ]);

    const next = after(
      state,
      splitSortOps(state, LIST, "blabar", "blåbär mogna", { keepPlain: false }),
    );

    // The recipe asked for blåbär, not for the ripe ones. Removing the entry
    // would silently drop an ingredient the recipe is still counting on.
    expect(next.entries[BASE_ENTRY]?.removedAt).toBeNull();
    // Its share is untouched — only the manual ask moved.
    expect(
      Object.values(next.contributions).find(
        (c) => c.entryId === BASE_ENTRY && c.sourceKind === "recipe",
      )?.amount,
    ).toEqual({ value: 3, unit: "dl" });
  });

  it("carries urgency to the new vara and resets it on the old one", () => {
    const base = ripeBlueberriesOnList();
    const state = applyOps(base, [
      {
        kind: "set_priority",
        listId: LIST,
        catalogItemId: "blabar",
        priority: "urgent",
        clientOpId: "prio",
        actor: "anders",
        at: at(50),
      } as Op,
    ]);

    const next = after(
      state,
      splitSortOps(state, LIST, "blabar", "blåbär mogna", { keepPlain: true }),
    );

    expect(next.entries[NEW_ENTRY]?.priority).toBe("urgent");
    // "Bråttom" belonged to the ask that has just moved out. Leaving it behind
    // would make the plain kind urgent for a reason nobody stated.
    expect(next.entries[BASE_ENTRY]?.priority).toBe("normal");
  });

  it("reuses an existing vara rather than overwriting it", () => {
    const base = ripeBlueberriesOnList();
    // Somebody has already made this vara and filed it somewhere deliberately.
    const state = applyOps(base, [
      {
        kind: "create_catalog_item",
        item: { ...item("blabar-mogna", "blåbär mogna"), categoryId: "frys" },
        clientOpId: "existing",
        actor: "anders",
        at: at(50),
      } as Op,
    ]);

    const plan = splitSortOps(state, LIST, "blabar", "blåbär mogna", {
      keepPlain: true,
    });

    // `create_catalog_item` REPLACES the row wholesale when it wins on clock, so
    // emitting one here would silently move the vara back out of Frys.
    expect(plan.some((op) => op.kind === "create_catalog_item")).toBe(false);
    expect(after(state, plan).catalog["blabar-mogna"].categoryId).toBe("frys");
  });

  it("un-hides an existing vara it is splitting onto", () => {
    const base = ripeBlueberriesOnList();
    const state = applyOps(base, [
      {
        kind: "create_catalog_item",
        item: { ...item("blabar-mogna", "blåbär mogna"), hidden: true },
        clientOpId: "existing",
        actor: "anders",
        at: at(50),
      } as Op,
    ]);

    const next = after(
      state,
      splitSortOps(state, LIST, "blabar", "blåbär mogna", { keepPlain: true }),
    );

    // Deliberately naming a vara is the household asking for it back. Splitting
    // onto one that stays hidden would put a tile on the list that search
    // refuses to offer again.
    expect(next.catalog["blabar-mogna"].hidden).toBe(false);
  });

  it("refuses to split a vara onto itself", () => {
    const state = ripeBlueberriesOnList();
    // Reachable by clearing the prefilled name back down to the base's own word.
    expect(splitSortOps(state, LIST, "blabar", "Blåbär", { keepPlain: true }))
      .toEqual([]);
  });

  it("refuses a name too short to be a vara", () => {
    const state = ripeBlueberriesOnList();
    expect(splitSortOps(state, LIST, "blabar", " m ", { keepPlain: true })).toEqual(
      [],
    );
  });
});

describe("newVaraLike", () => {
  it("falls back to Övrigt and a box when there is nothing to inherit", () => {
    const made = newVaraLike("saffran", "saffran");
    expect(made.categoryId).toBe("ovrigt");
    expect(made.iconRef).toBe("1F4E6");
  });

  it("never inherits hasAtHome or hidden", () => {
    const source = { ...item("smor", "Smör"), hasAtHome: true, hidden: true };
    const made = newVaraLike("osaltat-smor", "osaltat smör", source);
    // A new kind cannot have earned a claim about the pantry, and inheriting
    // `hidden` would create a vara nobody can find at the moment they asked for
    // it.
    expect(made.hasAtHome).toBe(false);
    expect(made.hidden).toBe(false);
    expect(made.categoryId).toBe("frukt-gront");
  });
});

/**
 * The row that could not see its own taps.
 *
 * "Föreslås" is rendered from a server snapshot, so nothing in it reacted to
 * anything the household did: tapping a tile added the vara and left the tile
 * exactly where it was, un-dimmed and still offering. That is indistinguishable
 * from a tap that did not register, and the recovery a person reaches for —
 * tap it again — fires a second `add_item`.
 */
describe("visibleSuggestions", () => {
  const none = new Set<string>();
  const offered = [
    { catalogItemId: "mjolk", reason: "brukar vara slut nu" },
    { catalogItemId: "gradde", reason: "brukar vara slut nu" },
  ];
  const silenced = (over: Partial<Record<"onList" | "accepted" | "dismissed", Set<string>>> = {}) => ({
    onList: over.onList ?? none,
    accepted: over.accepted ?? none,
    dismissed: over.dismissed ?? none,
  });

  it("offers everything the household has said nothing about", () => {
    expect(visibleSuggestions(offered, silenced())).toEqual(offered);
  });

  it("stops offering a vara that is already on the list", () => {
    // The tap answering for itself. Also the partner's add, arriving over SSE:
    // the suggestions prop has not changed, and the row still has to react.
    const left = visibleSuggestions(offered, silenced({ onList: new Set(["mjolk"]) }));
    expect(left.map((s) => s.catalogItemId)).toEqual(["gradde"]);
  });

  it("keeps an accepted suggestion silent after it is bought", () => {
    // The case `onList` cannot cover, and the reason `accepted` exists. Ticking
    // a vara off is exactly what takes it out of `onList`, so on this input the
    // naive filter offers back the milk already in the trolley.
    const boughtInTheShop = silenced({ accepted: new Set(["mjolk"]) });
    expect(visibleSuggestions(offered, boughtInTheShop).map((s) => s.catalogItemId)).toEqual([
      "gradde",
    ]);
  });

  it("honours a dismissal", () => {
    const left = visibleSuggestions(offered, silenced({ dismissed: new Set(["gradde"]) }));
    expect(left.map((s) => s.catalogItemId)).toEqual(["mjolk"]);
  });

  it("can be silenced down to nothing", () => {
    // The heading stays mounted while an undo is still offered, so an empty
    // result is a state the screen renders rather than an impossible one.
    const all = silenced({ onList: new Set(["mjolk"]), dismissed: new Set(["gradde"]) });
    expect(visibleSuggestions(offered, all)).toEqual([]);
  });

  it("keeps the engine's order", () => {
    // The reason each suggestion is offered is ranked upstream by overdue score;
    // filtering must not reorder what the cadence engine decided.
    const left = visibleSuggestions(
      [...offered, { catalogItemId: "salt", reason: "brukar vara slut nu" }],
      silenced({ onList: new Set(["gradde"]) }),
    );
    expect(left.map((s) => s.catalogItemId)).toEqual(["mjolk", "salt"]);
  });
});
