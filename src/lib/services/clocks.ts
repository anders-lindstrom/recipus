import type { RecordMeta } from "@/lib/domain";
import type { CatalogField, ProductField } from "@/lib/sync";

/**
 * Reading per-field last-write-wins clocks out of database rows.
 *
 * Shared by the two loaders — `apply-op`'s slice loader and `list-data`'s
 * snapshot — because they reconstruct the same meta for the same reducer, and a
 * clock the two disagree about is worse than one neither has. The last time a
 * reconstruction detail lived in two places it drifted, and a drifted meta key
 * does not throw: it reads as "no prior record", so the newest write always wins
 * and conflict resolution quietly stops working.
 *
 * There is deliberately no fallback to a row-level clock anywhere in here. A row
 * clock moves whenever any field is written, so a field falling back to it
 * inherits unrelated writes' timestamps — which is not a default, it is a second
 * clock nobody declared. A catalog item's four columns are NOT NULL as of
 * drizzle/0003; a product's are NULLABLE, and that difference is meaning rather
 * than laxity — see `productFieldClocks`.
 */

/** The shape both loaders' catalog rows share. */
export interface CatalogClockRow {
  nameUpdatedAt: Date;
  nameUpdatedBy: string;
  categoryUpdatedAt: Date;
  categoryUpdatedBy: string;
  iconUpdatedAt: Date;
  iconUpdatedBy: string;
  homeUpdatedAt: Date;
  homeUpdatedBy: string;
  hiddenUpdatedAt: Date;
  hiddenUpdatedBy: string;
}

export function catalogFieldClocks(
  row: CatalogClockRow,
): Array<[CatalogField, RecordMeta]> {
  return [
    ["name", { at: row.nameUpdatedAt.toISOString(), by: row.nameUpdatedBy }],
    [
      "category",
      { at: row.categoryUpdatedAt.toISOString(), by: row.categoryUpdatedBy },
    ],
    ["icon", { at: row.iconUpdatedAt.toISOString(), by: row.iconUpdatedBy }],
    ["home", { at: row.homeUpdatedAt.toISOString(), by: row.homeUpdatedBy }],
    [
      "hidden",
      { at: row.hiddenUpdatedAt.toISOString(), by: row.hiddenUpdatedBy },
    ],
  ];
}

/**
 * The clock columns for a catalog write, one pair per field.
 *
 * Every write supplies all four, taken from the reducer's own meta. That is
 * what makes a write idempotent: a losing op's `next` state equals the loaded
 * state exactly, so it rewrites the clocks it just read.
 *
 * Spelled out rather than built from a field→column map so the return type is
 * exactly the row shape — a map would satisfy the compiler with an index
 * signature and let a missing column through to a NOT NULL violation at runtime.
 */
export function catalogClockColumns(
  metaOf: (field: CatalogField) => RecordMeta,
): CatalogClockRow {
  const name = metaOf("name");
  const category = metaOf("category");
  const icon = metaOf("icon");
  const home = metaOf("home");
  const hidden = metaOf("hidden");
  return {
    nameUpdatedAt: new Date(name.at),
    nameUpdatedBy: name.by,
    categoryUpdatedAt: new Date(category.at),
    categoryUpdatedBy: category.by,
    iconUpdatedAt: new Date(icon.at),
    iconUpdatedBy: icon.by,
    homeUpdatedAt: new Date(home.at),
    homeUpdatedBy: home.by,
    hiddenUpdatedAt: new Date(hidden.at),
    hiddenUpdatedBy: hidden.by,
  };
}

/**
 * The shape both loaders' product rows share — every clock NULLABLE.
 *
 * The nullability is the difference from `CatalogClockRow`, and it is deliberate
 * rather than an oversight: a vara is born with all four of its facts asserted by
 * whoever created it, so "never written" is not a state it can be in. A product
 * is born from Open Food Facts, and its mapping to a vara starts genuinely
 * unasserted — that is the whole state the review queue exists to clear.
 */
export interface ProductClockRow {
  nameUpdatedAt: Date | null;
  nameUpdatedBy: string | null;
  brandUpdatedAt: Date | null;
  brandUpdatedBy: string | null;
  sizeUpdatedAt: Date | null;
  sizeUpdatedBy: string | null;
  itemUpdatedAt: Date | null;
  itemUpdatedBy: string | null;
}

/**
 * A NULL column emits NOTHING — never a fallback to the row clock.
 *
 * Absent meta is exactly what the reducer holds for a field no op has touched:
 * `wins(op, undefined)` is true, so the first write lands whatever its timestamp
 * says. Filling the gap from `products.updated_at` would put OFF's guess about a
 * name ahead of a human's correction made on a phone whose clock sat behind the
 * server's — the moving-clock bug, in the one place where nobody would look.
 */
export function productFieldClocks(
  row: ProductClockRow,
): Array<[ProductField, RecordMeta]> {
  const out: Array<[ProductField, RecordMeta]> = [];
  for (const [field, at, by] of [
    ["name", row.nameUpdatedAt, row.nameUpdatedBy],
    ["brand", row.brandUpdatedAt, row.brandUpdatedBy],
    ["size", row.sizeUpdatedAt, row.sizeUpdatedBy],
    ["item", row.itemUpdatedAt, row.itemUpdatedBy],
  ] as const) {
    if (at && by) out.push([field, { at: at.toISOString(), by }]);
  }
  return out;
}

/**
 * The clock columns for a product write, one pair per field.
 *
 * `metaOf` returns undefined for a field the reducer holds no clock for, and that
 * writes NULL rather than borrowing another clock — the read side above depends
 * on it. Every write supplies all four from the reducer's own meta, which is what
 * makes the write idempotent: a losing op's `next` equals the loaded state
 * exactly, so it rewrites the clocks it just read, NULLs included.
 *
 * Spelled out rather than built from a field→column map, for the same reason
 * `catalogClockColumns` is: a map satisfies the compiler with an index signature
 * and lets a missing column through to runtime.
 */
export function productClockColumns(
  metaOf: (field: ProductField) => RecordMeta | undefined,
): ProductClockRow {
  const name = metaOf("name");
  const brand = metaOf("brand");
  const size = metaOf("size");
  const item = metaOf("item");
  return {
    nameUpdatedAt: name ? new Date(name.at) : null,
    nameUpdatedBy: name?.by ?? null,
    brandUpdatedAt: brand ? new Date(brand.at) : null,
    brandUpdatedBy: brand?.by ?? null,
    sizeUpdatedAt: size ? new Date(size.at) : null,
    sizeUpdatedBy: size?.by ?? null,
    itemUpdatedAt: item ? new Date(item.at) : null,
    itemUpdatedBy: item?.by ?? null,
  };
}

/**
 * "Last touched by anyone", derived rather than stamped.
 *
 * `catalog_items.updated_at`/`updated_by` are read by exactly two things: the
 * `create_catalog_item` comparison, and the seed guard, which refuses to
 * overwrite a row whose `updated_by` is no longer the seed actor. Both want the
 * most recent write to the row, whichever field it touched — so taking the max
 * over the field clocks is both correct and order-independent, where stamping it
 * with whichever op happened to arrive last is neither.
 *
 * Without this a household rename would leave `updated_by = 'system'` and the
 * next deploy's seed would silently revert it, in production only.
 */
export function latestClock(clocks: RecordMeta[]): RecordMeta {
  return clocks.reduce((best, c) =>
    c.at > best.at || (c.at === best.at && c.by > best.by) ? c : best,
  );
}
