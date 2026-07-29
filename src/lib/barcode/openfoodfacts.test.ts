import { describe, expect, it, vi } from "vitest";
import { lookupOpenFoodFacts } from "@/lib/barcode/openfoodfacts";

// Computed the same way as ean.test.ts's fixtures (GS1 check digit, weights
// 1,3,1,3,... over digits 1..12): base 739876543210 -> check digit 9.
const VALID_EAN = "7398765432109";

type FakeResponse = Pick<Response, "ok" | "status" | "json">;

function okResponse(body: unknown): FakeResponse {
  return { ok: true, status: 200, json: async () => body };
}

function fakeFetch(response: FakeResponse): typeof fetch {
  return vi.fn(async () => response as Response) as unknown as typeof fetch;
}

/** A fetchImpl that never resolves on its own, only rejects when its signal aborts -- like the real fetch does. */
function hangingFetch(): typeof fetch {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
  }) as unknown as typeof fetch;
}

const FULL_PRODUCT = {
  code: VALID_EAN,
  product_name: "Standard Milk",
  product_name_sv: "Svensk Mjölk",
  brands: "Arla, Bregott",
  image_front_url: "https://images.example/front.jpg",
  image_url: "https://images.example/other.jpg",
  categories_tags: ["en:dairies", "en:milks"],
  quantity: " 1 l ",
};

describe("lookupOpenFoodFacts", () => {
  it("requests the expected URL, fields and User-Agent", async () => {
    const fetchImpl = fakeFetch(okResponse({ status: 1, product: FULL_PRODUCT }));

    await lookupOpenFoodFacts(VALID_EAN, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(
      `https://world.openfoodfacts.org/api/v2/product/${VALID_EAN}.json?fields=code,product_name,product_name_sv,brands,image_front_url,image_url,categories_tags,quantity`,
    );
    expect(init.headers["User-Agent"]).toBe("Recipus/0.1 (self-hosted household shopping list)");
  });

  it("validates the EAN before making any request", async () => {
    const fetchImpl = fakeFetch(okResponse({ status: 1, product: FULL_PRODUCT }));

    const result = await lookupOpenFoodFacts("not-a-real-ean", { fetchImpl });

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a full successful response", async () => {
    const fetchImpl = fakeFetch(okResponse({ status: 1, product: FULL_PRODUCT }));

    const result = await lookupOpenFoodFacts(VALID_EAN, { fetchImpl });

    expect(result).toEqual({
      ean: VALID_EAN,
      name: "Svensk Mjölk",
      brand: "Arla",
      imageUrl: "https://images.example/front.jpg",
      categoryHints: ["dairies", "milks"],
      quantity: "1 l",
    });
  });

  it("prefers product_name_sv over product_name", async () => {
    const fetchImpl = fakeFetch(
      okResponse({ status: 1, product: { ...FULL_PRODUCT, product_name_sv: "Svenskt namn" } }),
    );
    const result = await lookupOpenFoodFacts(VALID_EAN, { fetchImpl });
    expect(result?.name).toBe("Svenskt namn");
  });

  it("falls back to product_name when product_name_sv is absent", async () => {
    const { product_name_sv: _omit, ...rest } = FULL_PRODUCT;
    const fetchImpl = fakeFetch(okResponse({ status: 1, product: rest }));
    const result = await lookupOpenFoodFacts(VALID_EAN, { fetchImpl });
    expect(result?.name).toBe("Standard Milk");
  });

  it("returns a null name when neither Swedish nor default name is present", async () => {
    const { product_name_sv: _a, product_name: _b, ...rest } = FULL_PRODUCT;
    const fetchImpl = fakeFetch(okResponse({ status: 1, product: rest }));
    const result = await lookupOpenFoodFacts(VALID_EAN, { fetchImpl });
    expect(result?.name).toBeNull();
  });

  it("takes the first, trimmed brand from a comma-separated list", async () => {
    const fetchImpl = fakeFetch(
      okResponse({ status: 1, product: { ...FULL_PRODUCT, brands: "  Coop  , ICA" } }),
    );
    const result = await lookupOpenFoodFacts(VALID_EAN, { fetchImpl });
    expect(result?.brand).toBe("Coop");
  });

  it("returns a null brand when brands is absent", async () => {
    const { brands: _omit, ...rest } = FULL_PRODUCT;
    const fetchImpl = fakeFetch(okResponse({ status: 1, product: rest }));
    const result = await lookupOpenFoodFacts(VALID_EAN, { fetchImpl });
    expect(result?.brand).toBeNull();
  });

  it("prefers image_front_url over image_url", async () => {
    const fetchImpl = fakeFetch(okResponse({ status: 1, product: FULL_PRODUCT }));
    const result = await lookupOpenFoodFacts(VALID_EAN, { fetchImpl });
    expect(result?.imageUrl).toBe("https://images.example/front.jpg");
  });

  it("falls back to image_url when image_front_url is absent", async () => {
    const { image_front_url: _omit, ...rest } = FULL_PRODUCT;
    const fetchImpl = fakeFetch(okResponse({ status: 1, product: rest }));
    const result = await lookupOpenFoodFacts(VALID_EAN, { fetchImpl });
    expect(result?.imageUrl).toBe("https://images.example/other.jpg");
  });

  it("returns a null image when neither URL is present", async () => {
    const { image_front_url: _a, image_url: _b, ...rest } = FULL_PRODUCT;
    const fetchImpl = fakeFetch(okResponse({ status: 1, product: rest }));
    const result = await lookupOpenFoodFacts(VALID_EAN, { fetchImpl });
    expect(result?.imageUrl).toBeNull();
  });

  it("strips the language prefix from category tags", async () => {
    const fetchImpl = fakeFetch(
      okResponse({ status: 1, product: { ...FULL_PRODUCT, categories_tags: ["en:dairies", "fr:laits"] } }),
    );
    const result = await lookupOpenFoodFacts(VALID_EAN, { fetchImpl });
    expect(result?.categoryHints).toEqual(["dairies", "laits"]);
  });

  it("returns null on status: 0 (not found)", async () => {
    const fetchImpl = fakeFetch(okResponse({ status: 0, status_verbose: "product not found" }));
    const result = await lookupOpenFoodFacts(VALID_EAN, { fetchImpl });
    expect(result).toBeNull();
  });

  it("returns null on HTTP 404", async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 404, json: async () => ({}) });
    const result = await lookupOpenFoodFacts(VALID_EAN, { fetchImpl });
    expect(result).toBeNull();
  });

  it("returns null on HTTP 500", async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 500, json: async () => ({}) });
    const result = await lookupOpenFoodFacts(VALID_EAN, { fetchImpl });
    expect(result).toBeNull();
  });

  it("returns null on a malformed JSON body", async () => {
    const fetchImpl = fakeFetch({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });
    const result = await lookupOpenFoodFacts(VALID_EAN, { fetchImpl });
    expect(result).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const result = await lookupOpenFoodFacts(VALID_EAN, { fetchImpl });
    expect(result).toBeNull();
  });

  it("returns null on timeout", async () => {
    const fetchImpl = hangingFetch();
    const result = await lookupOpenFoodFacts(VALID_EAN, { fetchImpl, timeoutMs: 15 });
    expect(result).toBeNull();
  });

  it("honors the caller's own AbortSignal in addition to the internal timeout", async () => {
    const controller = new AbortController();
    const fetchImpl = hangingFetch();

    const promise = lookupOpenFoodFacts(VALID_EAN, {
      fetchImpl,
      timeoutMs: 5000,
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).resolves.toBeNull();
  });
});
