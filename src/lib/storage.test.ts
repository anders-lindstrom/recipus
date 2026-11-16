import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalFSStorage } from "./storage";

function fresh() {
  return new LocalFSStorage(mkdtempSync(path.join(tmpdir(), "recipus-storage-")));
}

describe("LocalFSStorage", () => {
  it("gives back exactly the bytes it was given", async () => {
    const storage = fresh();
    await storage.put("sources/a.jpg", Buffer.from("jpeg bytes"));
    expect((await storage.get("sources/a.jpg")).toString()).toBe("jpeg bytes");
  });

  it("rejects a missing key with ENOENT, so a caller can tell gone from broken", async () => {
    await expect(fresh().get("sources/nope.jpg")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a key that climbs out of its root", async () => {
    await expect(fresh().put("../x", Buffer.from("x"))).rejects.toThrow("Invalid storage key");
  });

  it("lists what is under a prefix, with each file's time", async () => {
    const storage = fresh();
    await storage.put("sources/a.jpg", Buffer.from("a"));
    await storage.put("other/b.jpg", Buffer.from("b"));
    const listed = await storage.list("sources/");
    expect(listed.map((f) => f.key)).toEqual(["sources/a.jpg"]);
    expect(listed[0]!.modifiedAt).toBeInstanceOf(Date);
    expect(await fresh().list("sources/")).toEqual([]);
  });

  it("deleting a key that is not there is not an error", async () => {
    await expect(fresh().delete("sources/nope.jpg")).resolves.toBeUndefined();
  });
});
