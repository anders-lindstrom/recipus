import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseInput } from "./parse";

const ORIGINAL_URL = process.env.AI_SHIM_URL;
const ORIGINAL_SECRET = process.env.AI_SHIM_SECRET;

describe("parseInput", () => {
  beforeEach(() => {
    process.env.AI_SHIM_URL = "http://beelink.host:8301";
    process.env.AI_SHIM_SECRET = "test-secret";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_URL === undefined) delete process.env.AI_SHIM_URL;
    else process.env.AI_SHIM_URL = ORIGINAL_URL;
    if (ORIGINAL_SECRET === undefined) delete process.env.AI_SHIM_SECRET;
    else process.env.AI_SHIM_SECRET = ORIGINAL_SECRET;
  });

  it("returns null without calling anything when the shim is not configured", async () => {
    delete process.env.AI_SHIM_URL;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await parseInput({ kind: "text", text: "mjölk" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts text to /parse with the bearer token and returns the lines", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ lines: [{ text: "2 l mjölk", group: "list" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const lines = await parseInput({ kind: "text", text: "2 l mjölk" });

    expect(lines).toEqual([{ text: "2 l mjölk", group: "list" }]);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("http://beelink.host:8301/parse");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer test-secret");
    expect(JSON.parse(init!.body as string)).toEqual({ kind: "text", text: "2 l mjölk" });
  });

  it("passes an image through with its media type", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ lines: [] }), { status: 200 }),
    );
    await parseInput({ kind: "image", data: "AAAA", mediaType: "image/jpeg" });
    expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)).toEqual({
      kind: "image",
      data: "AAAA",
      mediaType: "image/jpeg",
    });
  });

  it("returns null on a non-2xx answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));
    expect(await parseInput({ kind: "text", text: "x" })).toBeNull();
  });

  it("returns null when the shim is unreachable, rather than throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await parseInput({ kind: "text", text: "x" })).toBeNull();
  });

  it("returns null on a body that does not match the schema", async () => {
    // The shim is ours, which is exactly why it gets no special trust: a
    // contract asserted on one side only is a contract that drifts silently.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ lines: [{ text: 42, group: "list" }] }), { status: 200 }),
    );
    expect(await parseInput({ kind: "text", text: "x" })).toBeNull();
  });

  it("drops blank lines rather than passing them on", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ lines: [{ text: "  ", group: "list" }, { text: " ägg ", group: "list" }] }),
        { status: 200 },
      ),
    );
    expect(await parseInput({ kind: "text", text: "x" })).toEqual([
      { text: "ägg", group: "list" },
    ]);
  });

  it("returns an empty array, not null, when the model found nothing", async () => {
    // The distinction the whole degradation story rests on: [] means "looked
    // and found nothing" and stays a 200; null means "could not help" and
    // becomes a 503 for images.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ lines: [] }), { status: 200 }),
    );
    expect(await parseInput({ kind: "text", text: "x" })).toEqual([]);
  });
});
