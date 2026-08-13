import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "..";

/**
 * What the route says when a photo does not come back.
 *
 * The parse itself is covered by `src/lib/ai-add/*.test.ts`; what is pinned
 * here is the one inference this file makes on its own. `parseForList` cannot
 * say WHY it failed — it reports `usedModel: false` for a missing key and for a
 * dead call alike — so the route reads the difference from the fact that it
 * checked the key first. Get that wrong and either a working parse 503s or a
 * failed one comes back as "found no varor", which is the bug this test exists
 * to keep fixed.
 *
 * Both services are mocked, so nothing here touches Anthropic or the database.
 */

const { parseForList, takeSharedImage } = vi.hoisted(() => ({
  parseForList: vi.fn(),
  takeSharedImage: vi.fn(),
}));

vi.mock("@/lib/services/ai-add", () => ({ parseForList }));
vi.mock("@/lib/services/share-inbox", () => ({ takeSharedImage }));

const { aiRoutes } = await import("./ai");

/** The api-wide gate is what sets `actor`; the share branch reads it. */
function gated() {
  const app = new OpenAPIHono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", "anders");
    return next();
  });
  app.route("/ai", aiRoutes());
  return app;
}

function post(body: unknown) {
  return gated().request("/ai/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PHOTO = { kind: "image", data: "abc", mediaType: "image/jpeg" };

describe("POST /ai/parse", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    parseForList.mockReset();
    takeSharedImage.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("says the image could not be read when the call failed", async () => {
    parseForList.mockResolvedValue({ rows: [], usedModel: false });

    const res = await post(PHOTO);

    expect(res.status).toBe(503);
    const { error } = (await res.json()) as { error: string };
    // Not the missing-knob sentence: the knob is there, the reading failed.
    expect(error).not.toMatch(/ANTHROPIC_API_KEY/);
    expect(error).toMatch(/bilden/i);
  });

  it("says the same about a share, where the token is already spent", async () => {
    takeSharedImage.mockReturnValue({ data: "abc", mediaType: "image/png" });
    parseForList.mockResolvedValue({ rows: [], usedModel: false });

    const res = await post({ kind: "share", token: "t0" });

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).not.toMatch(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("names the missing knob instead, and does not call the model", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const res = await post(PHOTO);

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /ANTHROPIC_API_KEY/,
    );
    expect(parseForList).not.toHaveBeenCalled();
  });

  it("passes an image the model DID read, even with nothing on it", async () => {
    // The other empty answer, and the one that must stay a 200: the model
    // looked and there was no list there. Only the dialog can say that.
    parseForList.mockResolvedValue({ rows: [], usedModel: true });

    const res = await post(PHOTO);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [], usedModel: true });
  });

  it("leaves text alone, which has an answer without the model", async () => {
    const rows = [
      {
        id: "r0",
        said: "mjölk",
        name: "mjölk",
        amount: null,
        catalogItemId: "mjolk",
        group: "list",
      },
    ];
    parseForList.mockResolvedValue({ rows, usedModel: false });

    const res = await post({ kind: "text", text: "mjölk" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows, usedModel: false });
  });

  it("is still a 404 when the shared image is gone", async () => {
    takeSharedImage.mockReturnValue(null);

    const res = await post({ kind: "share", token: "gone" });

    expect(res.status).toBe(404);
    expect(parseForList).not.toHaveBeenCalled();
  });
});
