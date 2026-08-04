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

/**
 * A vara's fields, stated once and shaped twice.
 *
 * The two readings differ on exactly one field and cannot be derived from each
 * other, which is why the field list is lifted out rather than `.partial()`-ed
 * off the schema below.
 *
 * Creating a vara TOLERATES a missing `hidden`, because ops written before
 * hiding existed are still in the log and must parse and apply as they did the
 * day they were written — "not hidden" is what they meant.
 *
 * Patching a vara must NOT default it, and that is load-bearing rather than
 * tidy. The reducer stamps a field's clock only when the patch makes a claim
 * about it (`catalogFieldPatch` returns nothing for a silent field), so a
 * default firing on a patch would make a rename assert "and it is not hidden"
 * — letting an op with no opinion about hiding beat one that has one. That is
 * the moving-clock bug this codebase has already paid for on `note`, `amount`,
 * `priority` and the four product fields.
 *
 * Verified by execution, and the reason this is not one schema: zod applies a
 * `.default()` THROUGH `.partial()`, so the obvious
 * `catalogItemSchema.omit({id:true}).partial()` silently reintroduced exactly
 * that bug. See "stays silent about hiding when the patch is" in
 * schemas.test.ts.
 */
const catalogItemFields = {
  id: z.string(),
  name: z.string(),
  nameNorm: z.string(),
  categoryId: z.string(),
  iconRef: z.string(),
  isCustom: z.boolean(),
  hasAtHome: z.boolean(),
  hidden: z.boolean(),
  useCount: z.number().int(),
  lastUsedAt: z.string().nullable(),
};

export const catalogItemSchema = z
  .object({ ...catalogItemFields, hidden: z.boolean().optional().default(false) })
  .openapi("CatalogItem");

/** The patch shape: every field optional, and none of them defaulted. */
const catalogItemPatchSchema = z
  .object(catalogItemFields)
  .omit({ id: true })
  .partial();

export const listSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    icon: z.string(),
    position: z.number(),
    categoryOrder: z.array(z.string()),
  })
  .openapi("List");

export const prioritySchema = z
  .enum(["urgent", "normal", "convenient"])
  .openapi("Priority");

export const listEntrySchema = z
  .object({
    id: z.string(),
    listId: z.string(),
    catalogItemId: z.string(),
    createdAt: z.string(),
    createdBy: z.string(),
    removedAt: z.string().nullable(),
    priority: prioritySchema,
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
    modifier: z.string().nullable(),
  })
  .openapi("Contribution");

export const recipeAdditionInfoSchema = z
  .object({ recipeTitle: z.string(), scaleFactor: z.number() })
  .openapi("RecipeAdditionInfo");

/** The reducer's shape, as carried in a snapshot. */
export const recipeAdditionSchema = z
  .object({
    id: z.string(),
    listId: z.string(),
    recipeId: z.string(),
    scaleFactor: z.number(),
    addedAt: z.string(),
    addedBy: z.string(),
  })
  .openapi("RecipeAddition");

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

/** GET /api/recipes row — the list view, without the full ingredient bodies. */
export const recipeSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    imageUrl: z.string().nullable(),
    servings: z.number(),
    servingsUnit: z.string(),
    sourceUrl: z.string().nullable(),
    ingredientCount: z.number().int(),
  })
  .openapi("RecipeSummary");

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

/**
 * The registry's three record shapes. Declared HERE rather than beside the
 * registry ops below, because `listSnapshotSchema` carries them too and a `const`
 * referenced before its declaration is a runtime ReferenceError, not a type
 * error — the module body evaluates top to bottom.
 */
export const productSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    brand: z.string().nullable(),
    catalogItemId: z.string().nullable(),
    defaultSize: amountSchema.nullable(),
    sourceSizeText: z.string().nullable(),
    imageUrl: z.string().nullable(),
    createdAt: z.string(),
    createdBy: z.string(),
  })
  .openapi("Product");

export const catalogItemAliasSchema = z
  .object({
    aliasNorm: z.string(),
    catalogItemId: z.string(),
    createdAt: z.string(),
    createdBy: z.string(),
  })
  .openapi("CatalogItemAlias");

/** One EAN pointing at a product — not to be confused with `barcodeSchema`,
 * which is the flattened read model the scan endpoint answers with. */
export const barcodeLinkSchema = z
  .object({
    ean: z.string(),
    productId: z.string(),
    source: z.enum(["off", "manual"]),
  })
  .openapi("BarcodeLink");

export const listSnapshotSchema = z
  .object({
    list: listSchema,
    categories: z.array(categorySchema),
    catalog: z.array(catalogItemSchema),
    entries: z.array(listEntrySchema),
    contributions: z.array(contributionSchema),
    // The registry, household-wide like `catalog`. Without it a hydrating client
    // holds an empty registry until an op happens to arrive, and on a cold open
    // in a shop none will — so scanning would ask again about barcodes the
    // household answered months ago.
    products: z.array(productSchema),
    aliases: z.array(catalogItemAliasSchema),
    barcodes: z.array(barcodeLinkSchema),
    // Full records, in the reducer's shape — a hydrating client needs to
    // populate SyncState.recipeAdditions, which display info cannot do.
    recipeAdditions: z.record(z.string(), recipeAdditionSchema),
    recipeTitles: z.record(z.string(), z.string()),
    // Last-write-wins bookkeeping, so a hydrating client does not start blind
    // and let a stale outbox op beat a fresher server value.
    meta: z.record(
      z.string(),
      z.object({
        at: z.string(),
        by: z.string(),
        deleted: z.boolean().optional(),
      }),
    ),
    // Per-item purchase cadence, household-wide. Feeds the "you probably still
    // have this" exclusion in the recipe sheet.
    purchaseStats: z.record(
      z.string(),
      z.object({
        purchaseCount: z.number(),
        medianIntervalDays: z.number().nullable(),
        confidence: z.number(),
        overdueScore: z.number().nullable(),
        daysSinceLast: z.number().nullable(),
      }),
    ),
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
  patch: catalogItemPatchSchema,
});

const addItemOpSchema = z.object({
  ...opBase,
  kind: z.literal("add_item"),
  listId: z.string(),
  catalogItemId: z.string(),
  /**
   * Optional, and absent from every `add_item` written before undo learned to
   * retract purchases. A stored op replayed from the log must parse and apply
   * exactly as it did the day it was created, so this can never become required.
   */
  undoesClientOpId: z.string().optional(),
  /**
   * The scanner's opt-out, and absent for the same reason `undoesClientOpId`
   * is: it was added after ops carrying neither had already been written.
   *
   * Missing from this schema until it cost real purchases. `Op` declared it,
   * `list-client.tsx` sent it and `apply-op.ts` read it, but zod strips what it
   * does not declare — so the server never saw it, and scanning a second
   * identical bottle retracted the first one's purchase instead of recording a
   * second. Nothing failed: the op parsed, applied, and did the opposite of
   * what was asked. Every test of the behaviour called `applyOp` directly and
   * so never came in by this door. See `MAXIMAL` in schemas.test.ts, which now
   * walks every kind for exactly this.
   */
  keepsPurchase: z.boolean().optional(),
});

const removeItemOpSchema = z.object({
  ...opBase,
  kind: z.literal("remove_item"),
  listId: z.string(),
  catalogItemId: z.string(),
  bought: z.boolean(),
  /**
   * Set by scanning, and by nothing else. See the op's own comment for why
   * `purchases` wants the product rather than the vara for a scan.
   *
   * Optional, and absent from every `remove_item` written before scanning
   * recorded its product — a stored op replayed from the log must parse and
   * apply exactly as it did the day it was written.
   */
  productId: z.string().optional(),
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

const setModifierOpSchema = z.object({
  ...opBase,
  kind: z.literal("set_modifier"),
  listId: z.string(),
  catalogItemId: z.string(),
  modifier: z.string().nullable(),
});

const setPriorityOpSchema = z.object({
  ...opBase,
  kind: z.literal("set_priority"),
  listId: z.string(),
  catalogItemId: z.string(),
  priority: prioritySchema,
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

const repointRecipeItemOpSchema = z.object({
  ...opBase,
  kind: z.literal("repoint_recipe_item"),
  listId: z.string(),
  recipeAdditionId: z.string(),
  fromCatalogItemId: z.string(),
  toCatalogItemId: z.string(),
  amount: amountSchema.nullable(),
});

const moveItemOpSchema = z.object({
  ...opBase,
  kind: z.literal("move_item"),
  fromListId: z.string(),
  toListId: z.string(),
  catalogItemId: z.string(),
  /**
   * Required, unlike `add_item.undoesClientOpId`, because no `move_item` has
   * ever been written: nothing dispatches one yet, and the `ops` table holds
   * none. A stored op must replay exactly as it did the day it was created, so
   * the moment the first one IS logged these can never become optional again.
   *
   * The reducer needs them both to stay order-independent — see sync/ops.ts.
   */
  priority: prioritySchema,
  manual: z
    .object({
      amount: amountSchema.nullable(),
      note: z.string().nullable(),
      modifier: z.string().nullable(),
    })
    .nullable(),
});

/**
 * The registry ops. Mirrors the `RegistryOp` union in src/lib/sync/ops.ts —
 * see there for why any of this is shaped the way it is. `productSchema` is
 * declared with the other entities above, since the snapshot carries it too.
 */
const createProductOpSchema = z.object({
  ...opBase,
  kind: z.literal("create_product"),
  product: productSchema,
});

const updateProductOpSchema = z.object({
  ...opBase,
  kind: z.literal("update_product"),
  productId: z.string(),
  // Partial on purpose, and the reducer treats "absent" as "says nothing about
  // this field" rather than "set it to undefined" — a patch silent about the
  // brand must not stamp the brand's clock.
  patch: productSchema
    .pick({
      name: true,
      brand: true,
      catalogItemId: true,
      defaultSize: true,
      sourceSizeText: true,
    })
    .partial(),
});

const linkBarcodeOpSchema = z.object({
  ...opBase,
  kind: z.literal("link_barcode"),
  ean: z.string().min(1),
  productId: z.string(),
  source: z.enum(["off", "manual"]),
});

const deleteCatalogItemOpSchema = z.object({
  ...opBase,
  kind: z.literal("delete_catalog_item"),
  itemId: z.string(),
});

const mergeCatalogItemsOpSchema = z.object({
  ...opBase,
  kind: z.literal("merge_catalog_items"),
  fromItemId: z.string(),
  toItemId: z.string(),
  aliasNorm: z.string().min(1),
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
    setModifierOpSchema,
    setPriorityOpSchema,
    addRecipeOpSchema,
    removeRecipeOpSchema,
    repointRecipeItemOpSchema,
    moveItemOpSchema,
    createProductOpSchema,
    updateProductOpSchema,
    linkBarcodeOpSchema,
    deleteCatalogItemOpSchema,
    mergeCatalogItemsOpSchema,
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
