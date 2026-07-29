/**
 * Open Food Facts client -- the third step of the barcode resolution chain
 * (local map -> server map -> Open Food Facts -> ask the user). See
 * docs/superpowers/specs/2026-07-29-recipus-design.md §5.5.
 *
 * An unknown or unreachable barcode is a completely ordinary outcome here:
 * every failure mode below resolves to `null` rather than throwing, so the
 * caller can fall back to asking the user without a try/catch of its own.
 */

import { isValidBarcode } from "./ean";

const OFF_BASE_URL = "https://world.openfoodfacts.org/api/v2/product";
const OFF_FIELDS =
  "code,product_name,product_name_sv,brands,image_front_url,image_url,categories_tags,quantity";
const USER_AGENT = "Recipus/0.1 (self-hosted household shopping list)";
const DEFAULT_TIMEOUT_MS = 5000;

export interface OffProduct {
  ean: string;
  name: string | null;
  brand: string | null;
  imageUrl: string | null;
  /** OFF's category tags, used later to guess a catalog category. */
  categoryHints: string[];
  quantity: string | null; // "1 l", "500 g" as printed on the package
}

interface OffApiProduct {
  code?: string;
  product_name?: string;
  product_name_sv?: string;
  brands?: string;
  image_front_url?: string;
  image_url?: string;
  categories_tags?: string[];
  quantity?: string;
}

interface OffApiResponse {
  status?: number;
  product?: OffApiProduct;
}

function stripLangPrefix(tag: string): string {
  const separator = tag.indexOf(":");
  return separator === -1 ? tag : tag.slice(separator + 1);
}

function firstBrand(brands: string | undefined): string | null {
  if (!brands) return null;
  const first = brands.split(",")[0].trim();
  return first.length > 0 ? first : null;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Combines the caller's abort signal (if any) with our own timeout into one
 * signal, so either one aborts the request. Returns a `cancel` to release the
 * timer and listener once the request settles.
 */
function withTimeout(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new DOMException("Open Food Facts request timed out", "TimeoutError")),
    timeoutMs,
  );

  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

export async function lookupOpenFoodFacts(
  ean: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal },
): Promise<OffProduct | null> {
  if (!isValidBarcode(ean)) return null;

  const fetchImpl = opts?.fetchImpl ?? fetch;
  const { signal, cancel } = withTimeout(opts?.signal, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const url = `${OFF_BASE_URL}/${encodeURIComponent(ean)}.json?fields=${OFF_FIELDS}`;
    const response = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    });

    if (!response.ok) return null; // includes 404 ("not found") and 5xx

    let body: OffApiResponse;
    try {
      body = await response.json();
    } catch {
      return null; // malformed/absent JSON body
    }

    if (!body || body.status === 0 || !body.product) return null;

    const product = body.product;
    return {
      ean,
      name: nonEmpty(product.product_name_sv) ?? nonEmpty(product.product_name),
      brand: firstBrand(product.brands),
      imageUrl: nonEmpty(product.image_front_url) ?? nonEmpty(product.image_url),
      categoryHints: (product.categories_tags ?? []).map(stripLangPrefix),
      quantity: nonEmpty(product.quantity),
    };
  } catch {
    return null; // network error or timeout
  } finally {
    cancel();
  }
}
