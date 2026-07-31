import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { barcodes, products } from "@/db/schema";
import { lookupOpenFoodFacts, normalizeBarcode } from "@/lib/barcode";
import type { ApiEnv } from "..";
import {
  barcodeMappingSchema,
  barcodeSchema,
  errorSchema,
  jsonBody,
  jsonRes,
} from "../schemas";

const eanParam = z.object({
  ean: z.string().min(1).openapi({ param: { name: "ean", in: "path" } }),
});

export function barcodeRoutes() {
  const app = new OpenAPIHono<ApiEnv>();

  app.openapi(
    createRoute({
      method: "get",
      path: "/{ean}",
      tags: ["barcode"],
      description:
        "Resolve a barcode, cheapest source first: the household's own map, then Open Food Facts. An Open Food Facts hit is NOT persisted here — only PUT records a mapping, once a person has confirmed it (whatever the user answers is stored, per the design doc — not whatever OFF guesses).",
      request: { params: eanParam },
      responses: {
        200: jsonRes(barcodeSchema, "Known mapping, or an Open Food Facts lookup"),
        400: jsonRes(errorSchema, "Not a valid EAN"),
        404: jsonRes(errorSchema, "Unknown barcode"),
      },
    }),
    async (c) => {
      const { ean: raw } = c.req.valid("param");
      const ean = normalizeBarcode(raw);
      if (!ean) return c.json({ error: "Ogiltig streckkod" }, 400);

      // The response shape predates the registry and is unchanged; only where
      // each field lives has moved. The name, brand and image are on the
      // product now, and the mapping to a vara went with them — a barcode row
      // is nothing but a pointer. See drizzle/0005.
      const [row] = await db
        .select({
          ean: barcodes.ean,
          catalogItemId: products.catalogItemId,
          productName: products.name,
          brand: products.brand,
          imageUrl: products.imageUrl,
          source: barcodes.source,
        })
        .from(barcodes)
        .innerJoin(products, eq(products.id, barcodes.productId))
        .where(eq(barcodes.ean, ean))
        .limit(1);
      if (row) return c.json(row, 200);

      const off = await lookupOpenFoodFacts(ean);
      if (!off) return c.json({ error: "Okänd streckkod" }, 404);

      return c.json(
        {
          ean: off.ean,
          catalogItemId: null,
          productName: off.name,
          brand: off.brand,
          imageUrl: off.imageUrl,
          source: "off" as const,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/{ean}",
      tags: ["barcode"],
      description:
        "Record the household's own EAN → catalog item mapping. Every unknown barcode costs one question, once — after this, scanning it resolves instantly and offline from the local map.",
      request: { params: eanParam, body: jsonBody(barcodeMappingSchema) },
      responses: {
        200: jsonRes(barcodeSchema, "Stored mapping"),
        400: jsonRes(errorSchema, "Not a valid EAN or unknown catalog item"),
      },
    }),
    async (c) => {
      const { ean: raw } = c.req.valid("param");
      const ean = normalizeBarcode(raw);
      if (!ean) return c.json({ error: "Ogiltig streckkod" }, 400);
      const { catalogItemId } = c.req.valid("json");
      const actor = c.get("actor");
      const now = new Date();
      // Derived, exactly as a scan would mint it, so this route and the scan
      // path converge on one product row rather than two.
      const productId = `prod:${ean}`;

      try {
        const row = await db.transaction(async (tx) => {
          const [product] = await tx
            .insert(products)
            .values({
              id: productId,
              // Nothing here knows the product's real name — the body carries
              // only the mapping. The EAN stands in until a lookup or a person
              // supplies one, which is the same placeholder drizzle/0005 used
              // when promoting nameless barcode rows.
              name: ean,
              catalogItemId,
              createdBy: actor,
              // The mapping is the one fact a person just asserted, so it is the
              // one clock this write is entitled to stamp. Name, brand and size
              // stay unwritten — NULL — because this request said nothing about
              // them, and stamping a clock for a field an op did not touch is
              // the bug DECISIONS.md names three times.
              itemUpdatedAt: now,
              itemUpdatedBy: actor,
              updatedAt: now,
              updatedBy: actor,
            })
            .onConflictDoUpdate({
              target: products.id,
              // A human correcting an Open Food Facts guess is always right —
              // but leave the name, brand and image alone, since this body
              // carries only the mapping, not fresh product details.
              set: {
                catalogItemId,
                itemUpdatedAt: now,
                itemUpdatedBy: actor,
                updatedAt: now,
                updatedBy: actor,
              },
            })
            .returning({
              catalogItemId: products.catalogItemId,
              productName: products.name,
              brand: products.brand,
              imageUrl: products.imageUrl,
            });

          const [barcode] = await tx
            .insert(barcodes)
            .values({
              ean,
              productId,
              source: "manual",
              createdBy: actor,
              updatedAt: now,
              updatedBy: actor,
            })
            .onConflictDoUpdate({
              target: barcodes.ean,
              set: {
                productId,
                source: "manual",
                updatedAt: now,
                updatedBy: actor,
              },
            })
            .returning({ ean: barcodes.ean, source: barcodes.source });

          return { ...barcode, ...product };
        });

        return c.json(row, 200);
      } catch {
        return c.json({ error: "Okänd vara" }, 400);
      }
    },
  );

  return app;
}
