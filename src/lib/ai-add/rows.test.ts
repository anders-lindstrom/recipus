import { describe, expect, it } from "vitest";
import type { MatchCandidate } from "@/lib/ingredients";
import { buildRows } from "./rows";

const candidates: MatchCandidate[] = [
  { id: "mjolk", nameNorm: "mjolk" },
  { id: "agg", nameNorm: "agg" },
  { id: "salt", nameNorm: "salt" },
  { id: "peppar", nameNorm: "peppar" },
  // An alias row: the same shape buildMatchCandidates emits for aliases.
  { id: "mjolk", nameNorm: "milk" },
];

describe("buildRows", () => {
  it("matches a line to a vara and keeps its amount", () => {
    const rows = buildRows([{ text: "2 l mjölk", group: "list" }], candidates);
    expect(rows).toEqual([
      {
        id: "r0",
        said: "2 l mjölk",
        name: "mjölk",
        amount: { value: 2, unit: "l" },
        catalogItemId: "mjolk",
        group: "list",
      },
    ]);
  });

  it("reaches a vara through an alias", () => {
    const rows = buildRows([{ text: "milk", group: "list" }], candidates);
    expect(rows[0]!.catalogItemId).toBe("mjolk");
  });

  it("returns a null id for a word no vara answers to", () => {
    const rows = buildRows([{ text: "oatly ikaffe", group: "list" }], candidates);
    expect(rows[0]!.catalogItemId).toBeNull();
    expect(rows[0]!.name).toBe("oatly ikaffe");
  });

  it("splits a line that names two things", () => {
    // interpretUtterance already reads "salt och peppar" as two, and a model
    // that hands back one line must not cost the household the second vara.
    const rows = buildRows([{ text: "salt och peppar", group: "list" }], candidates);
    expect(rows.map((r) => r.catalogItemId)).toEqual(["salt", "peppar"]);
  });

  it("keeps one row per vara, first mention winning its amount", () => {
    const rows = buildRows(
      [
        { text: "2 l mjölk", group: "list" },
        { text: "mjölk", group: "list" },
      ],
      candidates,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toEqual({ value: 2, unit: "l" });
  });

  it("lets the list group win when the same vara appears in both", () => {
    // A Bring screenshot shows milk on the list AND in the suggestion grid
    // below. One row, ticked, or the person unticks the wrong one.
    const rows = buildRows(
      [
        { text: "mjölk", group: "other" },
        { text: "mjölk", group: "list" },
      ],
      candidates,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.group).toBe("list");
  });

  it("dedupes unmatched rows by the words themselves", () => {
    // dedupeResolutions only folds matched rows — two identical unknowns would
    // otherwise both offer to create the same new vara.
    const rows = buildRows(
      [
        { text: "oatly ikaffe", group: "list" },
        { text: "Oatly iKaffe", group: "list" },
      ],
      candidates,
    );
    expect(rows).toHaveLength(1);
  });

  it("strips a carrier phrase the model left in", () => {
    const rows = buildRows([{ text: "lägg till ägg", group: "list" }], candidates);
    expect(rows[0]!.catalogItemId).toBe("agg");
  });

  it("drops a line that is nothing but a carrier phrase", () => {
    expect(buildRows([{ text: "lägg till", group: "list" }], candidates)).toEqual([]);
  });

  it("numbers rows in order across groups", () => {
    const rows = buildRows(
      [
        { text: "mjölk", group: "list" },
        { text: "ägg", group: "other" },
      ],
      candidates,
    );
    expect(rows.map((r) => r.id)).toEqual(["r0", "r1"]);
  });
});
