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

## Offline works, and is verified

The headline requirement is done and proven end to end, not inferred:

1. Loaded the app, killed the server outright (`kill -9` on the listener).
2. Reloaded — the app opened and showed the real list from IndexedDB: banan,
   grädde and ananas in *Att handla*, the full 341-item catalog by aisle.
3. Tapped citron with the server still dead. It went on the list, persisted,
   and queued in the outbox.
4. Brought the server back. The outbox drained on its own and `hemkop:citron`
   landed in Postgres.

Two real bugs had to be fixed to get there, and both would have shipped silently:

**The service worker was never registered.** `public/sw.js` existed, the
manifest referenced it, and nothing ever called
`navigator.serviceWorker.register`. The offline shell had never once been
active. It is invisible until the single moment it matters, which is exactly
how it survived this long unnoticed.

**The cached shell was an auth-gated server render.** Registering the worker
exposed it: in production the server cannot authenticate without the proxy, so
it rendered "Inte inloggad" — and *that* got cached and served forever. An app
that caches its own auth failure has not solved offline, it has broken it
permanently. The page now always renders the client shell; being signed out is
a banner over a working list, never a different page. A small shell context
(list name, category names) is stashed in localStorage on each successful load
so the offline render has chrome to work with.

## What is NOT done

Be clear-eyed about this — the list is real:

- **Recipe UI.** Import, parsing, matching and scaling are all built and tested,
  and `POST /api/recipes/import` works. The pages to reach any of it from the
  app are not built, so recipes are currently API-only.
- **Multiple lists.** The data model, reducer and API support them fully; the
  switcher in the UI is a stub that shows a toast.
- **Playwright e2e**, and deploy.

Since built and working: the full Hono API at `/api` (lists, snapshot, ops,
SSE stream, recipe import, barcode), the ingredient parser and catalog matcher
(97 tests), and server-side op application with real test coverage.

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

**The per-field clocks did not survive the database.** I fixed `amount` and
`note` to carry independent clocks in the reducer, then persisted both through a
single `updated_at` column. So they collapsed on write and came back identical
on read, and the server could reconstruct a state the client never had — the two
devices then disagreeing about a quantity, which is the whole thing this app
exists to prevent. Fixing it in memory but not on disk meant it was not really
fixed. `contributions` now carries `amount_updated_at`/`_by` and
`note_updated_at`/`_by` (migration `drizzle/0001`), nullable, falling back to the
row-level clock for recipe and scan contributions, which are written whole by a
single op. Flagged by the API agent.

**A stale `remove_item` could write a purchase it never caused.** The purchase
write checked whether the entry was on the list *before* the op, not whether the
op actually won the last-write-wins comparison — so a losing op still recorded a
purchase and bumped the catalog ordering, corrupting the cadence engine's only
input. Also flagged by the API agent.

**The idempotency check sat outside its transaction.** `applyOpToDatabase` read
`ops` for an existing `clientOpId` and then opened a transaction, so two truly
concurrent submissions of the same op could both read "not seen" and both apply.
Found and fixed by the API agent.

**Recipes named ingredients the catalog didn't have.** `grädde`, `mjöl`, `lök`,
`olja` and `köttfärs` existed only as compounds (`vispgrädde`, `vetemjöl`,
`gul lök`), so the terms Swedish recipes actually use matched nothing and every
recipe imported its commonest ingredients as NY VARA. Fixed in data rather than
in the matcher: matching a generic to a specific compound would put something
more precise on the list than the recipe asked for, and the natural tie-break
picks `rågmjöl` for "mjöl" when a Swedish recipe means vetemjöl every time.
Against 24 realistic weeknight recipe lines, matching went 9/24 → 23/24.

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
- **Deploy note, learned the hard way:** `output: "standalone"` breaks
  `next start`'s static serving, and the standalone server must be run *from
  its own directory* with `.next/static` and `public/` copied in. Without that
  it serves HTML and 404s every asset — including sw.js, so offline silently
  does not work. The Dockerfile has to do those copies.
- I left a dev server running. `lsof -nP -iTCP:3100 -sTCP:LISTEN` to find it.
