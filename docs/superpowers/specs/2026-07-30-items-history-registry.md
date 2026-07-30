# Recipus — priority, modifiers, purchase history, item registry

**Date:** 2026-07-30
**Status:** specified; R1 and the undo fix built, rest queued
**Inputs:** four parallel design passes (modifiers/priority, purchase history & modes, item registry, sync-seam risk), adjudicated here.

This is the synthesis. Where the four passes disagreed I have decided, and said
why — those are marked **ADJUDICATED**. Where something needs Anders, it is in
§9 and nowhere else.

---

## 1. The three questions that shaped everything

**Is "ripe mango" a different amount, a different note, or a different thing?**
A different *thing*, if the household says so. That single answer removes the
need to touch entry identity at all, and it came out of Anders' own butter
observation: the logical layer is a household-owned taxonomy whose granularity
only the family can set. A butter-obsessed household splits salted from
unsalted; this one splits butter from margarine. So "two mangos on the list" is
not an identity problem to be solved with a variant key — it is the household
deciding mogen mango is its own vara, which already gets its own tile, amount,
cadence and tick-off for free.

**Is a modifier the same axis?** Yes, at a lower commitment. A modifier is a
scribble on one reason for buying ("grov", "osaltat"); promoting it to a vara is
the permanent form. They must never become rival mechanisms, which is why
promotion is a *shortcut into split* rather than its own machinery.

**Do we already separate bought from removed?** Yes, and it was already wired
and tested — `remove_item` carries `bought`, `bought: false` skips the purchase
write, and a removal that lost its LWW comparison writes nothing either. What
was missing was that undo never retracted the purchase (now fixed), and that
nothing surfaced recency.

---

## 2. Decisions taken

### 2.1 Entry identity: unchanged

`entryId(listId, catalogItemId)` stays byte for byte. `UNIQUE (list_id,
catalog_item_id)` stays. No variant key.

The variant key was assessed properly rather than waved off: it is safe at the
storage layer (an additive migration exists that provably cannot lose or
duplicate a row, because the default variant keeps the legacy 2-part id string)
but it **cannot roll out gradually**. An un-upgraded phone ignores the unknown
field, derives the default entry id, silently merges the two variant entries into
one tile, and then writes amounts to the wrong one. It also doubles `purchases`
rows for any item held in two variants, injecting a zero-day interval into the
cadence median every shop.

**ADJUDICATED:** the modifier pass initially proposed folding the modifier into
`manualContributionId` (a middle option) and reversed itself once the registry
context landed — a second identity axis is exactly what the taxonomy already
owns. Rejected too.

**Known scope reduction:** "2 kg ripe AND 1 plain, both mine, no recipe" is not
representable until mogen mango is promoted. The recipe-versus-me version of the
same wish works today with no promotion at all, because a recipe's ask and your
own ask are already two contributions. This is §9 item 1.

### 2.2 Priority: order plus ink, no new tile furniture

Three states, `urgent | normal | convenient`. Both tile corners are already
taken (recipe badge right, actor dot left) and decorative dots are banned, so
priority uses two channels the tile already has:

- **Order** — urgent first, convenient last, *within* existing grouping so aisle
  walking order survives. Free, because the zone currently renders arbitrary map
  order.
- **The item name's ink** — `text-warn font-bold` / unchanged / `text-ink-soft`.
  No new DOM, no layout shift.

Green is untouched, because this is ink on text that already exists rather than
colour on the tile. A visually-hidden suffix carries it to screen readers
("Mjölk, 2 l, bråttom").

`remove_item` clears priority. Without that, urgency becomes permanent
decoration — buy the urgent milk, re-add next week, still ochre, still first —
and once a third of the list is urgent, nothing is.

### 2.3 Modifiers: on the contribution, never in an id

`Contribution.modifier?: string | null`, its own op (`set_modifier`), its own
LWW clock. Not folded onto `set_amount`: a third independent fact on one record
needs a third independent clock, which is precisely the bug already recorded in
this log where an older `set_amount` arriving after a newer `set_note` took the
quantity down with it.

The confirm-on-duplicate sheet Anders asked for **is** still needed, and is now
load-bearing rather than a courtesy: per-field clocks mean typing "mango 1 st"
against an existing "2 kg mogna" silently yields "1 st **mogna**" — one plain
mango asked for, one ripe mango delivered. It fires only from the add bar, only
when the existing manual ask already carries a modifier. **A tile tap never
opens a dialog.**

### 2.4 Buy mode / plan mode: build it

Anders reaffirmed this after I argued against it, so it is his call and it is
being built. My objection was that a hidden global mode makes one tap mean two
things depending on invisible state; his answer — a persistent tint plus a
one-tap toggle — addresses it directly, and his long-press escape hatch makes
neither mode a trap.

| Gesture | PLAN | BUY |
|---|---|---|
| Tap listed tile | `remove_item{bought:false}` | `remove_item{bought:true}` |
| Tap catalog / suggestion tile | `add_item` | identical |
| Long-press listed tile | sheet offers **Markera som köpt** | sheet offers **Köpte inte** |
| Scan | bidirectional, tick-off writes **no** purchase | §2.6 |

**Exactly one gesture changes meaning between modes.** That bounds the whole
risk surface and means the mode reaches op construction in one line.

The asymmetry is the point: at home you are editing an intention, in the shop
you are recording an event. That is what turns purchase history from "mostly
true" into "true", and the statistics and fridge inference are both downstream of
it.

**Residual risk, and why it is acceptable:** forgetting to switch fails in the
*conservative* direction — fewer purchases recorded, no false ones, nothing wrong
taught to cadence. The dangerous direction now requires you to be looking at a
tinted screen. Recovered non-modally by a **`Handlar du?`** chip in the heading's
existing reserved-height action slot after three removals inside five minutes,
which offers to switch and retro-convert that session's removals.

### 2.5 Mode colour: terracotta, and plan mode is untinted

**ADJUDICATED, and my own instinct was wrong on the hue.** I proposed
plan-untinted + amber-buy over Anders' green/orange, because green means "on the
list" and orange is `--color-warn`. The history pass confirmed the structure and
then measured my amber: `#fae4d8` sits **ΔL\* 1.60** from `--color-warn-tint`,
which is the offline-banner ground. Terracotta separates by hue while keeping the
warm "act now" reading, and `#c8622e` is already in the codebase as a member
colour.

```
--color-mode-buy-wash: #fae4d8 → dark #4a2a14
--color-mode-buy-ink:  #9c4318 → dark #f0a06a
--color-mode-buy-line: #c8622e → dark #e08a4e
```

All pairs measured against AA. One rule for implementers: **never put dark-mode
`ink-faint` text on the wash** (3.70) — it is fine for the 16px chevron, which
needs 3.0, and the project already relies on this against `brand-tint`.

Carried by the whole sticky header block plus a 2px accent line. **Nothing below
it, and `ItemTile` never changes with mode** — that is what structurally prevents
any collision with green. Triple-encoded: wash + accent + a labelled
`Planerar`/`Handlar` pill, in the existing 48px header row.

**The pill must not change the header's height.** The aisle rail measures
`header.getBoundingClientRect()` at runtime to place its jump offsets and its
active-aisle detection line, so a mode-dependent header height would silently
shift where aisle jumps land.

Two collisions to fix with the wash: the sync banner is `bg-warn-tint` and
disappears against it (→ `surface-raised` card with a `warn` left accent), and
the aisle rail's right-edge fade is hardcoded `from-surface` and would smear
across the tint (→ drive it from a `--mode-wash` variable on `<header>`).

### 2.6 Mode storage and lifecycle

**ADJUDICATED:** `sessionStorage`, not my `localStorage`. It makes "plan is the
default on open" a property of the storage rather than logic that can be
forgotten — and if that logic is forgotten the failure is silent and lands on
false purchases. It survives in-app navigation and reloads within the session,
which is what matters mid-shop.

Never synced, never an op, never in `SyncState` (`applySnapshot` rebuilds state
wholesale, so anything stuffed in there is wiped on every hydration). One person
shops while the other plans; a synced mode would make the planner's taps write
purchases over SSE.

Reverts to plan after **90 minutes with no removals** in buy mode — iOS keeps a
backgrounded PWA session alive far too long for "the tab closed" to mean
end-of-shop, and three days in buy mode turns every at-home "we don't need this"
into a false purchase. **Never auto-enters buy mode.**

**The invariant to hold:** the mode may select *which* op the UI emits; it must
never be needed to *interpret* one. The moment a receiving device would need to
know the sender's mode, the mode belongs in the payload and this decision is
wrong.

### 2.7 Buy-mode scanning

**Recommendation: act instantly, confirm in the scanner's existing `aria-live`
result line with undo** — `Banan tillagd och köpt · Ångra`. Anders asked for an
ask; a modal per scan turns one continuous session into fifteen dialogs, and the
scanner is explicitly a continuous session with a 2.5s per-code dedupe built so
you can work through a bag.

If he wants the ask kept, the non-blocking form is a row per scan under the
viewfinder (`Köpt` / `Bara på listan`) **defaulting to `Köpt` after 6 seconds**.
Either is fine to build. A blocking modal is not. §9 item 2.

### 2.8 Fridge inference: per-item cadence, not a flat week

```
probablyStillHave  iff  lastPurchasedAt !== null
                   and  medianIntervalDays !== null      (⇒ ≥3 purchases)
                   and  confidence >= 0.5                (stricter than suggestions' 0.3)
                   and  daysSinceLast <= 0.5 * medianIntervalDays
                   and  isCondimentScale(amount)
```

Per-item cadence is what separates yoghurt (median 7d, excluded only within ~3
days) from soy sauce (median 300d, safely excluded at three weeks). A flat week
gets both wrong in opposite directions.

`isCondimentScale` — null amount, or ≤1 dl / ≤100 g / ≤2 st after scaling —
replaces a perishability taxonomy we do not have. No quantity is recorded per
purchase, so "bought grädde 2 days ago" cannot tell one carton from three; the
recipe's own demand is the one quantity we *do* know. It captures the real win
(spices, oils, vinegar, soy) and refuses the dangerous one (5 dl grädde, 500 g
köttfärs).

Pre-excluded **with a reason badge** (`Köpt i går`) rather than silently, reusing
the existing staple mechanic, plus a **`Lägg till allt ändå`** escape beside the
counter. Thresholds are reasoned from cost asymmetry, not fitted — there is no
purchase history to calibrate against yet. Expect to tune them.

**Hard prerequisite, now met:** undo had to retract the purchase first, or the
inference could exclude an ingredient on the strength of a purchase the user had
already corrected. Built and committed.

### 2.9 Registry: two levels, products first-class

`barcodes` is demoted to an EAN→product pointer; **products become a table**.
Three reasons from the current schema: `ean` is the primary key so one product
with two EANs duplicates its name/brand/size/mapping and "default size" gets two
homes that will drift; a barcode-less product (loose vegetables, cheese counter)
cannot exist at all; and the two levels are mixed — "400 g" vs "600 g" are two
products, a Swedish and a Norwegian barcode for the same pack are two barcodes of
one product.

Rejected: one table with `eans: string[]`. LWW on an array silently drops one of
two concurrently-added EANs and `wins()` cannot merge them. A row per EAN means
two phones adding two different EANs **do not conflict at all**.

Aliases get the identical shape (`catalog_item_aliases.alias_norm → item`). One
pattern implemented twice, deliberately.

Scan-born product ids are **derived** — `prod:${ean}` — for exactly the reason
`entryId` is: two offline phones scanning the same unknown EAN must converge on
one product, not two silent duplicates. Which means `createdAt`/`createdBy` must
be earliest-wins, reusing `earliestCreation`, not LWW.

`defaultSize` reuses `Amount` and `parseAmount`. `sourceSizeText` keeps OFF's
verbatim string for provenance, because `parseAmount("6 x 33 cl")` returns
`{6,"st"}` — verified by execution, and the reason that field exists.

**Sync placement — ADJUDICATED.** The two passes split: the sync pass argued for
server CRUD (registry curation is an online, sit-down activity), the registry
pass argued for the op log. **The op log wins**, on one fact that decides it:
unknown EANs are created *in a shop, offline*, the design doc already promises
they are queued rather than dropped, and today they are dropped — `handleScan` is
a bare `fetch`. With buy mode a dropped scan becomes a **lost purchase**. Only
the outbox fixes that. Two bonuses: `/varor` renders from the store and works
offline with no new endpoint, and the "local EAN map" the design promised (and
which does not exist) becomes the state blob for free.

### 2.10 Split, merge, delete

Four verbs kept semantically distinct so they cannot become rivals: rename
(existing `update_catalog_item`), **Dela upp**, **Slå samman**, **Ta bort**.

- **Split is pure UI over existing ops.** Create the new vara, then the human
  ticks which products move (N × `update_product`). That checkbox list *is* the
  split — only they know which of fourteen products are unsalted. The source vara
  stays.
- **Merge** is a batch of ordinary ops plus one `merge_catalog_items` whose
  reducer case **only tombstones** `from`.

**ADJUDICATED — the convergence objection is answered by that last clause.** The
sync pass showed that a merge implemented as *row rewriting in the reducer*
diverges: `merge(B→A)@T5` then a long-offline `add_item(B)@T7` ends with an entry
for B in one order and for A in the other. The registry pass' design does no
rewriting — the reducer tombstones the catalog row and nothing else, so both
orders end with the same orphan entry on a tombstoned item. Convergent. The
residual (a long-offline device resurrecting an entry on a merged-away vara) is
visible and manually fixable, which is exactly the cost the sync pass called
acceptable. **Constraint to carry into implementation: the reducer must never
rewrite entry or contribution rows during a merge.** Purchases,
recipe_ingredients and aliases are re-pointed by a bounded, idempotent
server-side effect, the same boundary purchases already sit on.

- **The merged-away word survives as an alias.** Verified by execution that this
  makes old recipe lines keep resolving with **zero matcher changes** —
  `matchIngredient` already takes a candidate list, so the caller expands each
  item into one candidate per name-or-alias.
- **Purchase history under a split moves itself, honestly.** Scan-sourced
  purchases point at a *product*, so they follow the product. Tile-tap purchases
  carry only the vara and stay. That is exactly right: **we know what we scanned;
  we do not know what we tapped.** Dividing tapped history between the two sides
  would be inventing data. Never split `purchases`.
- **Delete is soft, and blocked** while the vara is on an active list or has
  products pointing at it, with the fix offered inline. Reaching into today's
  shopping from a taxonomy screen is the surprise that erodes trust.

### 2.11 Purchase attribution, and the unknown EAN

`purchases.catalog_item_id` becomes **nullable**, `product_id` is **added**, with
`CHECK (catalog_item_id IS NOT NULL OR product_id IS NOT NULL)`.

```
effective item = COALESCE(purchases.catalog_item_id, products.catalog_item_id)
```

Tile tap → `{item, null}`. **Any scan → `{null, product}`**, mapped or not. Not
denormalising the vara onto scan purchases buys three things: retro-attribution
is automatic rather than a migration, a corrected wrong guess moves *all* its
past purchases, and splits move the history they can honestly move.

Stated cost: until a human places the product, its purchases are invisible to
cadence and statistics. Deferred, not lost — which is exactly why the review
queue is not cosmetic tidying but the thing that makes the numbers true, and why
it advertises the debt (`3 köp väntar på att placeras`).

**One shared helper owns that COALESCE.** Two hand-written versions of "which
vara did this purchase count for" will disagree somewhere nobody tests.

**Auto-map threshold: 0.8, never 0.7.** Verified by execution against the real
seeded catalog: the 0.7 compound-head tier maps **"Kaffe Gevalia Mellanrost" →
ost** and **"Zoégas Skånerost" → ost**. In buy mode a wrong auto-map silently
records a purchase against the wrong vara. At 0.8, two of twelve realistic
Swedish product names auto-commit and ten go to the queue — **that ratio is the
design, not a failure of it.**

### 2.12 Seeding survival — a live production bug

`src/db/seed.ts` upserts every catalog item on every boot, overwriting exactly
`name`, `name_norm`, `category_id`, `icon_ref` — the four columns the registry
makes editable — and `instrumentation.ts` runs it in production. As written,
**every deploy and every container restart would silently revert every edit, in
production only.**

Latent today only because nothing dispatches `update_catalog_item` from the UI.
The registry is what activates it, so the guard ships *before* the editing UI:

```ts
setWhere: eq(catalogItems.updatedBy, SEED_ACTOR)
```

`updated_by` already *is* the fact we need: the seed writes `"system"`, and
`applyOpToDatabase` overrides the client-supplied actor with the authenticated
one, so a human edit cannot wear the seed's name. Two supporting properties, both
of which deserve comments because a later change could break them silently:
`recordPurchaseIfBought` bumps `use_count` with a direct UPDATE that never
touches `updated_by` (so buying does not freeze an item against seed
corrections — a happy accident today), and `catalog_items` needs `deleted_at` or
a deleted seeded item is re-inserted on every boot.

**`"system"` becomes a reserved actor name.**

---

## 3. What is already built

| | |
|---|---|
| **R1 — forward compatibility** | `default: return state` in `applyOp` with a `never` guard; per-op server validation; outbox bounded-retry-then-drop; `STATE_VERSION` rehydrate tripwire. Committed. |
| **Undo retracts the purchase** | `purchases.client_op_id` (unique), `add_item.undoesClientOpId`, `last_used_at` recomputed from survivors. Committed. |

R1 had to come first and had to *propagate* before any new op kind exists,
because an un-upgraded client meeting one did not degrade — it crashed, wrote
`undefined` over its cached state, and retried forever.

---

## 4. Build order

Risk-ordered, each step independently shippable and reversible.

1. ~~**R1 forward compatibility**~~ — done.
2. ~~**Undo retraction**~~ — done. Prerequisite for anything reading history.
3. **Seed-survival guard** + `catalog_items.deleted_at` + `delete_catalog_item`.
   Early, because it is the part that fails invisibly in production.
4. **Per-field clocks on `update_catalog_item`.** Verified by execution: a rename
   at T5 plus a concurrent re-file at T2 silently reverts the category. Hard
   prerequisite for the registry, not a nicety.
5. **Buy/plan mode** + the two colour collisions + mode-dependent undo copy.
   No schema change.
6. **Purchase-history digest** (`PurchaseStats` in the snapshot, persisted) →
   recency surfacing, the new `ItemSheet`, `Har alltid hemma` finally getting a
   UI. Fixes suggestions vanishing offline as a side effect.
7. **Priority flag** — one op, one clock, the `writeEntry` carry-forward hazard.
8. **Modifiers** — one op, one clock, tile line, add-bar confirm sheet.
9. **Registry model + sync**, then `/varor`, then the scan path.
10. **Taxonomy ops** — split sheet, merge, alias-on-merge, deterministic
    tie-break in the matcher.
11. **Statistics** at `/statistik`.
12. **Fridge inference** last, since it depends on 6 and on real history.

---

## 5. Tests that are not optional

- Both new clocks (`priority`, `modifier`) **added to the exhaustive-permutation
  convergence test**. That test is where the shared-clock data-loss bug was
  found; a clock outside it is a clock nobody has checked. Seven ops is 5040
  orderings and still milliseconds.
- **A DB round-trip meta test per new clock**: apply → `loadStateSlice` → assert
  reconstructed meta equals what `applyOp` produced. This is what would have
  caught "the per-field clocks did not survive the database" by construction
  rather than by a reviewer noticing.
- **Snapshot-hydration equivalence**: `loadListSnapshot` → `applySnapshot` →
  assert meta equals the server reducer's. Would have caught both pre-existing
  bugs in §6.
- `add_item` after `set_priority` must not reset priority (the `writeEntry`
  fresh-literal hazard).
- Seed → edit → seed again: name, category, icon survive. Same for delete and
  merge.
- Recipe lines containing a buying-qualifier word must still match the same
  `catalogItemId` — pin the 23/24 baseline.
- Playwright: plan tap writes no purchase; buy tap writes exactly one; unknown
  EAN scanned in buy mode with the server dead → queued → placed → the purchase
  counts.

---

## 6. Pre-existing bugs found along the way

Not caused by this work; found while reading for it. None block the build.

**Status, 2026-07-30 hardening session.** 1 and 2 fixed (away session). 3 fixed —
and reading it prompted finding a second, worse instance of the same shape in the
per-field clocks that already existed, where a NULL fell back to the row clock and
the row clock moves. 4 fixed as far as the reducer goes (per-field clocks and
orphaned contributions are now pruned); the "no caller anywhere" half is a
decision about retention and is in DECISIONS.md. 9 fixed by collapsing purchases
to one per local day inside `analyzeCadence`. 6, 7 and 8 stand, each with a
recommendation in DECISIONS.md.

**5 fixed, 2026-07-30 (later).** It turned out to be three defects, not one: the
contributions did not move, the priority was silently reset at the destination
while the source kept it, and `opListId` returned only `toListId` so a device with
the SOURCE list open never received the op at all. The op now carries what it
moves — the payload is IN the op rather than read out of state, because a
read-modify-write cannot be order-independent — and it routes household-wide.
Anders ruled that only the manual contribution travels; a recipe's share stays on
the list its addition belongs to.

1. **`loadListSnapshot` omits removed additions' clocks entirely** — so a stale
   `add_recipe` replayed from the outbox wins against nothing and **resurrects a
   removed recipe with its contributions. Reproduced.** Fix: emit `addition:x`
   meta with `deleted: true`.
2. **Entry meta in snapshots lacks `deleted`.** Harmless until anything calls
   `pruneTombstones` client-side, then it is a resurrection bug of the same shape
   already fixed once for `writeEntry`.
3. **Clearing a manual amount hard-deletes its LWW clocks**, so a later
   `set_amount` finds no meta and `wins()` returns true *regardless of
   timestamp* — two devices end up permanently divergent on the amount. The more
   serious of these.
4. **`pruneTombstones` has no caller anywhere**, and nothing prunes `ops`. So the
   op log is unbounded (replay-from-genesis happens to work) and client `meta`
   grows forever while `saveState` re-serialises the whole blob on every tap. My
   brief's 30-day-retention premise was simply wrong.
5. **`move_item` does not move contributions** — a moved item arrives with no
   amounts, and after this work, no modifiers or priority either. *(Fixed; see
   the status note above.)*
6. **Suggestion dismissal is entirely unwired** — table and migration exist,
   zero reads or writes, and the design doc promises it.
7. **`users` is never populated or read** in production, which blocks "who bought
   it" in statistics.
8. **`sourceKind: "scan"` / `"suggestion"` are never produced** — the entry
   sheet's "Skannad"/"Föreslagen" labels are dead code.
9. **A same-day double purchase halves the cadence median** (`analyzeCadence`
   takes intervals between consecutive purchases). Fix on the read side by
   deduping per item per calendar day.

---

## 7. Interfaces between the pieces

- `record_purchase` is **one shared op** and must carry `productId` beside
  `catalogItemId`, or the unknown-EAN buy-mode scan has nothing to attribute to.
  **ADJUDICATED:** the registry pass' superset shape wins over the history pass'
  narrower one.
- `purchases` also gains `quantity_value` / `quantity_unit` now, even though no
  v1 rule reads them, because they **cannot be backfilled**.
- Modifiers live on `Contribution.modifier`, *not* `note`. The promotion detector
  reads `CatalogItem.modifierUses`.
- **Hard rule both ways:** products never map to a modifier, and modifiers never
  carry products or purchase history. One is a note, the other is identity.
- Promotion opens the **split** sheet pre-filled. It is a shortcut, not a
  mechanism.

---

## 8. Explicitly not in v1

Product-to-product merging and duplicate detection; category editing (the 19 rows
stay seed-owned); `defaultSize` auto-filling a list amount on scan (`set_amount`
is unconditional LWW, so a scan would clobber a typed quantity); a
`sourceKind: "scan"` contribution; consumption-rate statistics; splitting into
more than two varor at once; products in recipes; seeded products or aliases;
bulk OFF enrichment; charts of any kind; spend (no prices exist anywhere);
per-member permissions.

---

## 9. Needs Anders

Everything else I decided. These three are genuinely his.

1. **One tile per item means "2 kg mogen AND 1 plain, both mine, no recipe" needs
   promoting mogen mango to its own vara first.** This is the one place the design
   does not meet the literal request. Both the modifier pass and I recommend it
   anyway — the recipe-versus-me case works today, and the alternative buys a
   whole identity axis for one phrasing. But it is a scope reduction against what
   he asked for, so he should know.
2. **Buy-mode scanning: instant-with-undo, or the ask?** He asked for the ask. I
   recommend instant, with confirmation and undo in the scanner's existing result
   line, because a modal per scan turns a continuous bag-scanning session into
   fifteen dialogs. The non-blocking version of his ask is specified if he wants
   it kept.
3. **Fridge-inference default.** Pre-excluded with a visible reason badge is
   specified and recommended. The cautious first release is badge-only with the
   row still included, flipping the default once there is real history to check
   against — a one-line change either way.

One thing he suggested that I overrode and should flag: **plan mode is untinted**
rather than green-tinted, because green already means "on the list" and a green
header would put the state colour back into the furniture. Buy mode carries the
whole signal. One-line change if he disagrees.
