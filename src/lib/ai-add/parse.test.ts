import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { parseMock, ctorMock } = vi.hoisted(() => {
  const parseMock = vi.fn();
  // A plain function (not an arrow) so `new Anthropic()` can invoke it as a
  // constructor — same shape as recipes/llm.test.ts.
  const ctorMock = vi.fn(function (this: { messages: { parse: typeof parseMock } }) {
    this.messages = { parse: parseMock };
  });
  return { parseMock, ctorMock };
});

vi.mock("@anthropic-ai/sdk", () => ({ default: ctorMock }));

const { parseInput } = await import("./parse");

describe("parseInput", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    parseMock.mockReset();
    ctorMock.mockClear();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("returns null without calling the SDK when no key is configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(await parseInput({ kind: "text", text: "mjölk" })).toBeNull();
    expect(ctorMock).not.toHaveBeenCalled();
  });

  it("sends text as a text block and returns the lines", async () => {
    parseMock.mockResolvedValue({
      stop_reason: "end_turn",
      parsed_output: {
        lines: [
          { text: "2 l mjölk", group: "list" },
          { text: "keso", group: "other" },
        ],
      },
    });

    const lines = await parseInput({ kind: "text", text: "2 l mjölk, keso" });

    expect(lines).toEqual([
      { text: "2 l mjölk", group: "list" },
      { text: "keso", group: "other" },
    ]);
    const request = parseMock.mock.calls[0]![0];
    expect(request.model).toBe("claude-opus-5");
    expect(request).not.toHaveProperty("temperature");
    expect(request.messages[0].content).toEqual([
      { type: "text", text: "2 l mjölk, keso" },
    ]);
  });

  it("sends an image as an image block with its media type", async () => {
    parseMock.mockResolvedValue({
      stop_reason: "end_turn",
      parsed_output: { lines: [{ text: "ägg", group: "list" }] },
    });

    await parseInput({ kind: "image", data: "AAAA", mediaType: "image/jpeg" });

    const content = parseMock.mock.calls[0]![0].messages[0].content;
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
    });
  });

  it("returns null on a refusal, without reading parsed_output", async () => {
    parseMock.mockResolvedValue({
      stop_reason: "refusal",
      parsed_output: { lines: [{ text: "mjölk", group: "list" }] },
    });
    expect(await parseInput({ kind: "text", text: "x" })).toBeNull();
  });

  it("returns null when the SDK throws", async () => {
    parseMock.mockRejectedValue(new Error("network"));
    expect(await parseInput({ kind: "text", text: "x" })).toBeNull();
  });

  it("drops blank lines rather than passing them on", async () => {
    parseMock.mockResolvedValue({
      stop_reason: "end_turn",
      parsed_output: {
        lines: [
          { text: "  ", group: "list" },
          { text: " ägg ", group: "list" },
        ],
      },
    });
    expect(await parseInput({ kind: "text", text: "x" })).toEqual([
      { text: "ägg", group: "list" },
    ]);
  });
});
