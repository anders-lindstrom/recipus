import { beforeEach, describe, expect, it } from "vitest";
import {
  SHARE_CAPACITY,
  SHARE_TTL_MS,
  putSharedImage,
  resetSharedImages,
  takeSharedImage,
} from "./share-inbox";

const t0 = new Date("2026-08-13T10:00:00Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

describe("share inbox", () => {
  beforeEach(() => resetSharedImages());

  it("hands back what was put in, to the person who put it there", () => {
    const token = putSharedImage(
      { data: "AAAA", mediaType: "image/jpeg", actor: "anders" },
      t0,
    );
    expect(takeSharedImage(token, "anders", t0)).toEqual({
      data: "AAAA",
      mediaType: "image/jpeg",
    });
  });

  it("empties the slot, so one share cannot be read twice", () => {
    const token = putSharedImage(
      { data: "AAAA", mediaType: "image/jpeg", actor: "anders" },
      t0,
    );
    takeSharedImage(token, "anders", t0);
    expect(takeSharedImage(token, "anders", t0)).toBeNull();
  });

  it("refuses a household member who did not share it", () => {
    const token = putSharedImage(
      { data: "AAAA", mediaType: "image/jpeg", actor: "anders" },
      t0,
    );
    expect(takeSharedImage(token, "nagon-annan", t0)).toBeNull();
    // And refusing must not consume it — the rightful owner still gets it.
    expect(takeSharedImage(token, "anders", t0)).not.toBeNull();
  });

  it("forgets a share that has gone stale", () => {
    const token = putSharedImage(
      { data: "AAAA", mediaType: "image/jpeg", actor: "anders" },
      t0,
    );
    expect(takeSharedImage(token, "anders", later(SHARE_TTL_MS + 1))).toBeNull();
  });

  it("evicts the oldest when full, rather than growing without bound", () => {
    const tokens = Array.from({ length: SHARE_CAPACITY + 1 }, (_, i) =>
      putSharedImage(
        { data: `img${i}`, mediaType: "image/jpeg", actor: "anders" },
        later(i),
      ),
    );
    expect(takeSharedImage(tokens[0]!, "anders", t0)).toBeNull();
    expect(takeSharedImage(tokens[SHARE_CAPACITY]!, "anders", t0)).not.toBeNull();
  });

  it("mints an unguessable token", () => {
    const a = putSharedImage({ data: "A", mediaType: "image/jpeg", actor: "x" }, t0);
    const b = putSharedImage({ data: "B", mediaType: "image/jpeg", actor: "x" }, t0);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("returns null for a token nobody minted", () => {
    expect(takeSharedImage("made-up", "anders", t0)).toBeNull();
  });
});
