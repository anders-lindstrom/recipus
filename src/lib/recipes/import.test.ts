import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importRecipeFromUrl } from "./import";

function fakeFetch(body: string, opts: { ok?: boolean; status?: number } = {}) {
  const { ok = true, status = 200 } = opts;
  return vi.fn(async () => ({ ok, status, text: async () => body }) as unknown as Response) as unknown as typeof fetch;
}

const jsonLdHtml = `<html><body><script type="application/ld+json">${JSON.stringify({
  "@type": "Recipe",
  name: "Pasta",
  recipeYield: "4 portioner",
  recipeIngredient: ["400 g pasta", "2 dl grädde"],
})}</script></body></html>`;

const noRecipeHtml = "<html><body><p>Inget recept här.</p></body></html>";

describe("importRecipeFromUrl", () => {
  const originalShimUrl = process.env.SHIM_URL;

  // Unconfigured on purpose, so `extractRecipeWithLlm` returns null before it
  // reaches the network: these tests are about the JSON-LD path and the error
  // the caller sees when it finds nothing, not about the shim.
  beforeEach(() => {
    delete process.env.SHIM_URL;
  });

  afterEach(() => {
    if (originalShimUrl === undefined) delete process.env.SHIM_URL;
    else process.env.SHIM_URL = originalShimUrl;
  });

  it("rejects a non-http(s) URL without making a request", async () => {
    const fetchImpl = fakeFetch("");
    await expect(importRecipeFromUrl("ftp://example.com/x", { fetchImpl })).rejects.toThrow(
      "http eller https",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an unparseable URL without making a request", async () => {
    const fetchImpl = fakeFetch("");
    await expect(importRecipeFromUrl("not a url", { fetchImpl })).rejects.toThrow("Ogiltig webbadress");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns the JSON-LD recipe when the page has one", async () => {
    const fetchImpl = fakeFetch(jsonLdHtml);
    const recipe = await importRecipeFromUrl("https://example.com/recept/pasta", { fetchImpl });

    expect(recipe.method).toBe("jsonld");
    expect(recipe.title).toBe("Pasta");
    expect(recipe.sourceUrl).toBe("https://example.com/recept/pasta");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(calledUrl).toBe("https://example.com/recept/pasta");
    expect((calledInit as RequestInit).headers).toMatchObject({ "User-Agent": expect.any(String) });
  });

  it("throws the Swedish user-facing error when there is no JSON-LD and no shim", async () => {
    const fetchImpl = fakeFetch(noRecipeHtml);
    await expect(importRecipeFromUrl("https://example.com/tomt", { fetchImpl })).rejects.toThrow(
      "Kunde inte läsa receptet från sidan.",
    );
  });

  it("skips the LLM fallback entirely when allowLlm is false", async () => {
    const fetchImpl = fakeFetch(noRecipeHtml);
    await expect(
      importRecipeFromUrl("https://example.com/tomt", { fetchImpl, allowLlm: false }),
    ).rejects.toThrow("Kunde inte läsa receptet från sidan.");
  });

  it("throws a clear error when the fetch response is not ok", async () => {
    const fetchImpl = fakeFetch("", { ok: false, status: 404 });
    await expect(importRecipeFromUrl("https://example.com/404", { fetchImpl })).rejects.toThrow("404");
  });
});
