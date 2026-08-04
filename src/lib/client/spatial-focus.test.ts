import { describe, expect, it } from "vitest";
import { nextInDirection, type Box } from "./spatial-focus";

/**
 * A three-column grid of 100×100 tiles, named by their position.
 *
 * The real thing is `grid-cols-3` in both the add bar's "Vanligast" and the list
 * screen, and the whole reason this module exists is that the DOM order of such
 * a grid — a1, b1, c1, a2… — is left-to-right, so any stepping that trusts it
 * walks sideways when asked to go down.
 */
const GRID: Record<string, Box> = {
  a1: { top: 0, left: 0, width: 100 },
  b1: { top: 0, left: 110, width: 100 },
  c1: { top: 0, left: 220, width: 100 },
  a2: { top: 110, left: 0, width: 100 },
  b2: { top: 110, left: 110, width: 100 },
  c2: { top: 110, left: 220, width: 100 },
};

const from = (name: keyof typeof GRID) => GRID[name];
const others = (exclude: string) =>
  Object.entries(GRID)
    .filter(([name]) => name !== exclude)
    .map(([name, box]) => ({ stop: name, box }));

const step = (name: string, key: Parameters<typeof nextInDirection>[2]) =>
  nextInDirection(from(name), others(name), key);

describe("nextInDirection, in a grid", () => {
  it("keeps its column going down", () => {
    expect(step("b1", "ArrowDown")).toBe("b2");
    expect(step("c1", "ArrowDown")).toBe("c2");
  });

  it("keeps its column going up", () => {
    expect(step("b2", "ArrowUp")).toBe("b1");
  });

  it("moves one tile at a time sideways", () => {
    expect(step("a1", "ArrowRight")).toBe("b1");
    expect(step("c1", "ArrowLeft")).toBe("b1");
  });

  it("does not wrap at the ends of a row", () => {
    expect(step("c1", "ArrowRight")).toBeNull();
    expect(step("a2", "ArrowLeft")).toBeNull();
  });

  it("has nowhere to go off the top or the bottom", () => {
    expect(step("b1", "ArrowUp")).toBeNull();
    expect(step("b2", "ArrowDown")).toBeNull();
  });
});

describe("nextInDirection, down a single column", () => {
  const ROWS: Record<string, Box> = {
    one: { top: 0, left: 0, width: 300 },
    two: { top: 44, left: 0, width: 300 },
    three: { top: 88, left: 0, width: 300 },
  };
  const rest = (exclude: string) =>
    Object.entries(ROWS)
      .filter(([name]) => name !== exclude)
      .map(([name, box]) => ({ stop: name, box }));

  it("walks the rows", () => {
    expect(nextInDirection(ROWS.one, rest("one"), "ArrowDown")).toBe("two");
    expect(nextInDirection(ROWS.three, rest("three"), "ArrowUp")).toBe("two");
  });

  it("is inert sideways, because nothing shares a row", () => {
    expect(nextInDirection(ROWS.two, rest("two"), "ArrowLeft")).toBeNull();
    expect(nextInDirection(ROWS.two, rest("two"), "ArrowRight")).toBeNull();
  });
});

describe("nextInDirection, across sections", () => {
  /**
   * The case the list screen is built on: "Att handla" and the catalog well are
   * separate grids with a heading between them, and ArrowDown off the last row
   * of one has to land in the first row of the next. Nothing here knows the
   * sections exist — the nearest box below simply belongs to the other grid.
   */
  const LAST_ROW: Box = { top: 200, left: 110, width: 100 };
  const NEXT_SECTION = [
    { stop: "heading-action", box: { top: 260, left: 250, width: 70 } },
    { stop: "catalog-a", box: { top: 320, left: 0, width: 100 } },
    { stop: "catalog-b", box: { top: 320, left: 110, width: 100 } },
  ];

  it("crosses into the next grid, in the same column", () => {
    expect(nextInDirection(LAST_ROW, NEXT_SECTION.slice(1), "ArrowDown")).toBe(
      "catalog-b",
    );
  });

  it("stops at whatever is nearest, so the caller decides what is a stop", () => {
    // The heading's action button is nearer than the catalog. It only ever
    // becomes a destination if the caller collected it as one — which the list
    // screen deliberately does not do, keeping arrows to tiles and leaving the
    // headings' controls to Tab.
    expect(nextInDirection(LAST_ROW, NEXT_SECTION, "ArrowDown")).toBe(
      "heading-action",
    );
  });
});

describe("nextInDirection, on a ragged row", () => {
  it("tolerates a few pixels of disagreement about where a row starts", () => {
    const anchor: Box = { top: 100, left: 0, width: 100 };
    const nudged = [
      { stop: "nudged", box: { top: 104, left: 110, width: 100 } },
    ];
    expect(nextInDirection(anchor, nudged, "ArrowRight")).toBe("nudged");
    // …and does not then also treat it as being below.
    expect(nextInDirection(anchor, nudged, "ArrowDown")).toBeNull();
  });
});
