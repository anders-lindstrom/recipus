import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { parseMock, ctorMock } = vi.hoisted(() => {
  const parseMock = vi.fn();
  // A plain function (not an arrow) so `new Anthropic()` can invoke it as a
  // constructor.
  const ctorMock = vi.fn(function (this: { messages: { parse: typeof parseMock } }) {
    this.messages = { parse: parseMock };
  });
  return { parseMock, ctorMock };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: ctorMock,
}));

const { extractRecipeWithLlm } = await import("./llm");

describe("extractRecipeWithLlm", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    parseMock.mockReset();
    ctorMock.mockClear();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("returns null immediately when no API key is configured, without calling the SDK", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await extractRecipeWithLlm("<html></html>", "https://example.com");
    expect(result).toBeNull();
    expect(ctorMock).not.toHaveBeenCalled();
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("calls messages.parse with the required, and only the required, request shape", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    parseMock.mockResolvedValue({
      stop_reason: "end_turn",
      parsed_output: {
        title: "Test",
        servings: 4,
        servingsUnit: "portioner",
        imageUrl: null,
        ingredientLines: ["2 dl mjölk"],
        instructions: ["Blanda."],
      },
    });

    await extractRecipeWithLlm("<html><body>Recept</body></html>", "https://example.com/recept");

    expect(parseMock).toHaveBeenCalledTimes(1);
    const request = parseMock.mock.calls[0]![0];
    expect(request.model).toBe("claude-opus-5");
    expect(request.max_tokens).toBe(16000);
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("top_p");
    expect(request).not.toHaveProperty("top_k");
    expect(request).not.toHaveProperty("thinking");
    expect(request.output_config?.format).toBeDefined();
  });

  it("strips script/style/nav/footer noise and caps page text before sending it", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    parseMock.mockResolvedValue({
      stop_reason: "end_turn",
      parsed_output: {
        title: "Test",
        servings: 4,
        servingsUnit: "portioner",
        imageUrl: null,
        ingredientLines: [],
        instructions: [],
      },
    });

    const html = `<html><head><style>.x{color:red}</style></head><body>
      <nav>Meny: Hem, Recept</nav>
      <script>console.log("noise")</script>
      <h1>Kanelbullar</h1>
      <footer>© Exempel AB</footer>
    </body></html>`;

    await extractRecipeWithLlm(html, "https://example.com");

    const request = parseMock.mock.calls[0]![0];
    const sentText = request.messages[0].content as string;
    expect(sentText).toContain("Kanelbullar");
    expect(sentText).not.toContain("noise");
    expect(sentText).not.toContain("Meny");
    expect(sentText).not.toContain("Exempel AB");
  });

  it("returns null on a refusal without reading parsed_output", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    parseMock.mockResolvedValue({
      stop_reason: "refusal",
      parsed_output: {
        title: "Should be ignored",
        servings: 4,
        servingsUnit: "portioner",
        imageUrl: null,
        ingredientLines: [],
      },
    });

    const result = await extractRecipeWithLlm("<html></html>", "https://example.com");
    expect(result).toBeNull();
  });

  it("returns null when parsed_output is null", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    parseMock.mockResolvedValue({ stop_reason: "end_turn", parsed_output: null });

    const result = await extractRecipeWithLlm("<html></html>", "https://example.com");
    expect(result).toBeNull();
  });

  it("returns null instead of throwing when the API call fails", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    parseMock.mockRejectedValue(new Error("network down"));

    const result = await extractRecipeWithLlm("<html></html>", "https://example.com");
    expect(result).toBeNull();
  });

  it("maps a successful parse into an ImportedRecipe with method llm", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    parseMock.mockResolvedValue({
      stop_reason: "end_turn",
      parsed_output: {
        title: "Kanelbullar",
        servings: 20,
        servingsUnit: "bullar",
        imageUrl: "https://example.com/a.jpg",
        ingredientLines: ["5 dl mjölk", "50 g jäst"],
        // Deliberately ragged. A model told "one step per element" hands back a
        // trailing blank often enough that an empty numbered step would reach
        // the screen, and a numbered blank reads as a bug in the app.
        instructions: ["  Smula jästen.  ", "Baka 12 min.", "   "],
      },
    });

    const result = await extractRecipeWithLlm("<html></html>", "https://example.com/recept/kanelbullar");

    expect(result).toEqual({
      title: "Kanelbullar",
      servings: 20,
      servingsUnit: "bullar",
      imageUrl: "https://example.com/a.jpg",
      ingredientLines: ["5 dl mjölk", "50 g jäst"],
      instructions: ["Smula jästen.", "Baka 12 min."],
      sourceUrl: "https://example.com/recept/kanelbullar",
      method: "llm",
    });
  });
});
