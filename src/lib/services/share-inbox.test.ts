import { beforeEach, describe, expect, it } from "vitest";
import {
  SHARE_CAPACITY,
  SHARE_TTL_MS,
  putSharedFile,
  resetSharedFiles,
  peekSharedFile,
  takeSharedFile,
} from "./share-inbox";

const t0 = new Date("2026-08-13T10:00:00Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

describe("share inbox", () => {
  beforeEach(() => resetSharedFiles());

  it("hands back what was put in, to the person who put it there", () => {
    const token = putSharedFile(
      { data: "AAAA", mediaType: "image/jpeg", actor: "anders" },
      t0,
    );
    expect(takeSharedFile(token, "anders", t0)).toEqual({
      data: "AAAA",
      mediaType: "image/jpeg",
    });
  });

  it("empties the slot, so one share cannot be read twice", () => {
    const token = putSharedFile(
      { data: "AAAA", mediaType: "image/jpeg", actor: "anders" },
      t0,
    );
    takeSharedFile(token, "anders", t0);
    expect(takeSharedFile(token, "anders", t0)).toBeNull();
  });

  it("refuses a household member who did not share it", () => {
    const token = putSharedFile(
      { data: "AAAA", mediaType: "image/jpeg", actor: "anders" },
      t0,
    );
    expect(takeSharedFile(token, "nagon-annan", t0)).toBeNull();
    // And refusing must not consume it — the rightful owner still gets it.
    expect(takeSharedFile(token, "anders", t0)).not.toBeNull();
  });

  it("forgets a share that has gone stale", () => {
    const token = putSharedFile(
      { data: "AAAA", mediaType: "image/jpeg", actor: "anders" },
      t0,
    );
    expect(takeSharedFile(token, "anders", later(SHARE_TTL_MS + 1))).toBeNull();
  });

  it("evicts the oldest when full, rather than growing without bound", () => {
    const tokens = Array.from({ length: SHARE_CAPACITY + 1 }, (_, i) =>
      putSharedFile(
        { data: `img${i}`, mediaType: "image/jpeg", actor: "anders" },
        later(i),
      ),
    );
    expect(takeSharedFile(tokens[0]!, "anders", t0)).toBeNull();
    expect(takeSharedFile(tokens[SHARE_CAPACITY]!, "anders", t0)).not.toBeNull();
  });

  it("mints an unguessable token", () => {
    const a = putSharedFile({ data: "A", mediaType: "image/jpeg", actor: "x" }, t0);
    const b = putSharedFile({ data: "B", mediaType: "image/jpeg", actor: "x" }, t0);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("lets the shopping-list read look without spending the share", () => {
    // The AI dialog peeks; "Spara som recept i stället" then takes the same file.
    const token = putSharedFile({ data: "PDF", mediaType: "application/pdf", actor: "anders" }, t0);
    expect(peekSharedFile(token, "anders", t0)).toEqual({ data: "PDF", mediaType: "application/pdf" });
    expect(takeSharedFile(token, "anders", t0)).toEqual({ data: "PDF", mediaType: "application/pdf" });
    expect(peekSharedFile(token, "anders", t0)).toBeNull();
  });

  it("does not show a peek to someone else, or past its time", () => {
    const token = putSharedFile({ data: "A", mediaType: "image/jpeg", actor: "anders" }, t0);
    expect(peekSharedFile(token, "nagon-annan", t0)).toBeNull();
    expect(peekSharedFile(token, "anders", later(SHARE_TTL_MS + 1))).toBeNull();
  });

  it("returns null for a token nobody minted", () => {
    expect(takeSharedFile("made-up", "anders", t0)).toBeNull();
  });
});
