import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The upgrade path, with data in it.
 *
 * CI already proves every migration applies to a FRESH database. Production is
 * not fresh — it is a database sitting at some earlier migration with real rows
 * in it, and the interesting failures only exist when there are rows: a bare
 * `ADD COLUMN … NOT NULL` aborts, a `DROP COLUMN` silently discards what nobody
 * copied out first, and a backfill that misses a case leaves a NULL where the
 * next migration demands a value.
 *
 * `drizzle/0005_registry.sql` is the sharp instance and the reason this file
 * exists. It restructures `barcodes` — every row has to be promoted into a
 * `products` row BEFORE the old columns are dropped — so "does it apply" and
 * "does it keep the household's barcodes" are two different questions, and only
 * the second one matters after a deploy.
 *
 * So this replays what the production database will actually experience: bring a
 * scratch database up to the deployed checkpoint, put representative rows in it,
 * then apply everything since and check what survived.
 */

const ADMIN_URL = process.env.DATABASE_URL;
const SCRATCH_DB = "recipus_upgrade_path_test";

/**
 * The last migration the running install has applied.
 *
 * Deliberately a constant rather than "all but the last few": it names the state
 * production is genuinely in, so the test keeps meaning the same thing as more
 * migrations land. Bump it when a deploy goes out, and the test starts guarding
 * the next gap instead of re-proving the one already shipped.
 */
const DEPLOYED_THROUGH = "0005";

function migrationFiles(): string[] {
  return readdirSync(join(process.cwd(), "drizzle"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function adminSql() {
  if (!ADMIN_URL) throw new Error("DATABASE_URL is required");
  return postgres(ADMIN_URL, { max: 1 });
}

function scratchUrl(): string {
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

let scratch: ReturnType<typeof postgres>;

async function apply(files: string[]): Promise<void> {
  for (const file of files) {
    const sqlText = readFileSync(join(process.cwd(), "drizzle", file), "utf8");
    // `--> statement-breakpoint` is a SQL comment, so the whole file runs as one
    // simple query — which is also how `drizzle-kit migrate` sends it.
    await scratch.unsafe(sqlText).simple();
  }
}

beforeAll(async () => {
  const admin = adminSql();
  // Dropped first so a crashed earlier run cannot make this one pass or fail for
  // the wrong reason.
  await admin.unsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
  await admin.unsafe(`CREATE DATABASE "${SCRATCH_DB}"`);
  await admin.end();
  scratch = postgres(scratchUrl(), { max: 1 });
}, 30_000);

afterAll(async () => {
  await scratch?.end();
  const admin = adminSql();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
  await admin.end();
}, 30_000);

describe("upgrading a populated database", () => {
  it("keeps the household's data across every migration since the deploy", async () => {
    const all = migrationFiles();
    const deployed = all.filter((f) => f <= `${DEPLOYED_THROUGH}_zzzz.sql`);
    const pending = all.filter((f) => !deployed.includes(f));

    // The constant has to name a migration that exists — a typo would silently
    // treat everything as pending and test an upgrade from nothing.
    expect(deployed.length).toBeGreaterThan(0);

    // Nothing shipped since the last deploy, so there is genuinely no upgrade to
    // verify yet. Skipping is right, and saying so is better than a green tick
    // that looks like proof: this test only means something between a migration
    // landing and the deploy that carries it.
    if (pending.length === 0) {
      console.log(
        `No migrations pending since ${DEPLOYED_THROUGH} — nothing to verify.`,
      );
      return;
    }

    await apply(deployed);

    // Representative of what production actually holds AT THE DEPLOYED
    // CHECKPOINT — which is the part that has to move when `DEPLOYED_THROUGH`
    // does, and did not. The barcode was still written in its pre-0005 shape
    // (`catalog_item_id`, `product_name`, `brand`), so the fixture described a
    // database 0005 had already restructured away. Rewritten here as what a
    // household at 0005 genuinely has: a product carrying the name, brand and
    // mapping, and a barcode pointing at it.
    //
    // The rows are still chosen for what they prove across the gap: the vara and
    // its clocks (0006 adds a fifth), the barcode → product → vara chain, a
    // purchase, and an entry with a contribution.
    //
    // The vara's four field clocks are named explicitly, and they have to be:
    // 0003 tightened all four `*_updated_by` columns to NOT NULL and gave a
    // DEFAULT to only the `*_updated_at` half, so a row inserted at the 0005
    // checkpoint without them is rejected. The fixture predates that and went
    // unnoticed because this test skips itself whenever nothing is pending —
    // which was every run between 0005 shipping and 0006 landing. They are set
    // to a time and an actor of their own rather than borrowed from the row
    // clock, so a backfill that silently reaches for `now()` instead is
    // detectable below.
    await scratch.unsafe(`
      INSERT INTO categories (id, name, icon, position)
        VALUES ('mejeri', 'Mejeri', '1F95B', 1);
      INSERT INTO catalog_items (
        id, name, name_norm, category_id, icon_ref, is_custom,
        name_updated_at, name_updated_by,
        category_updated_at, category_updated_by,
        icon_updated_at, icon_updated_by,
        home_updated_at, home_updated_by,
        updated_at, updated_by)
        VALUES ('mjolk', 'Mjölk', 'mjolk', 'mejeri', '1F95B', false,
          '2026-01-02T10:00:00Z', 'anders',
          '2026-01-02T10:00:00Z', 'anders',
          '2026-01-02T10:00:00Z', 'anders',
          '2026-01-02T10:00:00Z', 'anders',
          '2026-01-02T10:00:00Z', 'anders');
      INSERT INTO lists (id, name, icon, position, category_order, updated_by)
        VALUES ('hemkop', 'Hemköp', '1F6D2', 0, '[]'::jsonb, 'anders');
      INSERT INTO list_entries (id, list_id, catalog_item_id, created_by, updated_by)
        VALUES ('hemkop:mjolk', 'hemkop', 'mjolk', 'anders', 'anders');
      INSERT INTO contributions (id, entry_id, source_kind, recipe_addition_id, amount_value, amount_unit, note, updated_by)
        VALUES ('hemkop:mjolk#manual', 'hemkop:mjolk', 'manual', NULL, 2, 'l', 'helst ekologisk', 'anders');
      INSERT INTO purchases (id, catalog_item_id, list_id, actor, client_op_id)
        VALUES ('p1', 'mjolk', 'hemkop', 'anders', 'op-1');
      INSERT INTO products (id, name, brand, catalog_item_id, created_by, updated_by, item_updated_at, item_updated_by)
        VALUES ('prod:7310865004703', 'Arla Standardmjölk 1,5 l', 'Arla', 'mjolk', 'anders', 'anders', '2026-01-02T10:00:00Z', 'anders');
      INSERT INTO barcodes (ean, product_id, source, created_by, updated_by)
        VALUES ('7310865004703', 'prod:7310865004703', 'off', 'anders', 'anders');
    `).simple();

    await apply(pending);

    // The barcode chain, asserted whatever the pending migrations are. Nothing
    // since 0005 touches these tables, so this now guards against a future
    // migration quietly breaking the ean → product → vara path rather than
    // proving 0005's promotion — losing it means every barcode the household has
    // ever confirmed has to be re-answered in a shop.
    const [barcode] = await scratch`
      SELECT b.ean, p.name, p.brand, p.catalog_item_id
      FROM barcodes b JOIN products p ON p.id = b.product_id
      WHERE b.ean = '7310865004703'
    `;
    expect(barcode).toBeDefined();
    expect(barcode.name).toBe("Arla Standardmjölk 1,5 l");
    expect(barcode.brand).toBe("Arla");
    expect(barcode.catalog_item_id).toBe("mjolk");

    // Purchase history is the only thing here that cannot be reconstructed, and
    // 0005 rewrites the column it hangs on.
    const [purchase] = await scratch`
      SELECT catalog_item_id, product_id FROM purchases WHERE id = 'p1'
    `;
    expect(purchase.catalog_item_id).toBe("mjolk");
    expect(purchase.product_id).toBeNull();

    // The backfills in 0003/0004 had rows to work on, so the tightened NOT NULL
    // columns must be populated rather than defaulted to whenever this ran.
    const [contribution] = await scratch`
      SELECT amount_value, note, modifier, amount_updated_by
      FROM contributions WHERE id = 'hemkop:mjolk#manual'
    `;
    expect(contribution.amount_value).toBe(2);
    expect(contribution.note).toBe("helst ekologisk");
    expect(contribution.modifier).toBeNull();

    const [entry] = await scratch`
      SELECT priority FROM list_entries WHERE id = 'hemkop:mjolk'
    `;
    expect(entry.priority).toBe("normal");

    // 0006's backfill, and the reason it is hand-written.
    //
    // `hidden` false is the easy half — nothing could have hidden a vara before
    // the column existed. The clock is the half worth a test: a generated
    // migration would have defaulted it to `now()`, which would stamp every vara
    // in the catalog with the deploy's timestamp and make a genuine "dölj den
    // här" from a phone that was offline yesterday LOSE to a fact nobody ever
    // asserted. It has to carry the row's own clock instead, actor included.
    const [vara] = await scratch`
      SELECT hidden, hidden_updated_at, hidden_updated_by
      FROM catalog_items WHERE id = 'mjolk'
    `;
    expect(vara.hidden).toBe(false);
    expect(vara.hidden_updated_by).toBe("anders");
    expect(new Date(vara.hidden_updated_at).toISOString()).toBe(
      "2026-01-02T10:00:00.000Z",
    );
  }, 60_000);

  /**
   * 0005 claims in its own header to be safe to run twice, and it is the only
   * migration here that has to be: the drizzle-generated ones are tracked by
   * hash in `drizzle.__drizzle_migrations` and never re-applied, but 0005 is
   * hand-written, and hand-written SQL is what someone reaches for on a repair
   * path — a restored dump with a stale journal, a half-applied deploy.
   *
   * So this holds it to its own claim, and only its own: re-running it must
   * promote nothing twice. Deliberately not asserted for 0002-0004, which are
   * generated, are NOT re-runnable (a plain `ADD COLUMN` throws the second
   * time), and do not need to be.
   */
  it("re-applies 0005 without duplicating anything", async () => {
    // Depends on the fixture the test above builds, which it only builds while
    // there is a pending upgrade to replay.
    if (migrationFiles().every((f) => f <= `${DEPLOYED_THROUGH}_zzzz.sql`)) return;
    await apply(migrationFiles().filter((f) => f.startsWith("0005")));

    const [{ count }] = await scratch`SELECT count(*)::int FROM products`;
    expect(count).toBe(1);
    const [{ count: barcodeCount }] = await scratch`SELECT count(*)::int FROM barcodes`;
    expect(barcodeCount).toBe(1);
    // And the promotion did not overwrite the first product with a second copy
    // of itself under a different id.
    const [product] = await scratch`SELECT catalog_item_id FROM products`;
    expect(product.catalog_item_id).toBe("mjolk");
  }, 60_000);
});
