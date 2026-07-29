# Decisions & gotchas — autonomous build session, 2026-07-29

Read this first. Everything below happened while you were away.

**Where it stands:** the app runs and the core loop works, verified in a browser
and in the database. 227 tests pass, `pnpm tsc --noEmit` is clean, `pnpm build`
succeeds. Dev server is on **port 3100** (3000 was taken by Travkollen).

---

## What works end to end

- Tap a catalog tile → it joins "Att handla". Tap it again → it leaves, a
  purchase is recorded, and the catalog re-orders to float it up. Confirmed in
  Postgres, not just on screen.
- Type-ahead search with å/ä/ö folding, inline quantities (`mjölk 2 l`), and
  inline creation of new items.
- Barcode lookup against the real Open Food Facts API — tested with a live
  Swedish EAN and it came back with the product and image.
- Recipe URL import via schema.org JSON-LD, with an LLM fallback.
- Contribution merging: two recipes wanting cream show one tile reading the
  merged total, with a breakdown sheet that explains it.
- Cadence engine, seeded catalog (336 Swedish items, 19 aisle-ordered
  categories), PWA manifest and offline-first service worker.

## What is NOT done

Be clear-eyed about this — the list is real:

- **Offline storage.** The service worker caches the app shell, but list state
  is in memory, not IndexedDB. Close the tab and local state is gone; a reload
  re-fetches from the server. **The app does not yet work in a shop with no
  signal**, which was the headline requirement.
- **Live sharing.** No SSE stream yet. Two phones will not see each other's
  changes until a reload.
- **Recipe UI.** The import and scaling logic is built and tested; the pages to
  reach it from the app are not.
- **The ingredient parser** (`src/lib/ingredients/`) is specified and empty, so
  recipe lines are not yet matched to catalog items.
- **Multiple lists.** The data model and reducer support them fully; the
  switcher is a stub that shows a toast.
- **Playwright e2e**, and deploy.

The subagents were slower than my polling assumed rather than idle. Units,
cadence, barcode, seed data and recipe import all landed and are in use. The
API and client-store agents are still writing (`src/api/schemas.ts`,
`src/lib/client/db.ts`, `outbox.ts`, `store.ts` exist but are incomplete), so
their work is not yet wired in. Only the ingredient parser is genuinely empty.

The sync reducer was built twice — theirs and mine, concurrently, which is my
scheduling mistake, not theirs. The merged result is mine plus **their fix to a
real bug in it**: `writeEntry` never marked its meta row `deleted`, so
`pruneTombstones` kept the meta row of every tombstoned entry forever. The one
map pruning exists to bound grew without bound. Fixed, with a regression test.

---

## Decisions I made without asking

**1. List entry ids are derived, not generated.** `entryId(listId, itemId)`
rather than a UUID. Two phones offline in different shops both adding milk
cannot coordinate on a random id, so deriving it makes those two adds literally
the same operation and the reducer converges with no special case.

**2. The same reducer runs on the client and the server.** The server loads a
bounded slice of state, runs `applyOp`, and writes back the difference, rather
than reimplementing op semantics in SQL. The SQL version would be faster to
write and would eventually disagree with the client somewhere nobody tests.

**3. Removal is a tombstone.** A hard delete would let a stale `add_item` from a
phone that was offline silently resurrect something you already bought.

**4. "Bought" and "changed my mind" are different removals.** Tapping an item
off logs a purchase; the long-press "ta bort — köpte inte" does not. Without
that split the cadence engine slowly learns nonsense.

**5. Recipe totals stay in the unit the recipe used.** The general display
ladder renders 8 dl + 3 dl as `1,1 l` — correct, and useless in front of the
dairy cabinet when the recipe says dl. Mixed units still fall back to the
ladder, where `2,5 l` is the natural reading anyway.

**6. Icons are emoji codepoints, with OpenMoji as an enhancement.**
`pnpm icons:build` fetches a sprite; without it every tile renders the system
emoji for the same codepoint. A fresh clone works with no network, and the
build never depends on a volunteer-run CDN.

**7. The service worker is offline-FIRST, inverting longhaul's posture** — and
it refuses to cache a non-HTML navigation response, so one expired Authelia
session cannot poison every cold start with a cached login page.

**8. Anthropic model pinned to `claude-opus-5`**, structured output via
`messages.parse()` with a zod schema. I did not wire refusal fallbacks: a recipe
parser will not trip safety classifiers, and adding them would push the call off
the validated-parse helper. Say the word if you want them anyway.

**9. UPC-A barcodes are zero-padded to 13** so one product cannot occupy two
rows in the barcode map.

**10. Recipe servings ranges take the lower bound** ("4–6 portioner" → 4).
Scaling up from too little beats buying for six when you needed four.

---

## Two bugs worth knowing about

The first two were found by exhaustively testing all 720 orderings of a six-op
set, and neither would have shown up under hand-picked orderings. The third was
found by the sync agent reviewing my code:

**`createdAt` depended on arrival order.** A losing op returns early and never
lowers it, so `add_item@T1` then `add_recipe@T2` kept T1 while the reverse kept
T2. Creation is now tracked as a minimum, applied whether or not the op wins.

**`amount` and `note` shared one last-write-wins clock.** An older `set_amount`
arriving after a newer `set_note` lost the comparison and took the quantity with
it — you set 5 dl, your partner adds a note, the 5 dl silently becomes nothing.
That is *the* failure this app exists to prevent, arriving through the sync layer
instead of the recipe layer. Manual contributions now carry a clock per field.

**Tombstoned entries leaked their meta rows.** `writeEntry` wrote its
last-write-wins bookkeeping without the `deleted` marker even when tombstoning,
so `pruneTombstones` — whose whole job is bounding that map — skipped every one
of them. Found by the sync agent reading my code, not by a test.

---

## Open questions for you

- **Authelia session TTL** must be long (weeks, "remember me") before this is
  usable in a shop. Code cannot fix it.
- **Which gap first?** My order would be: IndexedDB store (it is the headline
  requirement), then the ingredient parser (it unblocks recipes), then SSE.
- **Custom illustrations** for the top ~100 items remain the obvious visual
  upgrade; the data model is ready and it is pure asset work.

## Gotchas

- `git_agent` reported LOCKED, so commits are unsigned. **Nothing is pushed** —
  seven commits sit on the local `master`, per the away-mode contract.
- Dev Postgres is on **5434**; dev server on **3100**.
- I left a dev server running. `lsof -nP -iTCP:3100 -sTCP:LISTEN` to find it.
