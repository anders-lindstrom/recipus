import { z } from "@hono/zod-openapi";

/**
 * Zod (OpenAPI) schemas for the API layer.
 *
 * These mirror the domain types in src/lib/domain.ts and the op union in
 * src/lib/sync/ops.ts field-for-field. They exist only at the HTTP boundary —
 * everything past request validation works with the plain domain types.
 */

export function jsonBody<T extends z.ZodTypeAny>(schema: T) {
  return { content: { "application/json": { schema } }, required: true };
}

export function jsonRes<T extends z.ZodTypeAny>(schema: T, description: string) {
  return { content: { "application/json": { schema } }, description };
}

export const errorSchema = z.object({ error: z.string() }).openapi("Error");

// ---------------------------------------------------------------------------
// Units and amounts — see src/lib/domain.ts
// ---------------------------------------------------------------------------

const UNIT_VALUES = [
  "ml",
  "krm",
  "tsk",
  "msk",
  "cl",
  "dl",
  "l",
  "g",
  "hg",
  "kg",
  "st",
  "förp",
  "burk",
  "påse",
  "knippe",
  "pkt",
] as const;

export const unitSchema = z.enum(UNIT_VALUES).openapi("Unit");

export const amountSchema = z
  .object({ value: z.number(), unit: unitSchema })
  .openapi("Amount");

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const categorySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    icon: z.string(),
    position: z.number(),
  })
  .openapi("Category");

export const catalogItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    nameNorm: z.string(),
    categoryId: z.string(),
    iconRef: z.string(),
    isCustom: z.boolean(),
    hasAtHome: z.boolean(),
    useCount: z.number().int(),
    lastUsedAt: z.string().nullable(),
  })
  .openapi("CatalogItem");

export const listSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    icon: z.string(),
    position: z.number(),
    categoryOrder: z.array(z.string()),
  })
  .openapi("List");

export const listEntrySchema = z
  .object({
    id: z.string(),
    listId: z.string(),
    catalogItemId: z.string(),
    createdAt: z.string(),
    createdBy: z.string(),
    removedAt: z.string().nullable(),
    updatedAt: z.string(),
    updatedBy: z.string(),
  })
  .openapi("ListEntry");

export const contributionSchema = z
  .object({
    id: z.string(),
    entryId: z.string(),
    sourceKind: z.enum(["manual", "recipe", "scan", "suggestion"]),
    recipeAdditionId: z.string().nullable(),
    amount: amountSchema.nullable(),
    note: z.string().nullable(),
  })
  .openapi("Contribution");

export const recipeAdditionInfoSchema = z
  .object({ recipeTitle: z.string(), scaleFactor: z.number() })
  .openapi("RecipeAdditionInfo");

export const recipeIngredientSchema = z
  .object({
    id: z.string(),
    recipeId: z.string(),
    position: z.number(),
    rawText: z.string(),
    amount: amountSchema.nullable(),
    catalogItemId: z.string().nullable(),
  })
  .openapi("RecipeIngredient");

export const recipeSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    sourceUrl: z.string().nullable(),
    servings: z.number(),
    servingsUnit: z.string(),
    imageUrl: z.string().nullable(),
    ingredients: z.array(recipeIngredientSchema),
  })
  .openapi("Recipe");

export const barcodeSchema = z
  .object({
    ean: z.string(),
    catalogItemId: z.string().nullable(),
    productName: z.string().nullable(),
    brand: z.string().nullable(),
    imageUrl: z.string().nullable(),
    source: z.enum(["off", "manual"]),
  })
  .openapi("Barcode");

export const barcodeMappingSchema = z
  .object({ catalogItemId: z.string().min(1) })
  .openapi("BarcodeMapping");

export const listSnapshotSchema = z
  .object({
    list: listSchema,
    categories: z.array(categorySchema),
    catalog: z.array(catalogItemSchema),
    entries: z.array(listEntrySchema),
    contributions: z.array(contributionSchema),
    recipeAdditions: z.record(z.string(), recipeAdditionInfoSchema),
    suggestions: z.array(
      z.object({ catalogItemId: z.string(), reason: z.string() }),
    ),
  })
  .openapi("ListSnapshot");

export const recipeImportRequestSchema = z
  .object({ url: z.string().min(1) })
  .openapi("RecipeImportRequest");

// ---------------------------------------------------------------------------
// Ops — mirrors src/lib/sync/ops.ts exactly. See that file for the semantics;
// this only re-states the shape for request validation.
// ---------------------------------------------------------------------------

const opBase = {
  clientOpId: z.string().min(1),
  actor: z.string().min(1),
  at: z.iso.datetime({ offset: true }),
};

const createListOpSchema = z.object({
  ...opBase,
  kind: z.literal("create_list"),
  listId: z.string(),
  name: z.string(),
  icon: z.string(),
  position: z.number(),
  categoryOrder: z.array(z.string()),
});

const updateListOpSchema = z.object({
  ...opBase,
  kind: z.literal("update_list"),
  listId: z.string(),
  patch: z.object({
    name: z.string().optional(),
    icon: z.string().optional(),
    position: z.number().optional(),
    categoryOrder: z.array(z.string()).optional(),
  }),
});

const deleteListOpSchema = z.object({
  ...opBase,
  kind: z.literal("delete_list"),
  listId: z.string(),
});

const createCatalogItemOpSchema = z.object({
  ...opBase,
  kind: z.literal("create_catalog_item"),
  item: catalogItemSchema,
});

const updateCatalogItemOpSchema = z.object({
  ...opBase,
  kind: z.literal("update_catalog_item"),
  itemId: z.string(),
  patch: catalogItemSchema.omit({ id: true }).partial(),
});

const addItemOpSchema = z.object({
  ...opBase,
  kind: z.literal("add_item"),
  listId: z.string(),
  catalogItemId: z.string(),
});

const removeItemOpSchema = z.object({
  ...opBase,
  kind: z.literal("remove_item"),
  listId: z.string(),
  catalogItemId: z.string(),
  bought: z.boolean(),
});

const setAmountOpSchema = z.object({
  ...opBase,
  kind: z.literal("set_amount"),
  listId: z.string(),
  catalogItemId: z.string(),
  amount: amountSchema.nullable(),
});

const setNoteOpSchema = z.object({
  ...opBase,
  kind: z.literal("set_note"),
  listId: z.string(),
  catalogItemId: z.string(),
  note: z.string().nullable(),
});

const addRecipeOpSchema = z.object({
  ...opBase,
  kind: z.literal("add_recipe"),
  listId: z.string(),
  recipeId: z.string(),
  recipeAdditionId: z.string(),
  scaleFactor: z.number(),
  items: z.array(
    z.object({ catalogItemId: z.string(), amount: amountSchema.nullable() }),
  ),
});

const removeRecipeOpSchema = z.object({
  ...opBase,
  kind: z.literal("remove_recipe"),
  listId: z.string(),
  recipeAdditionId: z.string(),
});

const moveItemOpSchema = z.object({
  ...opBase,
  kind: z.literal("move_item"),
  fromListId: z.string(),
  toListId: z.string(),
  catalogItemId: z.string(),
});

export const opSchema = z
  .discriminatedUnion("kind", [
    createListOpSchema,
    updateListOpSchema,
    deleteListOpSchema,
    createCatalogItemOpSchema,
    updateCatalogItemOpSchema,
    addItemOpSchema,
    removeItemOpSchema,
    setAmountOpSchema,
    setNoteOpSchema,
    addRecipeOpSchema,
    removeRecipeOpSchema,
    moveItemOpSchema,
  ])
  .openapi("Op");

export const opEnvelopeSchema = z
  .object({ seq: z.number().int(), op: opSchema })
  .openapi("OpEnvelope");

export const opResultSchema = z
  .object({
    clientOpId: z.string(),
    seq: z.number().int().optional(),
    error: z.string().optional(),
  })
  .openapi("OpResult");
