import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { emptyState } from "@/lib/domain";
import {
  closeDb,
  deleteDb,
  loadMeta,
  loadState,
  saveMeta,
  saveState,
} from "./db";

afterEach(async () => {
  await deleteDb();
});

describe("state store", () => {
  it("returns null for a list that has never been saved", async () => {
    expect(await loadState("hemkop")).toBeNull();
  });

  it("round-trips a SyncState", async () => {
    const state = emptyState();
    state.lists.hemkop = {
      id: "hemkop",
      name: "Hemköp",
      icon: "1F6D2",
      position: 0,
      categoryOrder: [],
    };
    await saveState("hemkop", state);
    expect(await loadState("hemkop")).toEqual(state);
  });

  it("survives closing and reopening the connection, simulating a reload", async () => {
    const state = emptyState();
    state.catalog.mjolk = {
      id: "mjolk",
      name: "Mjölk",
      nameNorm: "mjolk",
      categoryId: "mejeri",
      iconRef: "1F95B",
      isCustom: false,
      hasAtHome: false,
      hidden: false,
      useCount: 0,
      lastUsedAt: null,
    };
    await saveState("hemkop", state);
    await closeDb();

    expect(await loadState("hemkop")).toEqual(state);
  });
});

describe("meta store", () => {
  it("returns null before any meta has been saved", async () => {
    expect(await loadMeta("hemkop")).toBeNull();
  });

  it("round-trips a SyncMeta row", async () => {
    await saveMeta({ listId: "hemkop", cursor: 42, lastHydratedAt: "2026-03-12T10:00:00.000Z" });
    expect(await loadMeta("hemkop")).toEqual({
      listId: "hemkop",
      cursor: 42,
      lastHydratedAt: "2026-03-12T10:00:00.000Z",
    });
  });
});
