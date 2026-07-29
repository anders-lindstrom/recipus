import { eq } from "drizzle-orm";
import { db } from "@/db";
import { barcodes, catalogItems } from "@/db/schema";
import { authenticate, AuthError } from "@/lib/auth";
import { lookupOpenFoodFacts, normalizeBarcode } from "@/lib/barcode";

/**
 * Resolving a scanned barcode, cheapest source first.
 *
 * 1. The household's own map — instant, and the only step that still matters
 *    after a few months of shopping.
 * 2. Open Food Facts — decent Swedish coverage, but a network round trip.
 * 3. Nothing, and the app asks you. Whatever you answer is stored, so every
 *    unknown barcode costs exactly one question, once.
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ean: string }> },
) {
  try {
    authenticate(request.headers);
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const { ean: raw } = await params;
  const ean = normalizeBarcode(raw);
  if (!ean) {
    return Response.json({ error: "Ogiltig streckkod" }, { status: 400 });
  }

  const [known] = await db
    .select()
    .from(barcodes)
    .where(eq(barcodes.ean, ean))
    .limit(1);

  if (known) {
    return Response.json({
      ean,
      catalogItemId: known.catalogItemId,
      productName: known.productName,
      brand: known.brand,
      imageUrl: known.imageUrl,
      source: known.source,
    });
  }

  const product = await lookupOpenFoodFacts(ean);
  if (!product) {
    // Not an error. An unknown barcode is an ordinary outcome, and the client
    // turns this into "what is this?" rather than a failure message.
    return Response.json({ ean, catalogItemId: null }, { status: 404 });
  }

  // Remember what Open Food Facts said even though we cannot yet map it to a
  // catalog item — it saves the round trip next time and gives the user a name
  // to recognise when they are asked.
  await db
    .insert(barcodes)
    .values({
      ean,
      catalogItemId: null,
      productName: product.name,
      brand: product.brand,
      imageUrl: product.imageUrl,
      source: "off",
    })
    .onConflictDoNothing();

  return Response.json({
    ean,
    catalogItemId: null,
    productName: product.name,
    brand: product.brand,
    imageUrl: product.imageUrl,
    source: "off",
  });
}

/** Record the household's own mapping — the answer to "what is this?". */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ ean: string }> },
) {
  try {
    authenticate(request.headers);
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const { ean: raw } = await params;
  const ean = normalizeBarcode(raw);
  if (!ean) {
    return Response.json({ error: "Ogiltig streckkod" }, { status: 400 });
  }

  const body = (await request.json()) as { catalogItemId?: string };
  const catalogItemId = body.catalogItemId;
  if (!catalogItemId) {
    return Response.json({ error: "catalogItemId saknas" }, { status: 400 });
  }

  const [item] = await db
    .select({ id: catalogItems.id })
    .from(catalogItems)
    .where(eq(catalogItems.id, catalogItemId))
    .limit(1);
  if (!item) {
    return Response.json({ error: "Okänd vara" }, { status: 400 });
  }

  await db
    .insert(barcodes)
    .values({ ean, catalogItemId, source: "manual" })
    .onConflictDoUpdate({
      target: barcodes.ean,
      // A human correcting an Open Food Facts guess is always right.
      set: { catalogItemId, source: "manual" },
    });

  return Response.json({ ean, catalogItemId });
}
