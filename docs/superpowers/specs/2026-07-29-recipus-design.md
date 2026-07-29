# Recipus — design

**Date:** 2026-07-29
**Status:** approved, in build

A mobile-first PWA that replaces Bring! for a household: a fast, shared,
offline-capable grocery list, with recipes as a source of ingredients, barcode
scanning, and purchase-cadence suggestions.

UI language is **Swedish**. Code, comments and docs are English.

---

## 1. What it is

The core loop is Bring's, and its speed is the product:

- Items are **tiles with pictures**, not rows of text.
- The screen has **two zones**: what you need to buy, and the catalog of
  everything you ever buy, grouped by aisle.
- **There are no checkboxes.** An item is on the list or it isn't. Tapping a
  tile in the top zone removes it and records a purchase; tapping one in the
  catalog adds it. One tap, no dialog, no confirm.
- **Type-ahead adds.** Three letters filters the catalog; unmatched text offers
  to create the item inline.
- The list is **shared live** with the household and **works offline** in a
  store with no signal.

Three modules sit on top of that foundation: recipes, barcode, cadence.

## 2. Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Sharing | Live-shared household list | The feature that makes Bring worth using |
| Auth | Behind NPM + Authelia, like longhaul | Reuses existing infra; no new auth surface |
| Multiple lists | Yes, one per store | Hemköp and Bauhaus have nothing in common but the vocabulary |
| Tile art | OpenMoji, referenced by codepoint | Free, consistent, offline, swappable later |
| Recipes | Ingredient source only, no cook mode | Keeps the project finishable |
| Recipe input | URL (JSON-LD) + LLM fallback + paste + manual | All four share one line parser |
| Barcode | Bidirectional: on list → tick off, else → add | No mode switch for the user |
| Suggestions | "Föreslås" row + recency/frequency catalog ordering | No push notifications — noise kills apps |
| Staples | `has_at_home` flag on catalog items, seeded | Right from day one, unlike learned behaviour |
| Top zone layout | Flat grid, auto-groups by aisle past 12 items | Short lists don't need aisles; long ones do |
| Sync | Op log + last-write-wins, over SSE | Shopping-list ops are naturally commutative |

## 3. Architecture

Stack mirrors longhaul: Next 16 App Router + TS, Hono + `@hono/zod-openapi` on
`/api`, Drizzle + Postgres, Tailwind 4, vitest, Playwright. Additions: `idb`,
OpenMoji, a lazily-loaded wasm barcode decoder.

### 3.1 Four pure engines

Each is a pure module with no database, network or DOM access, and each is the
unit of testing that matters:

```
src/lib/units/        parse "2 dl" / "1½ msk" / "500 g", convert, merge, format
src/lib/ingredients/  recipe line → {amount, unit, name} → matched catalog item
src/lib/cadence/      purchase history → median interval → overdue score
src/lib/sync/         op types + the reducer that applies them
```

**The sync reducer is shared code run on both sides.** The browser applies an op
optimistically with it; the server applies the same op with the same function.
One implementation, so client and server cannot drift.

### 3.2 Sync model

Every mutation is an **operation** with a client-generated `clientOpId`, an
actor and a payload. The client applies it locally and instantly, persists it to
IndexedDB, and queues it in an outbox. The server appends it to `ops`, assigns a
monotonic `seq`, applies it to the materialized tables, and fans it out over
SSE.

Conflicts resolve by **last-write-wins with a client-id tiebreak**. This is
sufficient because the operations are naturally commutative or idempotent:
adding an item twice is one item, removing an already-removed item is a no-op.
The only real conflict — "you removed milk while I was setting its amount" —
resolves in a way nobody notices.

On reconnect a client calls `GET /api/ops?since=<cursor>` to catch up **before**
attaching the SSE stream, so nothing falls through the gap between the two.

`ops` is a catch-up log, not the source of truth; materialized state lives in
the normal tables. Rows older than 30 days are pruned — a client staler than
that does a full resync.

### 3.3 Offline

The service worker precaches the app shell and the icon sprite. IndexedDB holds
lists, catalog, entries, contributions, recipes, barcodes and the outbox. The
app is fully usable with no network: every mutation applies locally and drains
later. The outbox flushes on reconnect and on visibility change; `clientOpId` is
unique so retries cannot double-apply.

**Authelia lapse handling is explicit.** Any API response that is a redirect or
401 flips the app into signed-out mode: a dismissible banner over a fully
working local list, with a button to re-authenticate. It must never be a
navigation that replaces the list with a login page — that is the failure mode
that makes an app useless at a checkout counter.

Deployment requirement, not fixable in code: **Authelia's session TTL must be
long** (weeks, with "remember me"), or the app will demand 2FA in the dairy
aisle.

## 4. Data model

```
users               authelia_user (pk), display_name, color
lists               id, name, icon, position, category_order
categories          id, name, icon, position                    -- global, seeded
catalog_items       id, name, name_norm, category_id, icon_ref,
                    is_custom, has_at_home, use_count, last_used_at
list_entries        id, list_id, catalog_item_id, created_at, created_by
                    UNIQUE (list_id, catalog_item_id)
contributions       id, entry_id, source_kind, recipe_addition_id?,
                    amount?, unit?, note?
recipes             id, title, source_url, servings, servings_unit, image_url
recipe_ingredients  id, recipe_id, position, raw_text, amount?, unit?,
                    catalog_item_id?                            -- null = unmatched
recipe_additions    id, list_id, recipe_id, scale_factor, added_at, added_by
purchases           id, catalog_item_id, list_id, purchased_at, actor
barcodes            ean (pk), catalog_item_id?, product_name, brand,
                    image_url, source
ops                 seq (bigserial), list_id, client_op_id (unique),
                    actor, kind, payload, created_at
```

Three invariants worth stating explicitly:

**`UNIQUE (list_id, catalog_item_id)`** is what keeps the list coherent. An item
appears at most once per list. Wanting it twice creates a second *contribution*,
never a second tile — so a muffin recipe and a pasta recipe both needing cream
produce one tile reading `11 dl`, not two tiles you walk past separately.

**A list entry never stores a bare number.** It stores contributions, each with
its own amount, unit and source. The displayed total is derived. This is what
makes "you need 8 dl, not 4 dl" reliable, and what lets a single recipe be
withdrawn from a list without disturbing anything else.

**`purchases` is written on removal, and only when removal means "bought".**
Tapping an item off the list logs a purchase. Long-press offers *ta bort — köpte
inte*, which does not. A change of mind must not teach the cadence engine a lie.

## 5. Modules

### 5.1 Units (`src/lib/units/`)

Parses, converts, merges and formats amounts. Families:

- **volume** — `krm` 1 ml, `tsk` 5 ml, `msk` 15 ml, `cl` 10 ml, `dl` 100 ml,
  `l` 1000 ml, `ml` 1 ml
- **mass** — `g` 1 g, `hg` 100 g, `kg` 1000 g
- **count** — `st`, `förp`, `burk`, `påse`, `knippe`, `pkt` (merge only when
  identical; no conversion between them)

Merging sums within a family via its base unit and renders back in the cleanest
unit (`800 ml → 8 dl`, `1200 ml → 1,2 l`). It **refuses to merge across
families** — `2 dl + 3 st` stays `2 dl + 3 st`. Converting dl of flour to grams
requires knowing the ingredient's density, so it is never attempted.

Swedish input must parse: decimal comma (`1,5 dl`), vulgar fractions (`½ msk`),
ASCII fractions (`1 1/2 dl`), ranges (`2-3 dl` → takes the upper bound), and a
bare number with no unit (→ `st`).

### 5.2 Ingredients (`src/lib/ingredients/`)

Turns a raw recipe line — `"2 dl vispgrädde"`, `"1 msk finhackad persilja"`,
`"salt och peppar"` — into `{ amount, unit, name, rawText }`, then fuzzy-matches
the name against the catalog. Matching is å/ä/ö- and case-insensitive, strips
preparation words (*finhackad*, *riven*, *färsk*, *ekologisk*), and handles
common Swedish compound forms (`vispgrädde` → `grädde`).

An unmatched ingredient does **not** block an import; it becomes a new catalog
item flagged `is_custom`, shown as **NY VARA** in the add sheet.

### 5.3 Cadence (`src/lib/cadence/`)

Pure: `(purchaseDates, now) → { medianIntervalDays, confidence, overdueScore }`.

- **Median**, not mean, so one party-sized purchase doesn't poison an item.
- Silent below **three** purchases; confidence 0.
- Confidence weighs interval *consistency* (median absolute deviation). Milk at
  4±1 days scores high; saffron at random intervals scores near zero and never
  appears.
- `overdueScore = daysSinceLast / medianIntervalDays`. Suggested at ≥ 0.85,
  sorted descending, capped at 8 tiles, excluding anything already on the list.
- Never auto-adds. Dismissal silences an item for the rest of the day.

Alongside it, and doing more of the perceived work: **catalog ordering by
recency and frequency** — use count decayed by time since last use. Needs no
history and makes the catalog feel personal after about three shops.

### 5.4 Sync (`src/lib/sync/`)

Op kinds: `add_item`, `remove_item`, `set_amount`, `set_note`, `add_recipe`,
`remove_recipe`, `move_item`, `create_list`, `rename_list`, `delete_list`,
`create_catalog_item`, `update_catalog_item`.

The reducer is `(state, op) → state`, total and deterministic. Applying the same
set of ops in any order must converge to the same state — this is the property
the tests assert.

### 5.5 Barcode

Scanner opens full-screen and scans continuously. `BarcodeDetector` when
available; a wasm decoder dynamic-imported only when it is not, so Android never
downloads it.

Resolution is cheapest-first: local EAN map in IndexedDB (instant, offline) →
server map → Open Food Facts → ask the user. Whatever the user answers is stored
permanently, so each unknown barcode costs once.

A scan acts on the **currently open list**: mapped item already on it → tick off
and log a purchase; not on it → add. The toast says which, and offers undo.
Unknown EANs scanned offline are queued, not dropped.

### 5.6 Recipes

Import by URL parses `schema.org/Recipe` JSON-LD server-side. Pages without it
fall back to an LLM extraction (Claude) when `ANTHROPIC_API_KEY` is set. Paste
and manual entry run through the same line parser.

Adding to a list opens a sheet with a **servings stepper**: the recipe's base
servings, your target, and every amount rescaled live with the original struck
through. Items flagged `has_at_home` start excluded, one tap to include.

On the list, a recipe-sourced tile shows the **merged total** and a 📖 badge.
Tapping it shows the breakdown by source and offers to withdraw one recipe.

## 6. Testing

- **vitest** over the four pure engines. The sync reducer additionally gets
  order-independence tests: shuffle the ops, assert identical final state.
- **Playwright** for the core loop, including two browser contexts editing one
  list to prove live sharing works, and an offline-mutate-then-reconnect case.

## 7. Build order

Five slices, each shippable:

1. **The list** — lists, categories, seeded catalog, tiles, add/remove, search
   and create, quantities, IndexedDB, outbox, ops, SSE. A working Bring
   replacement on its own.
2. **Recipes** — import, parser, matching, scaling, contributions, provenance UI.
3. **Barcode** — scanner, EAN map, Open Food Facts, learning loop.
4. **Cadence** — last on purpose: purchases log from slice 1, so there is real
   data to test against.
5. **PWA polish** — install, icons, splash, optional Android TWA.

Deploy (beelink, NPM host, Authelia flows) is explicitly a later step.

## 8. Out of scope

Cook mode, meal planning, recipe browsing/search as a first-class surface, push
notifications, pantry inventory, price tracking, store-specific product
catalogues, and any form of social/sharing beyond the household.
