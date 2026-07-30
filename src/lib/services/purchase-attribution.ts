import { eq, sql } from "drizzle-orm";
import { products, purchases } from "@/db/schema";
import type { Id } from "@/lib/domain";

/**
 * Which vara did this purchase count for.
 *
 * A purchase attributes to exactly one of two things, and which one says how it
 * was recorded. Tapping a tile off the list writes `{item, null}` — we know the
 * vara because the vara is what was on the list. ANY scan writes
 * `{null, product}`, mapped or not, because what a scan knows is the thing on
 * the shelf. The vara is then read *through* the product rather than copied onto
 * the purchase, which is what this module is for.
 *
 * Not denormalising buys three things, and they are the reason the indirection
 * is worth it:
 *
 *   - Placing a product that nobody had placed yet retro-attributes its entire
 *     history the moment it is placed. Automatic, rather than a migration.
 *   - Correcting a wrong guess moves ALL of that product's past purchases with
 *     it. With the vara copied onto each row, a correction would fix the future
 *     and leave the past quietly wrong.
 *   - A split moves exactly the history it can honestly move. Scan-sourced
 *     purchases follow their product; tile-tap purchases stay on the vara. We
 *     know what we scanned; we do not know what we tapped, and dividing tapped
 *     history between the two sides would be inventing data.
 *
 * THE STATED COST: until a human places a product, its purchases resolve to NULL
 * and are invisible to cadence and to statistics. Deferred, not lost — the rows
 * are there and light up the moment the product is placed. That is exactly why
 * the review queue is the thing that makes the numbers true rather than cosmetic
 * tidying, and why it advertises the debt ("3 köp väntar på att placeras")
 * instead of hiding it.
 *
 * There is ONE implementation of the COALESCE and it is below. Two hand-written
 * versions of "which vara did this purchase count for" will agree on the easy
 * cases and disagree somewhere nobody tests — and the disagreement would surface
 * as a cadence that quietly counts a different number of purchases than the
 * statistics screen does, which is the kind of wrong that never looks like a bug.
 */

/**
 * The join every reader of purchase history needs.
 *
 * LEFT, not INNER: a tile-tap purchase has no product at all, and an inner join
 * would silently drop every one of them — which is most of the history.
 */
export const purchaseProductJoin = eq(products.id, purchases.productId);

/**
 * The effective vara, as a SQL expression, for use in a select projection.
 *
 * Requires `purchaseProductJoin` to be in the query. NULL is a real and expected
 * result: it means a scan-sourced purchase whose product nobody has placed yet.
 * Callers must skip those rather than invent a vara for them.
 */
export const effectiveCatalogItemId = sql<
  Id | null
>`coalesce(${purchases.catalogItemId}, ${products.catalogItemId})`;
