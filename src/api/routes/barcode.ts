import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { barcodes } from "@/db/schema";
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

      const [row] = await db.select().from(barcodes).where(eq(barcodes.ean, ean)).limit(1);
      if (row) {
        return c.json(
          {
            ean: row.ean,
            catalogItemId: row.catalogItemId,
            productName: row.productName,
            brand: row.brand,
            imageUrl: row.imageUrl,
            source: row.source,
          },
          200,
        );
      }

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

      try {
        const [row] = await db
          .insert(barcodes)
          .values({
            ean,
            catalogItemId,
            productName: null,
            brand: null,
            imageUrl: null,
            source: "manual",
          })
          .onConflictDoUpdate({
            target: barcodes.ean,
            // A human correcting an Open Food Facts guess is always right —
            // but leave any existing productName/brand/imageUrl alone, since
            // this body carries only the mapping, not fresh product details.
            set: { catalogItemId, source: "manual" },
          })
          .returning();

        return c.json(
          {
            ean: row.ean,
            catalogItemId: row.catalogItemId,
            productName: row.productName,
            brand: row.brand,
            imageUrl: row.imageUrl,
            source: row.source,
          },
          200,
        );
      } catch {
        return c.json({ error: "Okänd vara" }, 400);
      }
    },
  );

  return app;
}
