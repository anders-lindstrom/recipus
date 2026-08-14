import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractRecipeWithLlm } from "./llm";

const ORIGINAL_URL = process.env.AI_SHIM_URL;
const ORIGINAL_SECRET = process.env.AI_SHIM_SECRET;

/** A body the shim would consider good, with the fields under test overridden. */
function shimResponse(recipe: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      recipe: {
        title: "Kanelbullar",
        servings: 20,
        servingsUnit: "bullar",
        imageUrl: null,
        ingredientLines: [],
        instructions: [],
        ...recipe,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("extractRecipeWithLlm", () => {
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
    expect(await extractRecipeWithLlm("<html></html>", "https://example.com")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null without calling anything when the shim secret is missing", async () => {
    delete process.env.AI_SHIM_SECRET;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await extractRecipeWithLlm("<html></html>", "https://example.com")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts the page text to /recipe with the bearer token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(shimResponse({}));

    await extractRecipeWithLlm("<html><body><h1>Kanelbullar</h1></body></html>", "https://example.com/r");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("http://beelink.host:8301/recipe");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer test-secret");
    expect(JSON.parse(init!.body as string)).toEqual({
      html: "Kanelbullar",
      url: "https://example.com/r",
    });
  });

  it("does not double the slash when AI_SHIM_URL carries a trailing one", async () => {
    // A trailing slash is an ordinary thing to type into a .env. Left alone it
    // yields `//recipe`, a 404 and then `null` — a config typo wearing the mask
    // of a permanent model failure, which is the hardest kind to find.
    process.env.AI_SHIM_URL = "http://beelink.host:8301/";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(shimResponse({}));

    await extractRecipeWithLlm("<html></html>", "https://example.com");

    expect(String(fetchSpy.mock.calls[0]![0])).toBe("http://beelink.host:8301/recipe");
  });

  it("strips script/style/nav/footer noise before sending the page text", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(shimResponse({}));

    const html = `<html><head><style>.x{color:red}</style></head><body>
      <nav>Meny: Hem, Recept</nav>
      <script>console.log("noise")</script>
      <h1>Kanelbullar</h1>
      <footer>© Exempel AB</footer>
    </body></html>`;

    await extractRecipeWithLlm(html, "https://example.com");

    const sent = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string).html as string;
    expect(sent).toContain("Kanelbullar");
    expect(sent).not.toContain("noise");
    expect(sent).not.toContain("Meny");
    expect(sent).not.toContain("Exempel AB");
  });

  it("caps the page text it sends, rather than shipping a bloated page whole", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(shimResponse({}));

    await extractRecipeWithLlm(`<p>${"a".repeat(60_000)}</p>`, "https://example.com");

    const sent = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string).html as string;
    expect(sent).toHaveLength(40_000);
  });

  it("maps a good answer into an ImportedRecipe with method llm and the source URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      shimResponse({
        title: "Kanelbullar",
        servings: 20,
        servingsUnit: "bullar",
        imageUrl: "https://example.com/a.jpg",
        ingredientLines: ["5 dl mjölk", "50 g jäst"],
        instructions: ["Smula jästen.", "Baka 12 min."],
      }),
    );

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

  it("returns null on a non-2xx answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));
    expect(await extractRecipeWithLlm("<html></html>", "https://example.com")).toBeNull();
  });

  it("returns null when the shim is unreachable, rather than throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await extractRecipeWithLlm("<html></html>", "https://example.com")).toBeNull();
  });

  it("returns null on a 200 that is not JSON at all", async () => {
    // A captive portal or a stray proxy answers 200 with HTML. Reading the body
    // has to stay inside the same guard as the request itself.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>not json</html>", { status: 200 }),
    );
    expect(await extractRecipeWithLlm("<html></html>", "https://example.com")).toBeNull();
  });

  it("returns null on a body that does not match the schema", async () => {
    // The shim is ours, which is exactly why it gets no special trust: a
    // contract asserted on one side only is a contract that drifts silently.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ recipe: { title: 42 } }), { status: 200 }),
    );
    expect(await extractRecipeWithLlm("<html></html>", "https://example.com")).toBeNull();
  });

  it("returns null when the recipe arrives unwrapped", async () => {
    // The shim answers `{recipe: {...}}`, not the bare object. If that wrapper
    // ever moves, this is the test that says so.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "Kanelbullar",
          servings: 4,
          servingsUnit: "portioner",
          imageUrl: null,
          ingredientLines: [],
          instructions: [],
        }),
        { status: 200 },
      ),
    );
    expect(await extractRecipeWithLlm("<html></html>", "https://example.com")).toBeNull();
  });

  it("returns null when servings is not a number at all", async () => {
    // JSON has no NaN: a servings the model could not produce arrives as null,
    // or as a string, and is refused here rather than defaulted.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(shimResponse({ servings: null }));
    expect(await extractRecipeWithLlm("<html></html>", "https://example.com")).toBeNull();
  });

  it("defaults servings of 0 to 4 portioner", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(shimResponse({ servings: 0, servingsUnit: "   " }));

    const result = await extractRecipeWithLlm("<html></html>", "https://example.com");
    expect(result?.servings).toBe(4);
    expect(result?.servingsUnit).toBe("portioner");
  });

  it("defaults a negative servings to 4", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(shimResponse({ servings: -2 }));
    expect((await extractRecipeWithLlm("<html></html>", "https://example.com"))?.servings).toBe(4);
  });

  it("trims the servings unit rather than passing the padding through", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(shimResponse({ servingsUnit: "  bullar  " }));
    expect((await extractRecipeWithLlm("<html></html>", "https://example.com"))?.servingsUnit).toBe(
      "bullar",
    );
  });

  it("trims the instruction steps and drops the empty ones", async () => {
    // A model told "one step per element" hands back a trailing blank often
    // enough that an empty numbered step would reach the screen, and a numbered
    // blank reads as a bug in the app.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      shimResponse({ instructions: ["  Smula jästen.  ", "Baka 12 min.", "   "] }),
    );

    expect((await extractRecipeWithLlm("<html></html>", "https://example.com"))?.instructions).toEqual([
      "Smula jästen.",
      "Baka 12 min.",
    ]);
  });
});
