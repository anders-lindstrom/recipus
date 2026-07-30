import type { RecordMeta } from "@/lib/domain";
import type { CatalogField } from "@/lib/sync";

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
 * clock nobody declared. Every column these read is NOT NULL as of
 * drizzle/0003.
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
  return {
    nameUpdatedAt: new Date(name.at),
    nameUpdatedBy: name.by,
    categoryUpdatedAt: new Date(category.at),
    categoryUpdatedBy: category.by,
    iconUpdatedAt: new Date(icon.at),
    iconUpdatedBy: icon.by,
    homeUpdatedAt: new Date(home.at),
    homeUpdatedBy: home.by,
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
