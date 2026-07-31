# Fewer taps, 2026-07-31 (later) — read this first

Anders used the previous session's work and came back with four complaints, all
of them about the same thing: the app knew what he wanted and made him say it
three times anyway.

## "How do I add both a banan and a mogen banan?"

The invariant is right and stays: **one vara appears at most once per list**, so
you pass the fruit shelf once. Two kinds sharing a tile would mean one of them
has no amount of its own.

So the answer was always a second vara, and the schema says as much — "when ripe
mango genuinely deserves its own cadence, that is the registry's split". The
problem was never the model. It was that taking the supported path **punished
you**: everything the add bar creates went to Övrigt with a box icon, and Övrigt
sorts LAST. Keeping a kind of your own put it at the wrong end of the shop,
permanently, and the penalty landed hardest on exactly the person who knew what
they wanted.

A created vara now inherits the aisle and icon of the vara its query resolved
to. "mogen banan" lands in Frukt & grönt with a banana icon, beside banan. The
create row says where it will go before you commit, and shows the icon it will
inherit rather than a generic plus.

The guess is narrow on purpose: only when a qualifier was actually split off, so
"bananbröd" — which merely looks a bit like banan — inherits nothing. With
nothing to inherit from it still falls back to Övrigt, which is the honest
answer for a word the app has never seen.

## "mogen banan" and "banan mogen" are the same instruction

Only one of them is grammatical, and an app that understood one word order would
be teaching a syntax rather than taking an instruction. The qualifier is now
looked for behind the vara as well as in front. Front wins when a query reads
both ways, because Swedish puts the head noun last.

While testing the pair: `splitQuery` found a quantity at either end but not in
the middle, so "banan 3 st mogen" silently made "3 st mogen" the qualifier and
printed it on the tile. The interior pass runs LAST, so it can only add an
answer where there was none — neither of the orders that already worked can be
reinterpreted by it.

## "Why is amount hidden behind a hold, a menu and a Spara?"

Because it was, and there was no defence. Putting "2 kg" on a vara was:
long-press, read a menu, tap "Ändra mängd", type, tap Spara. Five deliberate
acts and two screens for one number, on a phone, in a shop.

Nothing was learned at any of those steps. Opening the sheet already said you
wanted to change something, and a field is the only control that says "type
here" without being asked. Amount and sort are fields now, side by side, always
visible, committing on blur and on Enter. There is no Spara to find and the
sheet no longer closes underneath you — it used to, which made setting a sort
*as well* a second long-press.

Side by side because vertical space is the scarce thing: with a keyboard up on a
small phone the sheet has about three rows before the fold, and priority has to
be one of them.

## "Long-pressing in the catalog does nothing"

It did nothing, and the workaround was worse than obnoxious, it was three
navigations: tap mango in the well, watch it leave the well, scroll up to the
buy zone, find it among everything already there, and hold THAT.

Catalog tiles take the same 500ms hold now and open the same fields, so there is
one gesture to learn rather than two. The difference is that nothing has
happened yet: this sheet holds a draft and commits on "Lägg till", where the
entry sheet edits something already listed and commits as you type. Dismissing
it leaves the list untouched, which is what makes it safe to open out of
curiosity. The frequent panel's tiles got the same gesture, because a grid of
varor should behave like a grid of varor wherever it is drawn.

Each field is still its own op. They resolve against separate clocks, and
bundling them would let a stale phone's amount drag the sort back with it.

## Verified

568 unit tests across 25 files, 17 e2e, tsc and eslint clean. In the real UI:
one hold on mango in the catalog produced a listed tile carrying "mogna", "5 st"
and urgent — three facts, one gesture, where the old path was eleven. "mogen
banan", "banan mogen", "banan mogen 3 st", "3 st mogen banan", "banan 3 st
mogen" and "3 mogna bananer" all resolve identically. Creating "mogen banan"
wrote `frukt-gront` and icon `1F34C` to the database, not `ovrigt` and a box,
and both bananas sit on the list as separate tiles.

---

# Search session, 2026-07-31 — the add bar reads a query now

A UX pass on the core loop with Bring as the reference. Three of the findings
turned out to be one finding.

Everything the pass turned up is now built: the matcher, the qualifier, the
panel that opens on what you buy most, two varor in one query, the registry's
second way in, and the long-press hint. The sections are in the order they were
found, not the order they shipped.

## The add bar had the weaker of the app's two matchers

`rankMatches` asked one question — does this catalog name contain what was
typed — while `matchIngredient`, on the recipe path, asked five and knew about
Swedish compounds, aliases and preparation words. So the fast path, the one used
one-handed in a shop, was the worse one.

Measured against the seeded catalog rather than reasoned about: `tomater`
reached *krossade tomater* and *passerade tomater* but never *tomat*. `mogen
mango`, `färsk basilika`, `röd paprika` and `laktosfri mjölk` reached nothing at
all — and the only thing on offer for any of them was `create_catalog_item`,
which files a permanent second mango under Övrigt beside the one already there.

Same duplication the units engine was spared. "2 l" has one implementation in
this codebase on purpose; matching had two.

## Two tiers close it

**Inflection**, because every literal tier asked whether the catalog name
contained the query and none asked the reverse. `tomater` is how anyone refers
to the vegetable.

**Fuzzy**, last and only ever last. Damerau-Levenshtein, abandoned the moment a
row goes over budget. Transposition costs one step rather than two because a
thumb produces `mjköl` about as often as `mjök` and they are the same slip. The
budget grows with the query — nothing under four characters, one step at four to
five, two above — since at three characters nearly everything is one edit from
everything and the tier stops carrying information.

Two spurs are load-bearing. Fuzzy can never outrank something that matched
literally, and it may never decide where a name **ends**: `mangp` alone resolves
to mango, but `stor mangp` resolves to nothing, because otherwise one slipped
letter turns the word in front of it into a qualifier nobody typed.

## "mogen mango" is amount + sort + vara

`resolveQuery` peels the amount, then takes the **longest** tail that names a
vara and lets whatever leads become the modifier. Longest-first is the whole
trick: it keeps `gul lök` and `krossade tomater` whole, since those are varor in
their own right rather than *lök* and *tomat* wearing an adjective.

This is `parseIngredientLine` with one deliberate inversion. The recipe importer
*discards* the leftover words, because "färsk" and "riven" describe what you do
at the stove. A shopping list *keeps* them, because they describe what you pick
off the shelf. Same reading, opposite disposal of the remainder — and what is
left over is exactly what `modifier` already existed to hold.

No new op kind. `addItem` already sequenced `add_item` then `set_amount`;
`set_modifier` joins that sequence, so this ships before anything new is on every
phone — the same condition "Markera som köpt" was held to.

A typed qualifier also skips the duplicate-ask sheet, and that is not a
loophole. The sheet is a correction for a qualifier being **silently inherited**;
someone who typed "mogen mango" has said which mango they mean. The sheet still
fires unchanged when nothing was said.

## Two rules that were wrong on the first attempt

**The inflection tier started as a length cap** — at most three more characters
— which is fine until it meets the real catalog. *mjölk* is *mjöl* plus a k, so
the most-bought item in the shop suggested flour as its second result. Swedish
plural and definite endings are a closed set, k is not in it, and listing them
costs one array. Flour is still reachable from `mjölk`, one edit away, but now
below a genuine substring match instead of above one.

**The review also proposed requiring word boundaries** for substring matches, so
`ägg` would stop dragging in *kalkonpålägg*. That rule would have taken
*havremjölk* and *filmjölk* out of the results for `mjölk`, because Swedish
compounds have no word boundaries to require. The noise was cosmetic — the exact
match still sorted first — and the price was not. Substring matching is
untouched.

## Focus fell to `<body>` after every add

The suggestion row that took the tap unmounts on the same frame, so nothing held
focus afterwards. On a phone that closes the keyboard between every single vara:
six things is one errand, and it cost six keyboard animations and six taps back
into the field. `onMouseDown` preventDefault on the rows stops the blur
happening; an explicit refocus recovers it where preventing mousedown is not
enough.

## Verified

554 unit tests across 25 files, 16 e2e, tsc and eslint clean. In the real UI
against the dev database: `mogen mango` lands mango on the list carrying "mogen"
in one tap, written as `set_modifier`, rendered italic under the name on the
tile. `smro` → smör, `havregyrn` → havregryn, `tomater` → tomat, `bananer` →
banan. Focus sits in the input after a real tap. The duplicate-ask sheet still
asks when nothing was typed.

## The panel, and the bug it exposed

Focusing the field used to do nothing at all: a whole screen of keyboard bought
with nothing under it. It opens on the six varor the household buys most now,
because the common errand is a staple you buy every week and the fastest way to
type "mjölk" is not to.

Two details are the difference between a rapid-add surface and a menu.

**The grid is frozen at open.** An item leaving it the instant it is added would
slide the next one into the space a thumb is already travelling towards. So the
set is captured when the panel opens and the ones you add turn green where they
stand, inert — tapping a green tile does *nothing* rather than removing, because
a removal from inside the panel whose entire job is adding would record a
purchase in buy mode.

**`useCount` is the right number and it was already there.** It is incremented
by a purchase and by nothing else — not by adding, not by tapping around — so
the panel means "what you buy" rather than "what you last touched". A household
with no shops behind it therefore has no answer, and the panel stays shut rather
than offering the catalog's first six alphabetically. That is the honest empty
state, and it means this degrades to the old behaviour on day one.

Then the bug, which is worth recording because it is the same bug the whole
session is about. `keepFocus` was on each control, and the frequent grid is
built from `ItemTile`, which takes no mouse-event props and has no reason to.
So a press on a tile blurred the input, blur closed the panel, the tile
unmounted mid-gesture, and the click landed on nothing: the tap simply did not
happen. It now lives on the panel container, where one handler covers everything
inside it — including whatever gets added next.

## Two varor in one breath

`salt och peppar` resolved to nothing, and the near miss was worse than the
miss: without a guard it resolves to *peppar* of the sort "salt och". A
conjunction is never a qualifier.

`resolvePair` is deliberately narrow. It fires only for a bare pair, because an
amount or a sort cannot be divided between two things without guessing which one
it belonged to — "2 dl salt och peppar" has an obvious wrong answer and no
obvious right one, so it stays a single-vara query and offers a create.

## Two smaller ones

The registry was reachable only from a button two thirds of the way down the
catalog well. The old note said a second icon up top would read as a copy of the
aisle rail's grid glyph, which was true of a *grid glyph* and not of the
problem: three screens were being advertised in three unrelated places and the
one nobody could find was filed furthest down. A bag reads as goods rather than
as a layout. The button in the well stays; it just is not the only way in.

And the long-press hint, said once ever, per person per device, in
`localStorage` — `sessionStorage` would make "once" mean "every morning". It
waits for a third item so it is not the first thing a new list says, and it sits
in flow above the grid rather than over it. `useOnce` is built on
`useSyncExternalStore` for the same reason `useMode` is: storage is an external
store, the server has none, and reading one in an effect and calling `setState`
is a cascading render the linter is right to refuse.

## Verified

563 unit tests across 25 files, 17 e2e, tsc and eslint clean. The new e2e test
earns its keep — it buys something in buy mode to create the purchase history,
reloads, and asserts the panel offers it, that the tap lands, that focus never
left the field, and that the tile went green **in place**. It also pins the
empty state: with no shops behind it, nothing opens.

One trap for whoever writes the next one: while the panel is open the same vara
is legitimately on screen twice, in the grid and in the zone, so `onListTile`
matches two elements and trips strict mode. Dismiss the panel before asserting
with it.

## Left undone

*gröt* is not in the seeded catalog at all — only *havregryn* — so it cannot be
found however good the matching gets. That is a gap in the catalog and worth a
pass over the seed list for other everyday Swedish staples missing the same way.

---

# Away session, 2026-07-30 (evening) — read this first

Anders answered every open decision and then went out for a few hours. Nothing is
waiting on him except the two items at the end of this section.

## What he decided

1. **`move_item`**: only the manual contribution travels; a recipe's share stays
   on the list its addition belongs to. Fan-out goes household-wide (`opListId`
   → null).
2. **Recipe amount not travelling is fine.** The move sheet says so before you
   choose rather than after.
3. **Moving onto a vara already on the destination overwrites its amount and
   priority** — acceptable, but the sheet must say so. It does, phrased as a
   condition, because the device only holds the current list's entries and
   genuinely cannot know whether the item is already there.
4. **Retention: 30 days**, both prunes, one constant.
5. **The statistics roster derives from `autheliaUser`.** Anders and Jannica are
   already distinct on every op and every purchase row, because auth reads
   Authelia's `Remote-User` — so this needs no new plumbing. NOT yet built: its
   only consumer is `/statistik`, which does not exist.
6. **Suggestion dismissal is household-wide**, and that is wanted rather than
   tolerated: dismissing silences the suggestion for both of you.

## What got built

`move_item` (fixed and reachable), retention, suggestion dismissal, and **the
item registry end to end** — schema, the five ops, server persistence, snapshot
hydration, the matcher's alias support, and `/varor` itself with its review
queue, split, merge and blocked-delete.

`525` unit tests, `14` Playwright flows, `tsc` / lint / `build` clean.

Build-order steps 9 and 10 are done apart from the **scan path**, which is the
one piece of the registry still missing: `handleScan` is still a bare `fetch`, so
an unknown barcode scanned offline is still dropped rather than queued. That is
the thing that turns a dropped scan into a lost purchase in buy mode, and it is
the natural next task — everything it needs (`create_product`, `link_barcode`,
`autoMapProductName` at 0.8, the review queue to catch what does not auto-map)
now exists.

## Gotchas found while building, worth knowing

**`pruneTombstones` would have eaten the registry.** It rebuilt its result from
`emptyState()` and copied four maps across BY NAME, so anything later added to
`SyncState` was silently dropped — and the client now prunes on every app open.
Adding `products`/`aliases`/`barcodes` would have deleted the whole registry from
the store the first time anyone opened the app, with no error anywhere. Fixed
structurally: the result now starts as a copy of the whole state and overrides
only what it prunes, so carried is the default and dropped is the deliberate act.

**The move looked like it did nothing.** The store holds one list's state, so
nothing had ever needed to filter entries by list — until `move_item`, the only
op that writes an entry belonging to a DIFFERENT list, and writes it live.
Unfiltered, the moved item kept rendering on the source. Found by driving the
real app; no unit test could have seen it.

**Two clocks, two questions.** Retention prunes the op log on SERVER time and
tombstones on the CLIENT clock. `ops.at` is the phone's own clock and is
deliberately never rewritten, so a device with a wrong date would have its ops
deleted the moment they landed if retention read it.

**The wire schema had never been tested.** `Op` and `opSchema` are two
independent declarations of one shape and nothing made them agree; a drift 400s
the op silently rather than failing to compile. There is now a test, but it
covers `move_item` and the registry ops only — the other kinds are still
unguarded.

**The registry nearly shipped invisible, twice.** Both were the same shape: a
function that rebuilds a structure from scratch and populates it field by field,
so a field added later is silently absent. First `pruneTombstones` (fixed
structurally), then `applySnapshot` in the client store — the server had started
sending products, aliases and barcodes and the store simply did not read them, so
`/varor` would have rendered empty after every hydrate, indistinguishable from a
household that had never scanned anything. That one cannot be fixed structurally,
because a snapshot and a SyncState are genuinely different shapes, so it has a
test. **Worth asking of any new map: what rebuilds this, and does it name every
field?**

## Still needs Anders

- **Display names.** The roster derives from `autheliaUser`, which gives
  `anders`/`jannica`. Capitalising is the smallest thing that yields "Anders" and
  "Jannica", but it breaks the day an Authelia username is not someone's name.
  Say the word and it is ten minutes.
- **Deploying.** Recipus is fully onboarded for the beelink (its own Postgres
  role owning its own database, no published host port, entrypoint migrations —
  the longhaul pattern) but nothing has been verified ON the box: SSH is refused
  from here because the key needs a passphrase. `ssh-add ~/.ssh/id_rsa` and it
  can be checked.

---

# Hardening session, 2026-07-30 — read this first

The registry gate is done, priority and modifiers are built, `move_item` is
fixed, retention is wired at 30 days, and the two loose ends from the away
session are both closed. **Two decisions are waiting on you** — they are
collected in "Decisions I did not take" below, and nowhere else.

## Three data-loss bugs, all the same shape

They are worth reading together, because the third one is the reason to expect a
fourth.

**A clock that outlives its value.** Clearing both fields of a manual
contribution deleted the row, and the row is where the per-field clocks live. A
missing clock is not "no opinion", it is *anything wins* — `wins(op, undefined)`
is true whatever the timestamp says. So clearing an amount at 12:00 and a stale
`set_amount` from 11:00 arriving afterwards left the server with the amount
restored and the clearing device without it, permanently, each applying
last-write-wins correctly against the facts it held. The row now survives
emptied; both loaders withhold it from the records while still emitting its
clocks.

**A clock that moves.** `amount_updated_at` and `note_updated_at` were nullable
and fell back to the row's `updated_at` when unset — and the row clock advances
whenever *either* field is written. Setting the amount at 05:00 silently pushed
the note's clock to 05:00, so a note genuinely written at 03:00 arriving
afterwards lost a comparison it should have won. **In one arrival order only**,
which is what made it invisible: two devices, two different notes, neither wrong
by its own reckoning. Reproduced by execution before it was touched. NULL now
means "never written" — which is exactly what the reducer holds for an untouched
field — and no writer stamps a clock for a field its op said nothing about.

**A clock shared by four facts.** `update_catalog_item` had one clock for the
whole row, so a rename at 17:00 and a re-filing into another aisle at 14:00
settled differently depending on which the server saw first: applied
14-then-17 both stuck, applied the other way the re-filing lost and the item
walked back to its old aisle. Name (with `name_norm` — one fact, two
representations), category, icon and `has_at_home` now each carry their own
clock. This was the registry's hard prerequisite, and it is what makes "two
people tidying the catalog on a Sunday" safe.

**The pattern to watch for:** every one of these is a clock that describes
something other than what it is used to compare. Any new per-field clock needs
its own column, must be absent rather than defaulted when unwritten, and must
never be stamped by an op that did not touch its field. There are now DB
round-trip tests for each, because the pure reducer converges on all three — it
is the reconstruction from columns that broke, and only a test that goes through
Postgres can see it.

## Two more bugs, found by existing tests

**`pruneTombstones` could not do its job.** Per-field clocks were never dropped
(no `deleted` flag — a cleared amount is a value, not a tombstone), and
contributions of pruned entries were never dropped either, which kept their keys
alive, which kept the meta map growing. The map is re-serialised on every tap.
Also: a live record's key is now matched before the key's *shape* is parsed,
because ids contain colons — a custom item slugged "priority" makes
`entry:hemkop:priority` look exactly like a field key, and pruning a live entry's
clock is a resurrection bug.

**The forward-compatibility test had stopped testing forward compatibility.** Its
"op from the future" was `set_priority`, which shipped this session. Worth
remembering when picking the next placeholder: anything on the roadmap does this
eventually.

## The mystery e2e line is explained, and gone

Every full run logged exactly one `op refused by server`, on a different op and a
different test each time. It was **not** a sync bug. Every assertion in the suite
passes on optimistic state — that is the app's design and testing it otherwise
would test something else — so a test could finish with its ops still in flight,
and teardown then dropped the list out from under a POST the server had already
accepted: a foreign-key violation on `list_entries`. The page now closes and the
outbox settles before the list goes. Zero across three consecutive runs.

The server-side `console.error` added in the away session is what made this
diagnosable at all; before it, the client only knew "refused".

## Priority and modifiers

Priority is three states and uses two channels the tile already has: order
(urgent first, convenient last, **within** the existing aisle grouping so walking
order survives) and the item name's ink. No new tile furniture — both corners are
taken and green means exactly one thing here. A visually-hidden suffix carries
it, since ochre-versus-grey is otherwise the entire signal.

Removal clears it, on its own clock. Without the clear urgency becomes permanent
decoration; with a shared clock, "mark urgent" would beat a newer removal and put
something you already bought back at the top.

Modifiers are per-contribution and never in an id, per your butter observation. A
modifier that changed identity would split one tile into two and send you past
the fruit twice. The confirm-on-duplicate sheet is a **correction, not a
courtesy**: modifier and amount share a record, so typing "mango 1 st" against an
existing "2 kg mogna" silently produced "1 st mogna". It fires only from the add
bar, only when the existing ask carries a modifier. A tile tap never opens a
dialog.

Verified in the real UI against the database: priority and modifier each written
with their own clock, banan sorted ahead of mjölk and ost, the duplicate sheet
firing and "Nej, vanlig" clearing the qualifier while applying the new amount,
and removal returning priority to normal.

## `move_item`, and the thing it taught

Three defects, not the one that was written down. Contributions did not move.
Priority was silently reset at the destination while the *source* kept it, which
is backwards. And `opListId` returned only `toListId`, so a phone with the source
list open never received the op at all — two people, one moves milk from Hemköp
to Bauhaus, and the other goes on seeing milk at Hemköp until something makes
their client re-hydrate.

**The interesting one is the shape of the fix.** A move is the only op that would
have to READ the state it rewrites — "take whatever is on the source and put it
over there" — and a read-modify-write cannot be order-independent. A `set_amount`
the mover had not seen yet is present in one arrival order and absent in the
other, so two devices settle on different amounts at the destination and neither
is wrong by its own reckoning. So the op now **carries what it moves**: the
moving device names the priority and the amount/note/modifier, and the reducer
stays a pure function of the op set. That is not a detail — it is the difference
between a move that converges and one that quietly does not, and the
120-permutation test only fails for the read-from-state version. I checked that
by writing it, running it, and watching it fail before restoring the fix.

The price is bounded and worth naming: an edit the mover had not seen does not
travel. It stays on the source entry under the tombstone, recoverable by putting
the item back on that list. The alternative is two lists disagreeing forever with
no error anywhere.

Your two rulings are in: only the **manual** contribution travels (a recipe's
share is keyed to a list-scoped addition, so a recipe that asked for cream at
Hemköp has no meaning at Bauhaus), and the fan-out is **`opListId` → null**,
household-wide, which both the live SSE filter and the catch-up query already
treat correctly. Deliberately over-broad, and cheaper than teaching the event
shape to carry two ids for this one case.

Also: the urgency now travels rather than staying behind. Leaving it on the
source is the same "permanent decoration" bug that removal already guards
against.

Four new tests, and the DB round-trip one is the one that matters: the pure
reducer converges on all of this, and it is the reconstruction from columns that
has broken three times. The old single `move_item` test would have passed with
all three defects present.

## Retention: 30 days, both prunes, one constant

Anders's number. `RETENTION_DAYS` lives in `src/lib/retention.ts` and both sides
import it — deliberately not two constants that happen to agree, because a client
pruning on a shorter window than the server is precisely the resurrection bug the
window exists to prevent, and it would show up as items reappearing on one phone
only.

Server (`pruneRetention`, one transaction, on boot and then daily): the op log,
tombstoned entries, removed recipe additions, deleted lists and recipes.
Contributions go by cascade with their entry rather than by a second rule.
**Purchases are never pruned** — a purchase is not bookkeeping about a deletion,
it is the only record the household bought the thing, and it is the sole input to
the cadence engine and to statistics. `purchases.list_id` carries no foreign key
exactly so a pruned list cannot cascade into it; there is now a test asserting
that, because it is an easy property to lose in a later migration.

One asymmetry worth knowing: **the op log prunes on server time, tombstones on
the client clock.** `ops.at` is the client's own clock and is deliberately never
rewritten, so a phone with its date badly wrong would have its ops deleted the
moment they landed if retention read it — `created_at` is the only honest answer
to "how long have we had this". A tombstone is asking a different question ("how
long since the user removed it"), so it gets the clock that answers it. Tested.

Client: pruned once per open, in `ensureLoaded`, and written back only when
something actually went. The meta map is re-serialised on every tap, so this was
never about storage — it was a little more work per interaction for the rest of
the install's life.

Off by default in development (`PRUNE_ON_BOOT`), because this one deletes and a
dev database left on a laptop for two months would lose its old tombstones at a
startling moment.

## Decisions I did not take

**1. Statistics needs `users`, which is never populated.** "Who bought it" has
nothing to read. The authenticated actor is already on every op and every
purchase row, so the cheap version is to derive the roster from distinct actors
rather than maintain a table. That is my inclination; the table exists and
implies otherwise, so it is worth saying out loud before `/statistik` is built.

**2. Suggestion dismissal is fully unwired** — table, migration, and a promise in
the design doc, with zero reads or writes. It is a feature gap rather than a bug,
but it is the kind that quietly stays unbuilt because everything still works.

Two smaller things I left alone deliberately: `sourceKind: "scan"` and
`"suggestion"` are still never produced, so the entry sheet's "Skannad" and
"Föreslagen" labels remain dead (three harmless lines; producing them needs a new
op field), and `update_catalog_item` arriving *before* its `create_catalog_item`
still drops the update. The second is asserted in a test rather than left
implicit — the guarantee comes from the transport (`seq` is assigned on arrival,
replay follows `seq`, and an update can only be authored on a device that already
holds the item), so anything that later makes an update reachable without a
create — a registry import, a merge, a repair path — fails loudly there.

---

# Away session, 2026-07-30

Anders asked for four features to be specified, then built. Four parallel design
passes ran (modifiers/priority, purchase history & modes, item registry, and a
cross-cutting sync-seam review); the synthesis, with every adjudication between
them, is
[`docs/superpowers/specs/2026-07-30-items-history-registry.md`](./docs/superpowers/specs/2026-07-30-items-history-registry.md).

**Three things need you.** They are collected in §9 of that spec and nowhere
else: the one-tile-per-item scope reduction, whether buy-mode scanning asks or
acts-with-undo, and the fridge-inference default. Plus one thing of yours I
overrode: plan mode is **untinted** rather than green-tinted, because green
already means "on the list" and a green header puts the state colour back into
the furniture. Buy mode carries the whole signal. One line to change back.

## What got built

**Forward-compatibility hardening, first, because it gates everything else.**
Every queued feature adds an op kind, and a client meeting an unknown one did not
degrade — it crashed. Verified by running it: `applyOp` fell through its switch
and returned `undefined`, `applyOps` threw on the next op, the store wrote
`undefined` over the cached state and retried forever. That is an app that opens
to an empty list in a shop and blames the network. Also fixed in the same pass:
the server validated the whole ops batch as one schema, so a single unparseable
op 400'd everything beside it and the outbox re-posted forever; a refused op was
left queued for the lifetime of the install so the sync banner never cleared; and
there was no way for a client that *had* dropped an op to know it needed
repairing. **This must be on both phones before any new op kind ships.**

**Undo now retracts the purchase.** It only ever put the item back. The purchase
row and the `use_count` bump stood, so "bought" quietly included everything
anyone had ever mis-tapped — and purchase history is the only input to the
cadence engine, and shortly to the statistics you asked for. `last_used_at` is
recomputed from the surviving purchases rather than cleared, because clearing
would erase a genuine earlier purchase and leaving it would let a retracted
timestamp stand in for one.

**Plan mode and buy mode are built.** Plan-mode tap records nothing, buy-mode tap
records a purchase, and each mode's long-press offers the other mode's action so
neither can trap you. Exactly one gesture changes meaning between modes. Two
end-to-end tests assert against the `purchases` table, because the difference is
invisible on screen — the tile leaves the zone either way.

Three things I changed against your literal description, each for a measured
reason: plan mode is **untinted** (green stays reserved for item state); the buy
hue is **terracotta, not amber** (an amber wash measured ΔL* 1.60 from
`--color-warn-tint`, so it would have collided with the offline banner); and the
accent is an **inset shadow rather than a border** (a border made the header 94px
in buy mode against 93px in plan, and the aisle rail measures header height at
runtime to place its jump offsets). "Markera som köpt" reuses the existing
`remove_item{bought:true}` rather than adding a purchase-only op, so it ships
without waiting for a new op kind to reach every device.

**The recipe-resurrection bug is fixed.** `loadListSnapshot` filtered removed
recipe additions out of its query, so a hydrating client got neither the row nor
its clock — and a missing clock is not "no opinion", it is "anything wins", since
`wins(op, undefined)` is true whatever the op's timestamp. A stale `add_recipe`
replayed from an outbox therefore brought a deleted recipe back, with every
contribution it had asked for. The clock now travels for every addition and the
record only for live ones, matching what `apply-op`'s own loader always did
correctly. Tombstoned entries now carry `deleted` in their clock too — harmless
today, a resurrection bug the moment anything prunes client-side.

Worth knowing how nearly that fix shipped broken: `removedAt` was missing from the
query's projection, so `undefined !== null` evaluated true and **every** addition
was marked deleted, live ones included. The removed-addition test still passed —
for the wrong reason. `tsc` caught it, and there is now an explicit assertion that
a live addition arrives with an undeleted clock.

**All three of your answers are built.** Recipe removal now asks whether to take
its ingredients with it (checklist, everything checked by default, `bought:false`
throughout since dropping a recipe is not a shop). Scanning is mode-aware, with an
unplanned buy-mode pickup added and bought in one gesture and undo in the
scanner's own result line. And the fridge guess pre-excludes small amounts of
things with a known cadence, badged with the reason, behind a per-device flag whose
"off" keeps the badge and drops only the presumption.

**One bug found while building the scan undo, with a much wider blast radius than
the feature.** `wins()` compares timestamps and then falls back to comparing
actors — so two ops from the SAME person in the SAME millisecond tie, and the tie
resolves as "the newcomer loses". Right for a genuine two-device conflict, silently
wrong for two ops one device dispatched together on purpose. Undo of a buy-mode
scan does exactly that (re-add so the purchase can be retracted, then remove
again), and the item was left on the list. Two fast taps on one tile are the same
shape. Client op timestamps are now strictly increasing per session, via a pure
`nextOpTimestamp` with five tests.

## Gotchas worth your attention

**The generated migration would have broken the deploy.** `drizzle-kit` emitted
`ADD COLUMN client_op_id text NOT NULL` with no default, which aborts on any
table that already has rows — the dev database had 18 purchases. Hand-adjusted to
add-nullable, backfill, tighten. **Check generated migrations against real data
before trusting them**; this one failed loudly rather than quietly, but only
because I ran it.

**The seed-survival guard is now in** (`setWhere` on `updated_by`), with three
tests, because this is the worst possible failure profile: silent, production-only,
and unnoticeable in development where a seed and an edit are minutes apart. Two
things fell out of testing it that are worth knowing:

- **The seed cannot rename an item at all.** Ids are `slugify(name)`, so changing
  a name in seed data creates a NEW row instead of conflicting. The `name` and
  `name_norm` in the upsert's `set:` can therefore only ever differ by case or
  diacritics — very nearly dead code.
- **A seeded row's `updated_at` is its insert time**, so an op timestamped earlier
  loses and is dropped. Correct behaviour, and a non-issue in production since
  real edits postdate boot — but it made a test fail in a way that looked exactly
  like the guard being broken.

**Superseded — the seed used to revert catalog edits in production, silently.** `seed.ts` upserts
every item on every boot, overwriting name, category and icon — the exact columns
the registry makes editable — and `instrumentation.ts` runs it in production.
Latent only because nothing dispatches `update_catalog_item` from the UI yet. The
guard (`setWhere` on `updated_by`) ships before the editing UI, not with it.

**`update_catalog_item` shares one clock across all its fields.** Reproduced: a
rename at T5 plus a concurrent re-file at T2 silently loses the category. Never
bitten because nothing dispatches it; the registry is what wakes it up.

**Nothing prunes anything.** `pruneTombstones` has no caller and no job deletes
from `ops`. The log is unbounded and client `meta` grows forever, while
`saveState` re-serialises the whole blob on every tap. I had been designing
against a 30-day retention rule that does not exist.

**One thing I could not fully explain, so take it as open.** After adding the two
mode e2e tests, a full suite run logs exactly one `op refused by server` — a
`writeEntry` upsert failing, on a different op and a different test each run
(`set_amount` in test 3 one time, `remove_item` in test 9 the next). All nine tests
pass. What I ruled out: it does not reproduce when either new test runs alone; it
carries no Postgres error code, detail or constraint name, so it is not a
constraint violation; and it is not in the purchase path, since it fails inside
`writeEntry` before any purchase code runs. What I did not establish: the actual
cause. My best read is a pre-existing race between a page still draining its
outbox and the fixture's `dropTestList`, whose timing my new tests shifted — the
`apply-op.ts` comment at the failing line already documents cross-request FK
failures as an expected, per-op-reported outcome. Worth a proper look before
trusting the e2e suite's silence on this. Server-side logging for failed ops was
added while chasing it, which is a keeper either way: the cause used to be sent to
the client and recorded nowhere.

**Nine pre-existing bugs** are listed in §6 of the spec. Two are reproduced and
worth doing soon: a snapshot omits removed recipe additions' clocks, so a stale
replayed `add_recipe` **resurrects a deleted recipe**; and clearing a manual
amount hard-deletes its LWW clocks, after which a later `set_amount` wins
regardless of timestamp and two devices diverge permanently.

## Where to pick up

Priority flags and modifiers are next on the feature side — both are specified in
full, both are one op and one clock each. Before either, the per-field clock fix
below is still the prerequisite for the registry.


Build order and rationale are in §4 of the spec. Next is **per-field clocks on
`update_catalog_item`** — reproduced bug, a rename at T5 plus a concurrent re-file
at T2 silently loses the category — and it is a hard prerequisite for the
registry, not a nicety. I stopped short of it deliberately: it needs a migration
plus reducer changes plus server-side clock reconstruction plus additions to the
exhaustive-ordering test, and a half-finished schema change is the wrong thing to
leave behind unsupervised.

Two things I checked and deliberately did NOT fix, because both are currently
unreachable from the UI and so cost nothing today: `move_item` does not move
contributions (a moved item would arrive with no amounts), and
`update_catalog_item` is dispatched by nothing. The registry is what makes both
matter.

## Where the design landed, in one paragraph

Your butter observation settled the hardest question. Because the logical layer
is a household-owned taxonomy, "two mangos on the list" is not an identity
problem — it is the household deciding mogen mango is its own vara, which gets a
tile, an amount and a cadence for free. So `entryId` and the unique constraint are
untouched, modifiers stay a lightweight per-contribution scribble, and the
heavyweight answer is the registry's split. The variant key was assessed properly
and rejected: safe to store, but it cannot roll out gradually — an un-upgraded
phone silently merges the two tiles and then writes amounts to the wrong one.

---

# Plan-mode scanning only ever adds, 2026-07-30

You asked whether a scan in plan mode puts the item on the list. It did — but
only when the item was not already there. Already on it, and the scan **removed**
it, because the original scanner was bidirectional in both modes: on the list
meant "you just picked it up", off it meant "you just ran out".

That reading only holds in a shop. Standing at a screen or in front of the
cupboard, pointing the camera at something means "we want this", and the second
scan of the same product quietly took it back off. The scanner stays open and
keeps firing, so a repeat read of one barcode is not an edge case — it is the
normal way the thing gets used.

So plan mode now only ever adds, and says `mjölk finns redan på listan` with no
undo pill when there was nothing to do. Buy mode keeps the bidirectional tick-off,
which is where it belonged all along. Nothing is lost: removing something while
planning is one deliberate tap on the tile.

The four-cell table moved out of the component into `scanAction` in
`src/lib/client/scan-action.ts`, pure and tested. It decides whether a scan puts
something on your shopping list or takes it off, and a wrong cell is invisible
until a list is already wrong — that does not belong inlined where only a camera
can reach it. One of the five tests exists solely to pin that plan mode can never
record a purchase.

Verified in the real UI against the real database, all four cells: plan/not-listed
→ `mjölk tillagd`, 0 purchases. Plan/already-listed → `finns redan på listan`,
still on the list, 0 purchases. Buy/listed → `mjölk köpt`, off the list, 1
purchase. Buy/not-listed → `tillagd och köpt`, 1 purchase.

---

# Decisions & gotchas — autonomous build session, 2026-07-29

Read this first. Everything below happened while you were away.

**Where it stands:** everything in the design is built and verified.
**361 unit tests + 7 end-to-end**, `pnpm tsc --noEmit` clean, `pnpm lint` clean,
`pnpm build` green. Dev server on **port 3100** (3000 was taken by Travkollen),
Postgres on **5434**.

Deploy was scoped out of that session and has since been prepared — see
**"Deploy preparation"** at the end, and [`docs/deploy.md`](./docs/deploy.md)
for the runbook.

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
- Cadence engine, seeded catalog (341 Swedish items, 19 aisle-ordered
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

- **Deploy.** Explicitly out of scope for this session. See the standalone-build
  gotcha at the bottom before writing the Dockerfile — it will bite you.

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

**7. The service worker is network-first for navigations, cache as fallback.**
It started cache-first, which was wrong — see the bug note below. It still
refuses to cache a non-HTML or cross-origin navigation response, so an Authelia
redirect cannot become the cached shell.

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

**A cache-first service worker poisons its own origin.** The worker cached the
app shell and served it in preference to the network. That means one production
build on an origin breaks every later dev server on it: the cached HTML
references build hashes the new server does not have, so the page never
hydrates — and because the page never runs, the app can never unregister the
worker. The origin cannot recover from inside itself. It cost me a confusing
hour of a reload loop that looked like a bug in the recipe screens and wasn't.

Fixed by making navigations network-first with a 2.5s timeout and cache
fallback, plus a cache-tag bump so existing bad caches are discarded on
activate. The cost is far smaller than it looks: when you are genuinely offline
the fetch fails on connection setup in milliseconds, so the timeout only bites
on a flaky signal — exactly where a slightly slower correct answer beats a fast
stale one. The dev-mode registrar also now actively unregisters leftover
workers, as a second line of defence.

**Both halves verified in a browser**, on a clean origin so the test was honest:
served a production build, confirmed the worker installed and cached the shell,
killed the server, and reloaded — the app still opened. Then started a *dev*
server on that same origin, the scenario that had poisoned port 3100: no reload
loop, the leftover worker unregistered itself, caches emptied, and the real list
rendered.

If you do hit a stuck loop on an origin poisoned before this fix, clear site
data once (DevTools → Application → Storage) and it will not recur.

## Open questions for you

- **Authelia session TTL** must be long (weeks, "remember me") before this is
  usable in a shop. Code cannot fix it.
- **Which gap first?** My order would be: IndexedDB store (it is the headline
  requirement), then the ingredient parser (it unblocks recipes), then SSE.
- **Custom illustrations** for the top ~100 items remain the obvious visual
  upgrade; the data model is ready and it is pure asset work.

## Gotchas

- `git_agent` reported LOCKED, so commits are unsigned. **Nothing is pushed** —
  everything sits on the local `master`, per the away-mode contract.
- Dev Postgres is on **5434**; dev server on **3100**.
- **Deploy note, learned the hard way:** `output: "standalone"` breaks
  `next start`'s static serving, and the standalone server must be run *from
  its own directory* with `.next/static` and `public/` copied in. Without that
  it serves HTML and 404s every asset — including sw.js, so offline silently
  does not work. The Dockerfile has to do those copies.
- I left a dev server running. `lsof -nP -iTCP:3100 -sTCP:LISTEN` to find it.

---

# Deploy preparation

Everything needed to ship to the beelink now exists: `Dockerfile`,
`docker-entrypoint.sh`, `.dockerignore`, `.github/workflows/deploy.yml`,
`deploy/docker-compose.yml`, and the runbook in
[`docs/deploy.md`](./docs/deploy.md). It follows longhaul, which is the
reference for how apps reach that box.

**Verified, not just written.** I built the image and ran it against a throwaway
Postgres 17: the entrypoint took its pre-migration `pg_dump`, applied both
migrations, seeded 341 catalog items, and served. With proxy headers `/` renders
the real list; without them `/api/lists` is 401. `/sw.js`,
`/manifest.webmanifest` and the icon sprite all return 200 from the standalone
server — the check that matters, since that is exactly what silently breaks
offline. Then I restarted the container to exercise the *redeploy* path: second
dump taken, migrations a no-op, seed re-ran without touching anything. Cleaned
up afterwards.

## Three decisions worth knowing about

**The catalog seeds itself on every boot.** The production image has no `tsx`
and no `src/`, so `pnpm db:seed` cannot run inside the container — the standard
workaround is a throwaway container built from the image's *builder* stage, run
by hand. I did not want "the app is usable" to depend on someone remembering
that after each deploy, because an empty catalog is a screen with nothing to tap
and looks exactly like a broken deploy. So `src/db/seed.ts` now exports a
function, and `src/instrumentation.ts` calls it at server startup.

The seed was already idempotent and already preserves everything the household
owns (`has_at_home`, `use_count`, `last_used_at`), so this is safe by
construction — and it means a deploy that adds catalog items ships them.
Off in dev, on in production, `SEED_ON_BOOT` to force either. It is never fatal:
a failed seed logs and the app still boots, because losing catalog items is much
cheaper than losing the app.

The alternative I rejected was emitting the seed as SQL at build time. It would
have avoided the runtime coupling, but at the price of a second implementation
of "what belongs in the catalog" that has to stay in agreement with the first —
the same trap the shared reducer exists to avoid.

**No published host port.** The generic homelab pattern publishes `51NN:3000`;
longhaul deliberately does not, and Recipus follows it. Traffic arrives only
through NPM, on NPM's own network. A published port would be a second front
door past Authelia, and since the app's auth gate rejects anything without the
proxy secret it would serve nothing but 401s anyway. `5103` is the free slot if
you ever want one for debugging.

**The sprite is built into the image, with `--strict`.**
`public/icons/openmoji-sprite.svg` is gitignored, so a clean CI checkout has
none and production would silently fall back to system emoji — the
inconsistent-across-phones look OpenMoji was chosen to avoid. The Docker build
now fetches it, and `--strict` makes any missing icon fail the build: a blocked
deploy you retry is far cheaper than an image that quietly ships half a sprite.
All 112 icons fetched in the image build.

## A bug found while wiring that up

`ItemIcon` only checked whether the *sprite file* loaded, not whether the
specific symbol was in it. Once the sprite existed, any codepoint OpenMoji has
no art for rendered a **blank tile** rather than falling back to the system
emoji — and the comment in the sprite builder cheerfully claimed the opposite.
Invisible today because all 112 codepoints resolve, but a partial fetch in CI
would have shipped blank tiles to the shop. It now checks for the individual
symbol, which makes the fallback the builder always claimed to have.

## Still needs you (nothing here is code)

1. **Three GitHub repo secrets** — `REGISTRY_USERNAME`, `REGISTRY_PASSWORD`,
   `WATCHTOWER_TOKEN`.
2. **The database** — its own role, owning its own database, on the shared
   Postgres.
3. **NPM host + Authelia rule**, with the `X-Proxy-Auth` header injected and
   `Remote-User` passed through. Both are required; get either wrong and every
   request 401s.
4. **Authelia's session TTL: weeks, with "remember me".** Still the single most
   important setting, and still not something code can compensate for.
5. **The first container must be created by hand.** Watchtower updates
   containers, it never creates them — the first CI trigger will log
   `scanned=0 updated=0`, which looks like a broken token and is not.

# UI redesign

The visual language was rebuilt. The core loop, the sync model and every engine
are untouched; this is entirely presentation, and the 361 unit tests plus all 7
Playwright flows pass unchanged.

## Green means "on the list"

The header used to be a solid brand-green bar. That made the most saturated
thing on screen the *furniture*, competing with the green that carries the
actual signal — which items you still have to buy. Chrome is now paper and ink,
and green is spent only on items in "att handla" and on the one primary action
per screen. The catalog sits in a sunken well below, so the boundary between
"my list" and "everything we ever buy" is a change of ground rather than a
heading you have to read.

## The catalog got navigation

The real friction was never search, it was that reaching "Skafferi" meant a
dozen flicks past 341 items in 19 aisles. There is now an **aisle rail**: chips
that jump to any aisle, placed *after* the "att handla" zone and `sticky`, so
plain CSS gives it the right behaviour with no scroll handler — absent while
you are looking at your list, pinned under the header the moment the catalog
starts. Which chip is lit comes from an IntersectionObserver, not a scroll
listener. The add bar scrolls away (two stacked pinned bars would eat a fifth
of a phone screen), so the rail carries a "Sök" chip that brings it back.

## Emoji stopped being chrome

`🔍 📖 ▣ ➕ ✕ ✓ ‹ ▼` were doing the job of an icon set, and emoji-as-chrome has
one fatal property: the phone picks the artwork. Nothing matched the text beside
it and none of it could take the ink colour. Chrome is now lucide (already a
dependency) behind one closed module, `ui-icon.tsx`, at one stroke weight.
**Items are still OpenMoji** — a grid of little pictures is what makes the list
scannable and it is half the app's character.

## Contrast was measurably broken

Catalog tiles receded via `opacity-60` on the whole tile, which dragged item
names to about 2.5:1 — unreadable for anyone with mild low vision. Tiles now
recede via a quieter ink colour and a desaturated icon. Every text/background
pair in both schemes was checked against WCAG AA rather than eyeballed;
`--color-ink-faint` in light mode is *solved* for, not picked — it is the
lightest value that still clears 4.5:1 on `surface-sunken`, the darkest ground
it ever sits on.

## Type is a scale now

Twenty hand-picked pixel values between 9.5px and 19px became seven named steps.
The face is **Familjen Grotesk**, a Swedish public-information grotesk drawn to
stay legible on signage at distance — close to this app's actual reading
condition, and it means åäö were designed rather than adapted. Self-hosted by
`next/font` (verified: woff2 under `/_next/static`, zero requests to Google), so
there is nothing for the proxy to explain and nothing to fetch in a basement.
Sizes skew larger than before; item names went 11px → 13px.

## Things deliberately *not* done

- **No animation library.** Motion is CSS keyframes: tiles arriving in "att
  handla", sheets rising, a press-in squeeze that makes long-press
  discoverable. Nothing loops, nothing is ambient.
- **Pinned bars are opaque, not frosted.** Translucency ghosted high-contrast
  tile labels through the header in dark mode, and `backdrop-filter` on a bar
  pinned over a 341-tile scroller costs a GPU repaint every frame on exactly the
  phones this must stay smooth on. The sheet backdrop keeps its blur — it
  renders once.
- **Instant removal was preserved.** An exit animation on "bought" would have
  meant delaying the state change. A tap that waits is a tap that fails in a
  shop; the toast already confirms.

## "Ändra mängd" never did anything

Not a regression, and not subtle once looked at: `onEditAmount` was wired to
`() => setOpenEntry(null)`. It closed the sheet. There was no amount editor
behind it and never had been, even though the whole op path underneath —
`set_amount`, the reducer's per-field clocks, the tests around them — was built
and working.

It edits the **manual** contribution only. That is the one you own; the recipe
rows belong to their recipes, and quietly rewriting one would make the breakdown
printed directly above it a lie. Parsing goes through the same `parseAmount` the
add bar and the recipe importer use, so "1½ msk" means one thing in this app.
Unparseable input disables Spara and says so rather than saving nothing. An empty
field clears the amount and **leaves the item on the list** — an item with no
stated quantity is the ordinary case, not a deletion.

The button also now reads "Ange mängd" when there is nothing to change yet.

Verified end to end: set "3 dl" → tile reads 3 dl → survives a reload, so the op
reached the store rather than just React. Garbage rejected. Clearing leaves the
item listed.

## Toasts were covering the buttons

Two independent problems, and only one of them was the toast — worth separating,
because "Ändra mängd does nothing" and "the toast is in the way" had different
causes and the first would have survived fixing the second.

The buy toast sat bottom-centre for five seconds. Measured against an open entry
sheet: toast 772-828px, the sheet's action row starting at 728px — so it covered
the button below "Ändra mängd". And the core loop is tapping tile after tile, so
tap three's confirmation was still in the way when you made tap four.

A shopping list does not need a banner to say an item left it. The tile
disappears from the zone and the count drops; both are already on screen. So the
buy toast is gone entirely.

What the toast did carry was **undo**, and that is worth keeping: an item tapped
off by mistake drops back into its aisle somewhere down a 341-item catalog, not
somewhere you can see. Undo moved into the "Att handla" heading, in normal flow,
where it physically cannot cover a control. The heading reserves the height
whether or not the chip is there — measured 28px and the first tile at y=205
before and after a purchase, because this app has already been bitten once by
chrome that changes height under your thumb.

The surviving toasts are one-off confirmations and errors, down from 5s to 3s.

## Aisle navigation, second pass

The strip from the first pass was too slow, only went downwards, and looked
broken. All three complaints turned out to be real, and two of them were not
what they appeared to be.

**"It can't even scroll."** It could — a touch pan and a wheel both moved it,
measured. The actual problem was that 19 aisle names come to **1971px of chips
inside a 390px phone**, with the scrollbar hidden, so nothing said there was
more and the far end was five drags away. A strip is right for hopping to the
aisle next door and useless for finding one by name. So there is now a
right-edge fade that says "more this way", and a button that opens all 19 in a
sheet where everything is visible at once and nothing needs dragging (measured:
682px of content, no scrolling).

**No way back up.** The rail used to live below the buy zone, which meant it
scrolled away exactly when you wanted it. It is part of the sticky header now,
so it is always there, and "Listan" is pinned outside the horizontal scroller
where it cannot drift off-screen. Which also means it lights up as a
you-are-here indicator for the whole page rather than just the catalog.

**Jumps took most of a second.** `scrollIntoView({ behavior: "smooth" })` lets
the browser own the duration and it scales with distance. `fast-scroll` replaces
it with a fixed 180ms: measured at **150ms of actual motion for a 6608px jump**,
the same regardless of distance. Not instant, deliberately — a cut gives you no
sense of whether "Bröd" was above or below you. It cancels on a later tap (so
four taps are four taps, not a queue) and yields immediately to a real thumb on
the page. Reduced motion collapses it to one instant step, verified.

### Two bugs found by measuring rather than by looking

**The highlight could get permanently stuck.** Both passes derived "which aisle
am I in" from "is a heading inside a thin band under the header". That is quietly
wrong: a scroll which *skips* the band never reports anything inside it, so the
highlight stays wherever it was. The 180ms jumps do exactly that, and so does
any real flick — the rail sat there insisting you were in "Frukt & grönt" while
you looked at "Kött & fågel". The observer is now only a "something moved"
trigger and the answer is recomputed from actual heading positions, which cannot
get stuck. Verified across five scroll positions.

**Landing on the line is ambiguous.** A jump parks its heading 8px below the
chrome, and sub-pixel scroll positions put it a fraction the wrong side of a
comparison drawn at that same offset — so tapping "Skafferi" landed pixel-perfect
and then lit "Fryst". The detection line sits ~18% into the content now, which
also reads better: a heading just under the header means that aisle's tiles are
what fill the screen.

## The sync banner was flashing on every tap

Reported as "it makes the whole thing jump up and down very quick", and measured
rather than guessed: every tap queued an op, so `pendingCount` went 0 → 1 → 0 as
the outbox drained, and the banner that drove appeared at +153ms and vanished at
+190ms. The sticky header grew 49px → 78px and back **inside 37ms**, shoving the
entire list down 29px and up again. The core loop is tapping tiles, so it
happened on every single press.

The banner's job is to say sync is **stuck**, not that it is happening — a write
that lands in 40ms is not news. `useSustained` now gates it: nothing appears
until ops have been pending for 1.2s, and once shown it stays 900ms so a write
that drains just after the threshold cannot reintroduce the same flash.

Offline and signed-out still show immediately. Those are states you stay in
rather than blips, so the banner appears once and the list settles under it —
that is a single meaningful transition, not a jitter.

Verified both directions: the header now holds 49px with zero transitions across
a full tap, and with `/api/ops` hanging the banner appears at ~1.2s and stays.
The offline-banner end-to-end test still passes untouched.

## Four copy bugs fixed on the way past

"Lägg till 1 **varor**" and "1 **ändringar** väntar" now agree. Dash
placeholders for a missing amount were
removed — an ingredient with no quantity ("salt efter smak") renders an empty
column, because a dash looked like a parsed value. And the entry sheet's two
foot buttons were equal-weight side by side, separated by a hairline, which is
how "Ta bort" gets tapped by someone reaching for "Ändra mängd"; they are
stacked now, with only the destructive one coloured.
