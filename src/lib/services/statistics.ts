import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { catalogItems, products, purchases } from "@/db/schema";
import type { Id } from "@/lib/domain";
import {
  effectiveCatalogItemId,
  purchaseProductJoin,
} from "./purchase-attribution";

/**
 * What the household actually bought.
 *
 * Reads only. Every number here comes from `purchases`, which is the one table
 * retention never prunes — a purchase is not bookkeeping about a deletion, it is
 * the only record that the household bought the thing, and it is the sole input
 * to both the cadence engine and this screen.
 *
 * Deliberately NOT here, per the spec's own out-of-scope list: charts of any
 * kind, spend (no prices exist anywhere in this app), and consumption-rate
 * statistics. What is left is the set of questions two people sharing a list
 * actually ask each other, and each of them is a count with a name on it.
 *
 * Every query attributes through `effectiveCatalogItemId` rather than reading
 * `purchases.catalog_item_id` directly. That is not a style preference: a
 * scan-sourced purchase carries a product and no vara, so a query that skipped
 * the COALESCE would silently under-count exactly the purchases made in a shop
 * with the scanner — the ones most likely to be the real shopping.
 */

/**
 * The purchase resolved to a vara.
 *
 * NULL is a real result rather than an anomaly — it is a scan whose product
 * nobody has placed yet — so every count above the fold filters on this, and
 * `unplacedPurchases` counts precisely what it excludes.
 */
const attributed = sql`${effectiveCatalogItemId} is not null`;

export interface PersonStat {
  actor: string;
  purchases: number;
}

export interface VaraStat {
  catalogItemId: Id;
  name: string;
  iconRef: string;
  purchases: number;
  lastPurchasedAt: string;
}

export interface Statistics {
  /**
   * The clock these counts were taken against.
   *
   * Returned rather than read again by the caller, so "3 dgr sedan" is measured
   * from the same instant the window was cut at. Two reads of the clock in one
   * render is also what React's purity rule objects to, and it is right to: a
   * component that asks the time is a component whose output changes when
   * nothing did.
   */
  now: Date;
  /** Inclusive lower bound the counts were taken over, or null for all time. */
  since: Date | null;
  totalPurchases: number;
  people: PersonStat[];
  topVaror: VaraStat[];
  /**
   * Scan-sourced purchases whose product nobody has placed on a vara yet.
   *
   * Surfaced rather than hidden, and the spec says so in as many words: the
   * review queue "is not cosmetic tidying but the thing that makes the numbers
   * true", so the screen that shows the numbers is exactly where the debt
   * belongs. Every one of these is a purchase that happened and is not counted
   * anywhere above.
   */
  unplacedPurchases: number;
}

/** How many varor the "mest köpta" list names before it stops. */
const TOP_N = 12;

/**
 * @param windowDays How far back to count, or null for every purchase ever.
 *   Days rather than a `Date`, so the clock is read here — once, on the server —
 *   instead of by a component that is supposed to be a pure function of its
 *   props.
 */
export async function loadStatistics(
  windowDays: number | null,
  now: Date = new Date(),
): Promise<Statistics> {
  const since =
    windowDays === null
      ? null
      : new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const withinWindow = since ? gte(purchases.purchasedAt, since) : undefined;

  const [people, topVaror, totals, unplaced] = await Promise.all([
    /*
     * The roster, derived from who actually bought something.
     *
     * Anders's ruling, and it needs no new plumbing: auth reads Authelia's
     * `Remote-User`, so the actor is already distinct on every op and every
     * purchase row. The `users` table exists and is populated with nothing but
     * the dev user, so reading it here would mean maintaining a second roster
     * that can disagree with the first — and disagree silently, since a missing
     * row would read as "this person bought nothing".
     */
    db
      .select({
        actor: purchases.actor,
        purchases: sql<number>`count(*)::int`,
      })
      .from(purchases)
      .leftJoin(products, purchaseProductJoin)
      .where(and(attributed, withinWindow))
      .groupBy(purchases.actor)
      .orderBy(desc(sql`count(*)`)),

    db
      .select({
        catalogItemId: sql<Id>`${effectiveCatalogItemId}`,
        name: catalogItems.name,
        iconRef: catalogItems.iconRef,
        purchases: sql<number>`count(*)::int`,
        lastPurchasedAt: sql<string>`max(${purchases.purchasedAt})`,
      })
      .from(purchases)
      .leftJoin(products, purchaseProductJoin)
      // INNER, and that is the point: a purchase attributed to a vara the
      // catalog has since deleted or merged away has no name to print, and
      // printing its id would be worse than leaving it out of a top list.
      .innerJoin(catalogItems, eq(catalogItems.id, effectiveCatalogItemId))
      .where(and(attributed, withinWindow))
      .groupBy(sql`${effectiveCatalogItemId}`, catalogItems.name, catalogItems.iconRef)
      .orderBy(desc(sql`count(*)`), catalogItems.name)
      .limit(TOP_N),

    db
      .select({ total: sql<number>`count(*)::int` })
      .from(purchases)
      .leftJoin(products, purchaseProductJoin)
      .where(and(attributed, withinWindow)),

    db
      .select({ total: sql<number>`count(*)::int` })
      .from(purchases)
      .leftJoin(products, purchaseProductJoin)
      .where(and(isNull(effectiveCatalogItemId), withinWindow)),
  ]);

  return {
    now,
    since,
    totalPurchases: totals[0]?.total ?? 0,
    people,
    topVaror,
    unplacedPurchases: unplaced[0]?.total ?? 0,
  };
}
