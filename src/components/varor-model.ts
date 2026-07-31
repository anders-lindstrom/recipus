import {
  entryId,
  type CatalogItem,
  type CatalogItemAlias,
  type Id,
  type ListEntry,
  type Product,
  type SyncState,
} from "@/lib/domain";
import { buildEntryView } from "@/lib/services/entries";
import type { Op } from "@/lib/sync";
import { normalizeName } from "@/lib/utils";

/**
 * What the registry screen reads out of sync state.
 *
 * Pure on purpose, and separated from the components for the same reason
 * `lib/services/entries.ts` is: the interesting questions here — which products
 * hang off which word, what stops a vara being deleted, whether a merged-away
 * word still finds its survivor — are far easier to pin down in a test than in a
 * browser, and the last two are exactly the ones that quietly stop working.
 *
 * Everything is derived from `SyncState` and nothing else. That is what makes
 * `/varor` work in a shop with no signal without a single new endpoint: the
 * registry rides the op log, so the client already has all of it.
 */

/**
 * One of the household's words, with everything hanging off it.
 *
 * The three collections are the three reasons a vara is not just a name. The
 * products are what the household actually met on a shelf; the entries are
 * today's shopping, which is the thing a taxonomy screen must never reach into
 * by surprise; the aliases are the residue of past merges, and the only visible
 * proof that an old recipe line still resolves.
 */
export interface VaraView {
  item: CatalogItem;
  /** Products placed on this vara. Newest first — a scan is usually why you are here. */
  products: Product[];
  /** LIVE entries pointing at it. Empty for almost every vara, almost always. */
  onList: ListEntry[];
  /** Extra words that reach it, chiefly what past merges left behind. */
  aliases: CatalogItemAlias[];
}

/** Newest first, because the reason you are looking is usually the last scan. */
function byNewest(a: Product, b: Product): number {
  return (
    b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name, "sv")
  );
}

/**
 * Every vara the household has, with its products, entries and aliases attached.
 *
 * One bucketing pass per collection rather than a filter per vara: the catalog is
 * ~340 rows and the products will not stay small, and a nested scan here would be
 * re-run on every keystroke of the search field.
 *
 * Alphabetical within the result, unlike the list screen's catalog, which is
 * ordered by use. This is a screen you look something up in rather than one you
 * shop from, and "where did mjölk go" has no answer under a frequency ordering.
 */
export function buildRegistry(state: SyncState): VaraView[] {
  const products = new Map<Id, Product[]>();
  for (const product of Object.values(state.products)) {
    if (product.catalogItemId === null) continue;
    const bucket = products.get(product.catalogItemId);
    if (bucket) bucket.push(product);
    else products.set(product.catalogItemId, [product]);
  }

  const entries = new Map<Id, ListEntry[]>();
  for (const entry of Object.values(state.entries)) {
    // Tombstones are not "on the list" — an item bought last week must not stop
    // its vara being renamed or deleted forever after.
    if (entry.removedAt !== null) continue;
    const bucket = entries.get(entry.catalogItemId);
    if (bucket) bucket.push(entry);
    else entries.set(entry.catalogItemId, [entry]);
  }

  const aliases = new Map<Id, CatalogItemAlias[]>();
  for (const alias of Object.values(state.aliases)) {
    const bucket = aliases.get(alias.catalogItemId);
    if (bucket) bucket.push(alias);
    else aliases.set(alias.catalogItemId, [alias]);
  }

  return Object.values(state.catalog)
    .map((item) => ({
      item,
      products: (products.get(item.id) ?? []).slice().sort(byNewest),
      onList: entries.get(item.id) ?? [],
      aliases: (aliases.get(item.id) ?? [])
        .slice()
        .sort((a, b) => a.aliasNorm.localeCompare(b.aliasNorm, "sv")),
    }))
    .sort((a, b) => a.item.name.localeCompare(b.item.name, "sv"));
}

/**
 * The review queue: products nobody has placed on a vara yet.
 *
 * This is the screen's reason to exist rather than tidying. A purchase made by
 * scanning points at the PRODUCT, and the vara it counts for is resolved through
 * the product's mapping — so until a human places one, every purchase of it is
 * invisible to cadence and to statistics. Deferred, not lost, but only if
 * somebody is told about it, which is why the count is advertised rather than
 * tucked away.
 */
export function unplacedProducts(state: SyncState): Product[] {
  return Object.values(state.products)
    .filter((p) => p.catalogItemId === null)
    .sort(byNewest);
}

/**
 * Why a vara cannot be deleted yet.
 *
 * Both blockers exist to stop one specific surprise: a taxonomy screen reaching
 * into today's shopping, or silently orphaning products whose purchase history
 * then points at a word that no longer exists. Neither is a hard error — each has
 * an inline fix — but doing them behind the user's back is what erodes trust in a
 * screen whose whole job is to be edited.
 */
export type DeletionBlocker =
  | { kind: "on_list"; entries: ListEntry[] }
  | { kind: "has_products"; products: Product[] };

export function deletionBlockers(vara: VaraView): DeletionBlocker[] {
  const blockers: DeletionBlocker[] = [];
  if (vara.onList.length > 0) {
    blockers.push({ kind: "on_list", entries: vara.onList });
  }
  if (vara.products.length > 0) {
    blockers.push({ kind: "has_products", products: vara.products });
  }
  return blockers;
}

/**
 * Filter the registry by what someone typed.
 *
 * Matching aliases is not a nicety — it is the only place a merge's promise is
 * visible. Merging `köttfärs` into `nötfärs` keeps the first word working
 * everywhere; if searching this screen for it came back empty, the household
 * would reasonably conclude the word was gone and re-create it, which is exactly
 * the duplicate the merge existed to remove.
 *
 * Order is preserved rather than re-ranked. `rankMatches` earns its scoring on
 * the add bar, where six suggestions have to be the right six; here every match
 * is shown and alphabetical is what a lookup screen should stay.
 */
export function filterVaror(varor: VaraView[], query: string): VaraView[] {
  const q = normalizeName(query);
  if (!q) return varor;
  return varor.filter(
    (v) =>
      v.item.nameNorm.includes(q) ||
      v.aliases.some((a) => a.aliasNorm.includes(q)),
  );
}

/**
 * Products whose name or brand matches, for the queue's own filter.
 *
 * Brand is searched as well as name because Open Food Facts frequently puts the
 * distinguishing word there — "Standardmjölk" tells you nothing among fourteen
 * of them, "Arla" does.
 */
export function filterProducts(products: Product[], query: string): Product[] {
  const q = normalizeName(query);
  if (!q) return products;
  return products.filter(
    (p) =>
      normalizeName(p.name).includes(q) ||
      (p.brand !== null && normalizeName(p.brand).includes(q)),
  );
}

/**
 * A product's one-line subtitle: brand, then what the pack said.
 *
 * `sourceSizeText` is preferred over the parsed `defaultSize` deliberately. The
 * parser turns "6 x 33 cl" into `{6, "st"}` — six of something is not wrong, but
 * it is not 198 cl either, and the verbatim string is the one a person can check
 * against the thing in their hand.
 */
export function productSubtitle(product: Product): string {
  const size =
    product.sourceSizeText ??
    (product.defaultSize
      ? `${product.defaultSize.value} ${product.defaultSize.unit}`
      : null);
  return [product.brand, size].filter(Boolean).join(" · ");
}

/**
 * An op minus the envelope the dispatching component fills in.
 *
 * Distributed over the union deliberately: a plain `Omit<Op, ...>` collapses the
 * variants into one intersection whose only shared keys are the envelope's, and
 * `listId` and friends stop existing.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
export type OpDraft = DistributiveOmit<Op, "clientOpId" | "actor" | "at">;

/**
 * Everything a merge has to say, in order.
 *
 * `merge_catalog_items` itself does exactly two things — tombstone the losing
 * word, record it as an alias of the survivor — and it must never do more. A
 * merge implemented as row rewriting does not converge: `merge(B→A)` at T5
 * followed by a long-offline `add_item(B)` at T7 ends with an entry for B in one
 * arrival order and for A in the other, and neither device is wrong by its own
 * reckoning. So everything that HANGS OFF the word is re-pointed around it
 * instead — products here, and purchases / recipe ingredients / aliases by a
 * server-side effect (`repointMergedCatalogItem`).
 *
 * Today's shopping is re-pointed here too, and that is the part that was missing.
 * Its absence was the production bug, and a quiet one:
 *
 * The reducer left the loser's entry alone — correct — but the list screen could
 * only draw an entry whose vara it could look up, and the merge had just removed
 * that row from the catalog. The entry therefore neither stayed nor went: it
 * became a live row nothing could render and no gesture could reach, still
 * holding its contributions, and beyond pruning too (that collects by
 * `removedAt`, and an orphan has none). Merging vitlöksklyfta into vitlök made
 * the vitlöksklyfta you actually needed silently vanish off the list.
 *
 * Re-adding the recipe then compounded it. The server re-points
 * `recipe_ingredients` to the survivor, so the second add resolved to vitlök and
 * built a SECOND entry beside the invisible one — the "it adds a new line of the
 * other one, and they go double" in the report.
 *
 * Only existing op kinds are used, so convergence is untouched and a phone on an
 * older build understands every one of them. What travels is what the tile was
 * SHOWING — its merged total, its sort, its urgency. What does not travel is
 * provenance: the amount arrives as a manual one, so "Behövs till: Vitlöksstekt
 * kyckling" is not preserved. That is the trade `move_item` already makes, and
 * for the same reason — a contribution is keyed to a recipe addition, and
 * rehoming one would take a recipe's own bookkeeping with it.
 *
 * Pure and ordered rather than dispatched inline so the whole plan can be
 * asserted in a test, which is the only way the interesting cases here — the
 * survivor already on the list, two unit families, a second list — get checked
 * at all.
 */
export function mergeVaraOps(
  state: SyncState,
  listId: Id,
  fromId: Id,
  toId: Id,
  productIds: Id[],
): OpDraft[] {
  const from = state.catalog[fromId];
  if (!from || fromId === toId) return [];

  const ops: OpDraft[] = productIds.map((productId) => ({
    kind: "update_product",
    productId,
    patch: { catalogItemId: toId },
  }));

  const contributions = Object.values(state.contributions);
  for (const entry of Object.values(state.entries)) {
    if (entry.catalogItemId !== fromId || entry.removedAt !== null) continue;
    // THIS list only, and the restriction is deliberate rather than a shortcut.
    //
    // The store holds one list: the snapshot selects `list_entries` by
    // `list_id`, the catch-up query filters ops the same way, and
    // `applySnapshot` rebuilds from `emptyState()`. So iterating every entry
    // reads as "every list" and is really "the open one" — with one exception,
    // and the exception is why this filter exists rather than being implied.
    //
    // `move_item` is delivered household-wide on purpose (`opListId` returns
    // null so the SOURCE device hears about it), and the reducer writes the
    // destination entry into every listening store. A client on Hemköp therefore
    // holds a live entry belonging to Ica which nothing on Ica's stream will ever
    // update. Merging without this filter emitted `add_item` and `set_amount`
    // against that stale row: an item a partner had already bought reappeared on
    // their list, with a quantity, for no reason visible to them.
    //
    // What this cannot do is re-point the OTHER list's shopping — that entry is
    // not here to move. It keeps the orphan the reducer always allowed, which
    // `tileVaror` now draws as a stand-in, so it is visible and one tap clears
    // it. Stated in DECISIONS.md as a known edge rather than implied by silence.
    if (entry.listId !== listId) continue;

    const standing = state.entries[entryId(entry.listId, toId)];
    // The survivor already has a tile on this list, and that tile wins.
    // Overwriting its amount with the loser's would silently change a number
    // somebody is looking at, and adding the two is not something `set_amount`
    // can say — it names an amount, it cannot ask for one more.
    if (!standing || standing.removedAt !== null) {
      ops.push({ kind: "add_item", listId: entry.listId, catalogItemId: toId });

      const view = buildEntryView(entry, contributions);
      // One total, or none at all. Two totals means two unit families — "2 dl"
      // and "3 st" — which no single amount can carry, and choosing one of them
      // would invent a quantity the household never wrote.
      if (view.totals.length === 1) {
        ops.push({
          kind: "set_amount",
          listId: entry.listId,
          catalogItemId: toId,
          amount: view.totals[0],
        });
      }
      if (view.modifier) {
        ops.push({
          kind: "set_modifier",
          listId: entry.listId,
          catalogItemId: toId,
          modifier: view.modifier,
        });
      }
      // Only when it says something. "normal" is what an entry is born with, and
      // stamping priority's clock anyway would let this merge outrank a genuine
      // "bråttom" set on another phone a moment earlier.
      if (entry.priority !== "normal") {
        ops.push({
          kind: "set_priority",
          listId: entry.listId,
          catalogItemId: toId,
          priority: entry.priority,
        });
      }
    }

    // `bought: false`, always — the rule `takeOffList` follows. Tidying your own
    // vocabulary is administration, not a shop, and recording it as a purchase
    // would teach the cadence engine that you buy this every time you merge two
    // words.
    ops.push({
      kind: "remove_item",
      listId: entry.listId,
      catalogItemId: fromId,
      bought: false,
    });
  }

  // Last: the word itself. The products and the shopping are moved off it before
  // it is tombstoned, exactly as the split moves its products first.
  ops.push({
    kind: "merge_catalog_items",
    fromItemId: fromId,
    toItemId: toId,
    aliasNorm: from.nameNorm,
  });

  return ops;
}

/**
 * Whether a proposed new vara name would collide with one that exists.
 *
 * Load-bearing rather than politeness: catalog ids are slugs of the name, so
 * "create" for a name already in use is a `create_catalog_item` for an existing
 * id — which last-write-wins resolves by OVERWRITING the vara that was there,
 * renaming someone else's word and re-filing it into this one's category. The
 * split sheet is the only place a name is invented, so this is the only place
 * that can catch it.
 */
export function collidingVara(
  catalog: Record<Id, CatalogItem>,
  proposedId: Id,
  proposedName: string,
): CatalogItem | null {
  const direct = catalog[proposedId];
  if (direct) return direct;
  const norm = normalizeName(proposedName);
  if (!norm) return null;
  return Object.values(catalog).find((c) => c.nameNorm === norm) ?? null;
}
