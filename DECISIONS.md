# Away session, 2026-08-03 — voice, and the sweep behind it — read this first

Anders asked for an Alexa skill and for a sweep of what else was missing. Both
were done; the Alexa answer is not the one that was wanted, and that is the
first thing to read.

## Alexa cannot do what was asked, and this is verified rather than assumed

Two platform facts, both checked directly against Amazon's own documentation
rather than taken from an agent's summary:

**sv-SE is not an Alexa locale.** Custom skills support exactly 17 — ar-SA,
de-DE, en-AU/CA/GB/IN/US, es-ES/MX/US, fr-CA/FR, hi-IN, it-IT, ja-JP, nl-NL,
pt-BR. Amazon states it in the product name on amazon.se: "Echo Dot ...
International Version ... Swedish language not available". Putting Swedish words
in a custom slot does not rescue it either — the acoustic model is English and
transcribes Swedish phonemes into English words BEFORE slot resolution runs.

**The genuinely intuitive version was deleted.** "Alexa, add milk to the
shopping list", landing in Alexa's own list with our server subscribed to its
events, worked through the List Management REST API and List skills. Both were
switched off on 2024-07-01, killing writes AND event subscriptions. No
replacement has been announced. AnyList, the flagship integration, was forced
back to "Alexa, tell AnyList to add milk".

So the Alexa skill is English-only and needs an invocation name. It was built
anyway, because Anders reaffirmed the ask after hearing this. Home Assistant
carries the Swedish half, and that is the route worth actually using.

## What voice looks like now

One ingest core in `src/lib/voice/`, two thin adapters. Ops go through
`applyOpToDatabase` exactly as `/api/ops` does, so a spoken add is
indistinguishable downstream from a tapped one.

The load-bearing choice: matching goes through `matchIngredient` over
`loadMatchCandidates`, NOT the add bar's `resolveQuery`. Only the former
consults `catalog_item_aliases`, and aliases are the entire mechanism by which
an English word reaches a Swedish catalog. Using the other matcher would have
made the English path impossible while looking like poor speech recognition.

Nothing in the voice path creates a vara. The add bar already refuses to let a
fuzzy match decide a word is new; speech is far noisier and has no screen to
catch it on. Unmatched phrases are reported and spoken back.

Both routes mount before the Authelia gate — their callers are machines — and
each fails CLOSED when unconfigured. `/api/alexa` also checks the skill id,
which Amazon's verifiers deliberately do not: the signature proves a request
came from Amazon, not that it came from your skill.

## Two bugs that only a live database found

Worth remembering as a method, not just as fixes. Unit tests on pure functions
passed throughout; running real sentences against real data immediately produced:

- "add 2 liters of milk" put **2 st mjölk** — two PIECES of milk — on the list.
  English unit words are not in the Swedish parser, so the bare number parsed
  and the unit was discarded. Fixed in the voice layer, not in `lib/units`,
  which is the household's Swedish vocabulary and shared with the importer.
- "Alexa, add milk" made **"Alexa" the first shopping item**, because
  SEPARATORS splits on commas and nothing stripped the wake word.

## Three times a test caught something inspection had not

- Fixing `keepsPurchase` meant writing a round-trip test keyed by `OpKind`. It
  immediately found a SECOND stripped field: `catalog_items.hidden`, which has
  its own clock, its own columns and its own reducer branch. "Dölj den här
  varan" applied locally, never persisted, and never reached the other phone.
- My first fix for it reused `catalogItemSchema.omit({id:true}).partial()`. Zod
  fires a `.default()` THROUGH `.partial()`, so every rename would have asserted
  "and it is not hidden" and stamped the hidden clock — the moving-clock bug
  already paid for on note, amount, priority and the four product fields. The
  test failed; the schema was restructured.
- `purchasedQuantity` first read from `next`, and came back null. `loadStateSlice`
  deliberately loads NO contributions for a `remove_item` — the reducer resolves
  a removal on the entry row alone. Widening the slice would change what the
  reducer sees and what `persist` rewrites in order to serve a side effect, so
  it reads from the database at the side-effect boundary instead.

Also worth recording: the alias table's first generated pass proposed 41 aliases
that are literally Swedish vara names (lime, mango, salt, pasta, chips, bacon —
for many groceries the Swedish word IS the English word), and 6 that were too
generic ("chicken" on kycklingfilé, when hel kyckling exists). A test checks all
of it by execution. It also caught ME: I asserted "bread" should map to `bröd`,
and there is no plain `bröd` vara at all — only compounds. The data was right.

## Decisions taken without asking

- **`HOUSEHOLD_USERS` defaults to admitting everyone.** Failing closed would
  lock the household out of its own list on the next Watchtower pull, remotely,
  with SSH as the only fix. Production warns instead. **Anders must set this** —
  until he does, any Authelia account on the box can call `merge_catalog_items`.
- **Pinch-zoom re-enabled**, reversing `maximumScale: 1`. It was a flat WCAG
  1.4.4 failure on a 13px label read at arm's length in bad light, traded
  against an accidental zoom that takes two seconds to undo. Never argued in
  this log, so no recorded decision was overturned.
- **Scaled counts round UP with a floor of 1.** Half an egg is not purchasable,
  so the only question is which way to be wrong: one too many costs a krona, one
  too few means the dish cannot be made.
- **A duplicate recipe import returns the existing recipe** rather than an
  error. The household asked for this recipe; this recipe is what they get.
- **Deleting a recipe does not take its ingredients off any list.** They were
  added because someone wanted them. `remove_recipe` means the other thing.

## Still needs Anders

- Set `HOUSEHOLD_USERS`, `VOICE_INGEST_SECRET` and `VOICE_ACTOR` on the beelink.
- NPM location blocks for `/api/voice` and `/api/alexa` — both are in
  `docs/voice.md`, and neither endpoint works until Authelia stops fronting it.
- Home Assistant has no Swedish STT pipeline yet. Prototype Whisper (small or
  medium; tiny will not do Swedish grocery words) before buying satellites.
- Amazon developer account, `ask deploy`, and `ALEXA_SKILL_ID` in the
  environment. Leave the skill in Development stage: beta tests expire every 90
  days and cannot be extended.

## Not done, and why

The remaining sweep items are in `docs/superpowers/specs/` territory rather than
here: who-added-what (#26), the product/barcode lifecycle ops (#43/#44), the
scanner torch (#58), aisle navigation for /varor (#37), household-owned aisles
(#62) and seasonality (#63). None are bleeding. The two that WERE bleeding —
purchase quantities and scan attribution — are done, because their cost was
accruing daily and could never be backfilled.

Nothing is pushed. 16 commits on `feat/voice-ingest-and-quick-wins`.

# A merge keeps the recipe, 2026-08-02

The report: "I have a recipe, kycklingbröst in it. I add it to my list — 1200 g
kycklingbröstfilé, which isn't in my varor, so it lands as an Övrigt. I merge it
with kycklingfilé. The thing in my list then disappears. I remove the recipe and
add it again, and 1200 g kycklingbröstfilé appears again — so what I tried to do
wasn't performed at all."

Three defects, one story, and the 07-31 entry below fixed only the first of them.

## The merge kept the number and threw away who was asking

`mergeVaraOps` carried the loser's ask to the survivor as a `set_amount`, which
is to say as a MANUAL ask. The 1200 g survived and its provenance did not. On
screen that is a tile that stops saying "från recept" and a breakdown that stops
naming the recipe — but the expensive half is invisible: `remove_recipe` collects
by `recipeAdditionId`, so a share relabelled manual is a share the recipe can no
longer take back. Removing the recipe left its 1200 g standing on the survivor,
and adding the recipe again stacked a second 1200 g on top of it. One tile, 2400
g, nobody told.

**`repoint_recipe_item` is the fix, and it is a new op kind.** It moves one
recipe's share from one vara to another: upsert the destination entry, write the
share under `recipeContributionId(addition, to)`, drop the one under
`(addition, from)`. Two writes on two independent contribution clocks, payload
carried on the op the way `move_item` carries its own, so a long-offline
`add_recipe` arriving afterwards cannot re-create the share on the retired word.

**Re-issuing `add_recipe` with the items re-pointed was the cheap alternative,
and it is wrong.** `add_recipe` upserts an entry per item, so it would put every
ingredient of that recipe back on the list — including the ones already ticked
off in the shop.

**The manual half still does not merge, and that is unchanged.** If the survivor
already has a tile, its own amount stands: overwriting a number somebody is
looking at is worse than dropping one, and `set_amount` names an amount, it
cannot ask for one more. What changed is that the recipe shares now travel
regardless — they are separate contributions, so they land beside whatever the
standing tile says and the breakdown adds them up.

**A merge that carries both halves must not carry them twice.** The amount the
`set_amount` names is now built from the NON-recipe contributions only. Merging
the full total, as before, would send the recipe's 2 dl once inside the total and
once as its own share.

## The recipe line never learned which vara it meant

`recipe_ingredients.catalog_item_id` was written once, at import, and never
again. A line the matcher could not place was stored NULL and stayed NULL — so
`repointMergedCatalogItem`, which re-points recipe lines by `WHERE
catalog_item_id = fromItemId`, could never see it, and every add re-decided the
line from its raw text: slugify, then `create_catalog_item`. That op beats the
merge's tombstone on clock. The word the household had just retired came back to
life, on the list, beside the one they had merged it into.

**Two changes, and the first alone would have been enough to stop the bleeding.**
`resolveRecipeVaror` now resolves an unplaced line against the ALIASES first — a
merged-away word pointing at its survivor is exactly the household saying "that
word means this one now" — then against a vara the slug already names, and only
then invents one. Same order `ensureVara` follows, and for the same reasons.

**And the answer is now written down.** `PATCH /api/recipes/{id}/ingredients`
records what each line resolved to, once the add has actually landed. Only rows
still NULL are filled, so it can never re-aim a line a later import or a merge
has already corrected, and an id naming a vara that does not exist is skipped
rather than 500ing on the foreign key — the vara is usually one the client
created moments ago, and a create that has not landed must leave the line where
it was. A failure is swallowed: the shopping is already on the list, and losing
the mapping costs exactly what the old behaviour cost.

**Aliases were only ever read at import time.** That is worth stating plainly,
because the alias's own comment says it exists "so old recipe lines go on
resolving" and it was doing so only for recipes imported AFTER the merge. Typing
a merged-away word into the add bar still re-creates it; that path is untouched
here and is the next thing to fix.

## What was verified

The failing story was reproduced end to end against the real reducer, the real
`applyOpToDatabase` and the real snapshot loader before anything was changed —
including the 2400 g stacking, which nobody had reported yet. The e2e that now
guards it fails on the pre-fix code at exactly the point the provenance
disappears, checked by stashing the source and running it.

# The scan works in a shop now, 2026-08-01

Anders asked for a walkthrough of this log against what he actually wanted from
Recipus. Four things came out of it, and the first one was that the log was
wrong about the second.

**This file was in the wrong order and now is not.** Six of the newest entries —
every one of them from real shop use — had been appended at the BOTTOM, below the
2026-07-29 material, while the file opened with "read this first". Four separate
entries claimed that phrase. They are chronological now, newest first, and only
the top one makes the claim. Nothing was rewritten; the sections were moved.

## The deploy had been red for four hours

Eleven commits were sitting on `master` undeployed, so the phone in the shop was
still running the settings-screen build and still had every bug the 07-31
entries below say were fixed — the merge that loses the shopping, the press that
acts through the sheet, the undo that expires before you notice.

The cause is worth more than the fix. Two e2e tests read `textContent` to
identify an aisle chip and a tile. `ItemIcon` falls back to the **system emoji as
a real text node** whenever the OpenMoji sprite is missing, and it is always
missing in CI: the sprite is gitignored and only `pnpm icons:build` writes it,
which the e2e job does not run. So the assertions read `Bröd` on a laptop and
`🍞Bröd` on the runner. Green locally, red on the only machine that deploys.

`accessibleText` in the fixtures drops `aria-hidden` subtrees before reading, the
way the browser itself does when computing an accessible name — so those tests
now assert the string a screen reader gets rather than the artwork beside it.
**Verified by moving the sprite aside and running the whole suite that way**,
which is the only honest way to check a CI-only failure and takes ten seconds.

Worth keeping as a habit: this suite's e2e assertions run against a rendering
the developer never sees.

## Three things were built, unwired, and documented as done

The scan path is the headline, and finding it took reading comments rather than
code. Every piece of an offline scan already existed and each one carried a
comment describing the job it was not doing:

- `SyncState.barcodes` — *"the local EAN map the design doc promised (and which
  never existed) is simply `barcodes` below"*. Hydrated on every load. Read by
  nothing.
- `create_product` / `link_barcode` — *"unknown barcodes are created in a shop,
  offline… only the outbox can fix that"*. Dispatched by nothing.
- `autoMapProductName`, threshold argued down to 0.8 against real product names.
  Zero callers.
- `PUT /api/barcode/{ean}` — *"after this, scanning it resolves instantly and
  offline from the local map"*. Nothing resolved from the local map.

`handleScan` was a bare `fetch`, server-first. Offline every scan died in a
catch, **including a barcode the household had already answered for**. In buy
mode that is a lost purchase, which is precisely the failure the
registry-in-the-op-log decision was taken to prevent.

**The ordering is the whole feature.** An unknown barcode is now *written* —
`create_product` then `link_barcode`, through the outbox — **before** anything is
fetched. Fetch-then-write is what dropped the scan; write-then-fetch cannot. The
lookup that follows is bounded at 2.5s, the same budget and the same argument as
the service worker's navigations: offline, a fetch fails on connection setup in
milliseconds, so the timeout only bites on a flaky signal.

`resolveScan` is pure and answers from state alone. A confident name auto-maps at
0.8 and the scan completes with no question asked; anything less opens
`/varor`'s own place sheet, so a placement made at a till and one made at the
kitchen table are the same event on every other device.

**It also closes the phantom purchase written down the night before.** A product
pointing at a merged-away vara used to fall back to the name "Varan" and record a
purchase against the tombstone. It now takes the same route as an unplaced
product and asks. The note below guessed the fix would be to *refuse* the scan;
having built it, refusing is worse — it leaves somebody at a till holding an item
the app will not take. Asking turns a dead end into the one action that repairs
it, and it cannot invent a purchase either way.

## "The one flow this repo cannot test" was half true

That claim, made twice below, rests on headless Chromium having no camera. True
of the decoder and false of everything downstream: **with no camera the scanner
falls back to a barcode field**, and every line that decides what a scan MEANS
sits after that field. Four e2e tests now cover an unknown code scanned offline,
a known one resolving with the server dead, a placement completing a buy, and a
dismissal recording nothing.

One of them asserts the **Postgres row** rather than the outbox draining, and
that distinction is worth carrying to the next test: a refused op is retried a
bounded number of times and then dropped, which empties the outbox in exactly the
same way success does. "The outbox is empty" is not "the server accepted it".

What is still untested is `createDetector` and the frame loop — a much smaller
and much more honest gap than "the scanner is untestable".

## Live sharing had never been tested at all

The design doc asks for "two browser contexts editing one list to prove live
sharing works". It did not exist, which left the one feature the decision table
calls *"the feature that makes Bring worth using"* as the only headline feature
with no end-to-end proof. The reducer's convergence is tested to exhaustion and
none of that says the stream is attached, that the fan-out picks the right
listeners, or that a client applies what arrives.

A second `BrowserContext`, not a second tab — separate IndexedDB, so it is two
devices rather than one talking to itself through a shared store. Both
directions, because "my optimistic write, later confirmed" and "somebody else's
write, arriving cold" are different paths from either client's side. The stream
is the only thing that can carry it: there is no `setInterval` in the client, and
catch-up runs on reconnect and `visibilitychange`, neither of which an idle
visible page fires.

## `/statistik`, and the debt it admits to

The roster decision was taken a week ago — derive it from `autheliaUser`, which
is already on every op and every purchase row — and the screen that was its only
consumer was never built. `users` is still not read, deliberately: a second
roster can disagree with the first, and a missing row would read as "this person
bought nothing".

Every count attributes through `effectiveCatalogItemId`. That is the entire risk
in the module: a scan writes `{null, product}` and no vara, so a query reading
`purchases.catalog_item_id` returns a **believable** number that silently omits
every purchase made with the camera. The DB test pins exactly that shape — three
purchases of one vara, two taps and one scan — because the wrong answer is two
and two looks fine.

No charts, no spend, no consumption rates: the spec's own out-of-scope list. A
bar chart of four numbers is decoration, and this app has never known a price.

The unplaced-purchase count is on the screen rather than quietly dropped. The
spec calls the review queue "the thing that makes the numbers true rather than
cosmetic tidying", and the screen showing the numbers is where that is worth an
interruption.

Reached from settings, not a fourth header icon. This log has been round that
loop once already: the fix for "nobody can find the registry" was not "advertise
everything everywhere".

## Small

`displayName` capitalises the Authelia username — Anders's call, and he did not
much care which way. The assumption that a username is a first name is stated in
one pure function, which is the point of it being one; `svc-backup` becomes
`Svc-backup`, which is wrong and harmless.

## Left undone

- **The catalog seed.** `gröt` is still absent (only `grötris` and
  `grötpulver`). Deferred on purpose: Anders wants a separate pass over seeding,
  probably importing from Bring.
- **A merge still re-points the open list only**, and `deletionBlockers` still
  reads the same partial state — both unchanged from the entry below.
- **The undo strip still holds only the most recent removal.**
- **The wire-schema test still covers `move_item` and the registry ops only.**
- **`sourceKind: "scan"` is still never produced**, so the entry sheet's
  "Skannad" label stays dead — and the scan path now has an obvious place to
  produce it, if it is ever worth the op field.

---

# One phantom-purchase path left open, deliberately, 2026-07-31

The stand-in guard sits in `list-screen`'s `remove`, which every removal on that
screen goes through. **The scanner does not go through it.** `handleScan` in
`list-client.tsx` calls `actions.removeItem(catalogItemId, true)` directly, and it
does not care whether `state.catalog[catalogItemId]` exists — it falls back to the
name "Varan" and carries on. So scanning a barcode whose product still points at a
tombstoned vara records a purchase against that tombstone, exactly as tapping one
used to.

**It is hard to reach and it is not impossible.** A merge re-points every product
on the losing vara (`mergeVaraOps` is handed `openVara.products`), and a delete is
refused outright while any product still hangs off the word — so both ordinary
routes close it. What is left is a product mapped to that vara from another device
during the merge, or one that arrived after the sheet read its list. Narrow, and
the same shape as the bug that reached production, which is why it is written down
rather than left to be rediscovered.

**Not fixed here, and the reason is the reason to be careful about it.** The
scanner is the one flow this repo cannot test: there is no camera in headless
Chromium, so `pnpm test:e2e` never exercises the happy path at all. Changing the
buy branch means shipping an unverifiable change to the flow where a mistake costs
a real purchase in a real shop. The honest fix is probably to refuse the scan when
the vara is unknown rather than to silently downgrade it to a removal — a scan
that cannot say what it bought should say so — but that is a decision about what
happens in front of a till, and it wants a person who can hold a phone.

---

# What the merge review found, 2026-07-31

The merge work above was reviewed adversarially before anyone shipped on it, and
four defects came back. All four had the same shape, which is the useful part:
**the ops were right and what the device knew when it built them was not.** The
convergence claim — only pre-existing op kinds, so nothing new races anything —
survived every attack, including two devices merging in opposite directions, a
long-offline `add_item` landing after the tombstone, and the server's re-pointing
racing the client's. Worth separating those two things when reading this code:
the op log is sound; the plan is only as good as the state the planner can see.

Three of the four are fixed in the commit above. Two limits are left standing on
purpose, and they are here rather than buried in a comment because both can
surprise somebody.

**A merge re-points the open list only.** The store holds one list — the snapshot
selects `list_entries` by `list_id`, catch-up filters ops the same way, and
`applySnapshot` rebuilds from empty — so a vara sitting on Hemköp *and* Ica has
only its Hemköp entry within reach when you merge from `/varor?list=hemkop`. Ica
keeps the orphan. That is no worse than the state the reducer has always allowed
and it is now visible: it draws as a stand-in tile and one tap clears it. Fixing
it properly means either loading every list's entries into the client, or moving
the re-pointing server-side — and the latter is exactly the row-rewriting the
merge case forbids, so it is not a small change and it is not obviously right.

The same blind spot pre-dates the merge work and is worth knowing: `deletionBlockers`
reads the same partial `state.entries`, so **"Ta bort" is offered for a vara that
is live on another list.**

**A merge's `set_amount` can lose a concurrent quantity.** The rule "if the
survivor is already on the list, its own tile wins" is true only of tiles the
merging device has already seen. A partner adding `vitlök 3 st` from a phone with
no signal, seconds before you merge `vitlöksklyfta` into `vitlök`, loses their 3
st to the merge's `set_amount` on a strictly later clock. Both devices settle on
the same number, so this is a lost update rather than a divergence — the same
class of trade `move_item` already makes and documents, and for the same reason:
the alternative is a read-modify-write that cannot be order-independent.

**And one process note.** The bag glyph was reported shipped, and had been added
to `ui-icon.tsx` and used in zero files — in the same entry whose whole subject
was a decision written and not implemented. It is invisible to lint, because an
unused entry in an icon map is not an unused variable, and invisible to the
tests. Screenshots caught it. This is the third time in this log that the
intended end state got written down as the shipped state; if there is one habit
worth taking from tonight, it is `grep` for the thing you claim to have wired.

---

# The shop's layout became the household's to state, 2026-07-31

`lists.category_order` has been per-list since the first migration — Hemköp and
Bauhaus share the household's vocabulary and nothing about their layout — and
nothing in the app could ever change it. Every list walked in seed order. That
falls hardest on exactly the varor a household invents, because the add bar files
anything new under Övrigt and Övrigt sorts last: taking the supported path put
your own words at the wrong end of the shop, permanently.

**Two settings that look alike and are not**, which is why they are labelled
apart. The *order* is a fact about a shop, so it stays on the list, rides the
`update_list` op that already existed, and reaches every phone — one person
getting it right is worth having. The *view* — aisle headings or one long grid —
is a fact about a person, so it is device-local like the shop mode, because
syncing it would let one member of the household silently restyle the other's
screen mid-shop.

**No migration, no new op kind, no reducer change.** That was the point of
splitting it that way: the sync core is where a regression is least visible and
most expensive, and this feature did not need to touch it.

**Flat is not unordered.** The grouped view got its sequence from
`groupByCategory` and the flat view had no aisle sort at all, so turning headings
off used to leave the tiles in whatever order the entry map produced. Both views
now sort by walking order first and urgency second — urgency rises *within* an
aisle and never out of it, which is the rule the priority sort already followed
for the reason that not walking back across the shop beats every other signal.

**Up and down buttons, not a drag handle.** Dragging inside a sheet that itself
scrolls vertically is a fight on a touchscreen, and it has no keyboard equivalent
at all — which is the same hole the long-press tier had until this week.

**A bug fell out of it.** The list screen read `snapshot.list` and nothing else,
which was fine while a list's only editable fact was its name. Re-ordering the
aisles did nothing visible until a reload, and a partner's re-order arriving over
SSE was applied to the store and never drawn. It reads the store now, and falls
back to the snapshot only for the first paint and the offline shell.

---

# Undo stopped expiring, 2026-07-31

An in-store audit found the app doing the one thing `use-mode.ts` promises it
cannot: *"you under-record purchases, you never invent one."*

**A mis-tap in buy mode wrote a purchase that never happened, permanently.** Tick
something from a later aisle — which is what mid-shop looks like — and the only
"Ångra" rendered **702px above the viewport**, most of a screen out of sight, and
was gone after eight seconds. So the shopper does the obvious thing and finds the
item in the catalog and taps it back on. That restores the item and not the truth:
`add_item` only retracts a purchase when handed `undoesClientOpId`, which only
`undoLastBuy` ever passes. The row stands and the cadence engine learns from it.

**So there is no timer.** A timer on an undo whose entire job is to catch a
mistake you have not noticed yet expires exactly when it is needed. The offer
stands until it is used, replaced by the next removal, or dismissed — and it names
the item, so a stale one is ignorable rather than confusing.

**It is in the thumb arc, and it is not the toast that was removed.** That one sat
bottom-centre *on top of* the entry sheet's own buttons, so the confirmation for
tap three covered the control you wanted for tap four. This sits at z-30, under
every sheet's z-50 backdrop, where it cannot cover a control in the one situation
that mattered; and it clears the scan button rather than layering under it,
because a 44px target half-covered by a 56px circle is a 44px target you miss.

**Rejected: making a catalog re-add retract the purchase.** It is what people
actually do, and the audit suggested it — but it cannot tell "I mis-tapped" from
"I need another one", and inventing a retraction is the same class of error as
inventing a purchase. **Known residual:** the strip holds only the most recent
removal, so a mis-tap noticed five taps later is still unreachable.

---

# The press was acting on what it opened, 2026-07-31

Also reported from production, and described as *"long pressing something,
changing something, then pressing out of the dialog modifies the thing behind it
— marking something bought while I just wanted to get out of the popover."*

**A touchscreen hit-tests the click a touch synthesizes at the finger's position
when it LIFTS**, not where it went down. Every sheet in this app is opened by a
500ms hold, so by the time the finger comes up the sheet has mounted underneath
it — and the press delivers one final click into a surface that did not exist when
it began, aimed at whatever control now happens to sit under that thumb. Where it
landed was pure geometry: near the top of the page it hit the backdrop, so the
entry sheet opened and shut inside its own opening gesture; lower down it hit the
action row, so the gesture meant to *open* the breakdown quietly took the item off
the list.

**This is only reproducible with real touch events**, which is why the suite never
caught it. `page.mouse` dispatches its click to the nearest common ancestor of
where the button went down and came up, which after a sheet opens is a container
that does nothing. Every long-press test in the suite used the mouse. There is a
`longPressTile` helper in the fixtures now and a note saying why.

**A sheet ignores pointer input until it has seen a `pointerdown` of its own.** A
latch rather than a time window: the stray click is by construction the only one
that can reach a freshly-mounted sheet with no pointerdown in front of it, and a
window would have been a guess about how long a thumb takes to lift. Dismissal
also now requires the click to be on the backdrop *itself*, so dragging a finger
while reading the breakdown and releasing outside no longer throws you out.

---

# A merge left the shopping behind, 2026-07-31

Reported from a real shop: a recipe from ICA put *kycklingbröstfilé* on the list,
it was merged into plain *kycklingbröst*, and the meat vanished. Adding the recipe
again produced "a new line of the other one", and the two went double.

**One fault, two symptoms.** `merge_catalog_items` refuses to rewrite entry rows,
and that refusal is right — a merge that rewrote rows does not converge, which the
reducer argues at length and a test pins down. But nothing else moved them either.
The products were re-pointed by the sheet, and purchases, recipe ingredients and
aliases by a server-side effect; the list entry was the one thing with no owner.
So it stayed live on a vara the catalog no longer had, and the screen can only
draw an entry it can look up. The row therefore neither stayed nor went: live,
undrawable, unreachable by any gesture, and beyond pruning too, because pruning
collects entries by `removed_at` and an orphan has none. Re-adding the recipe then
resolved to the survivor — the server had re-pointed `recipe_ingredients` — and
built a second entry beside the invisible one.

**The design comment said "visible, manually fixable". It was neither**, and that
gap between what was written and what shipped is the whole lesson here. It is the
second time on this screen: the bag glyph above was decided and not shipped for
months.

**The fix re-points the shopping the same way the products were.** `mergeVaraOps`
is pure and lives beside the rest of the registry model so the arguable cases can
be asserted rather than clicked through. It uses only op kinds that already exist,
which is what keeps convergence untouched and lets a phone on an older build
understand every op it receives. Three calls in it are worth disagreeing with:

*What travels is what the tile was showing* — the merged total, the sort, the
urgency — and **not** the provenance. The amount arrives as a manual contribution,
so "Behövs till: Vitlöksstekt kyckling" is lost. A contribution is keyed to a
recipe addition and rehoming one would drag a recipe's own bookkeeping across;
`move_item` already makes exactly this trade and says so.

*If the survivor is already on the list, its own tile wins* and the loser's entry
is simply removed. Summing them would be the intuitive answer and `set_amount`
cannot express it — it names an amount, it cannot ask for one more — and
overwriting a number somebody is looking at is worse than leaving it alone.

*Two unit families carry nothing.* "2 dl" and "3 st" cannot be summed honestly, so
rather than picking one and calling it the answer, the survivor gets no amount.

**`tileVaror` is the net under all of it.** Orphans stay legitimate — the reducer
deliberately allows a long-offline `add_item` to land after a merge — so a live
entry whose vara is missing now renders a stand-in tile instead of a hole. Its
name is the entry's own id with the hyphens opened out, because the row that knew
the pretty spelling is precisely what is gone. It looks odd on purpose. One tap
removes it, which is all it is for, and it is what finally makes the orphans
already sitting in production reachable.

---

# Varor says what it is, 2026-07-31

Three hundred and forty-six things, drawn with the same art and carrying the
same names, appear on two screens and do opposite things. On the list they are
tiles and a tap **buys** one. On `/varor` they are rows and a tap opens renaming,
re-filing, splitting, merging and deleting. Neither screen said which was which.
`/varor`'s only words about itself were "ALLA VAROR — 346".

**The bag was decided and never shipped.** The note under "Two smaller ones"
already reached the conclusion — *a bag reads as goods rather than as a layout* —
and `list-screen.tsx` quotes that sentence in a comment while rendering
`allAisles`, which is `LayoutGrid`. So one drawing was carrying three meanings:
"every aisle at once" in the rail, "which aisle is this filed under" in the
sheets, and "the household's goods" on the doors into the registry — and the
meaning it carried worst was the screen nobody could find. The bag now exists as
`UiIcon name="registry"` (lucide `ShoppingBag`), which puts `allAisles` back to
meaning only aisles; both of its remaining uses are aisle uses and stay as they
are.

**A subhead, because the screen could not be worked out by trying it.** *"Era
egna ord för allt ni brukar köpa — vad de heter, hur de ser ut och var de står.
Inget läggs på listan härifrån."* The second sentence is the one that earns its
place. Everything else here is discoverable by poking at it, and poking at it is
precisely what nobody dares do while they suspect a tap might put ananas on
tonight's shopping. It sits above the sync banner: it is what the screen IS,
rather than how it is feeling today.

**The row says its verb now, and it is still the whole row.** Shrinking the tap
target to the glyph at the end was the obvious suggestion and it is the wrong
trade. The question here is not "where do I tap" but "what happens when I do",
and a 16px target answers the wrong one — while a mis-tap on this screen is
cheap and reversible (a sheet opens; you close it), which is exactly what a
mis-tap on the list is not. That asymmetry argues for keeping the row big and
making the verb loud. So the mark at its end is a pencil rather than a chevron:
the chevron is honest — this does open a detail — but it is the app's most
neutral mark, and neutrality is what failed. A visually-hidden "Ändra" leads the
row's accessible name, because the pencil is `aria-hidden` decoration and would
otherwise state the promise only to people who can see it.

## Verified

`tsc` and `eslint` clean, 579 unit tests, and the nine `varor.spec.ts` e2e tests
pass with the row untouched as a target — which is itself the evidence, since
those specs click a row in its middle to reach the sheet. Two assertions added
rather than changed: that the screen says what it is on arrival, and that a row's
accessible name begins with the verb.

## Left undone

There is a third door into the registry, in `entry-sheet.tsx` — "Om ananas —
kategori, produkter" — and it is still drawn with `allAisles`. It belongs to
another file in flight and wants the bag for the same reason the other two do.

---

---

# Settings and "what is actually running", 2026-07-31

The household's initials sat in the header as the one thing you could not press,
and the screen that answers "which build is this phone running" did not exist.
Both fixed, following longhaul rather than inventing a second way to do it.

## The version chain is longhaul's, deliberately

`src/lib/version.ts` is the same shape as longhaul's, down to the dev fallback,
because the two projects share a stack and a deploy pipeline and answering this
question differently would mean learning it twice. The chain:

- **`.github/workflows/deploy.yml`** computes a UTC timestamp and passes it with
  `github.sha` as docker build-args.
- **`Dockerfile`** takes them as `ARG` in the runner stage and bakes them to
  `RECIPUS_GIT_SHA` / `RECIPUS_BUILD_TIME`.
- **`getBuildInfo()`** reads the env; unset means dev, so it shells out to
  `git rev-parse HEAD` and flags `isDev`.

The env round trip is not ceremony: `.dockerignore` keeps `.git` out of the
image, so the container has no repo to ask. That distinction is the whole point
of the file — "which commit is the shop running" is a question you ask when
something looks wrong on a phone in a supermarket, and an answer that quietly
meant "whatever is checked out on my laptop" would be worse than none.

Watchtower makes it sharper still: the answer changes without anyone doing
anything. So the page is `force-dynamic` — a version banner served from the
service worker's cache would lie exactly when it matters.

## Swedish route, against longhaul

Longhaul uses `/settings`. This app's routes are `/varor` and `/recept`, so it
gets `/installningar`. Consistency inside the app someone is looking at beats
consistency with a sibling repo; the UI text is Swedish in both.

## What the screen actually holds

No invented settings. Who you are signed in as, the version block, and one real
preference: putting the long-press tip back. `useOnce` gained `restore` for it,
because "once ever" with no way back means a phone that dismissed the tip by
accident has permanently lost the only thing advertising a gesture nothing else
mentions.

Verified in the UI: the dev fallback showed `96b9ceab85e2` flagged as
utvecklingsläge, linked to the right commit on GitHub, "Byggd: okänd" as it
should be with no CI stamp, and the tip toggle round-tripped localStorage.

---

---

# Fewer taps, 2026-07-31 (later)

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

---

# Away session, 2026-07-30 (evening)

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

---

# Hardening session, 2026-07-30

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

---

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

## Två sorter av samma vara

Reported from real use, and worth quoting because the report contains its own
diagnosis: *"I have blåbär mogna on the list. Now I want to add also blåbär. I
get a question about if it is mogna?, I press no. What I mean is that I want both
mogna blåbär and blåbär in the list. I end up with just blåbär — the mogna
version disappeared. This is just bad and/or bug?"*

Both. It is a bug in the sense that data the household entered was destroyed with
no warning, and it is bad in the deeper sense that **the app had no way to
represent what was being asked for**. A list entry's id is
`(listId, catalogItemId)`, so one vara appears at most once per list, and a sort
("mogna") lives on that entry's manual contribution. "Blueberries" and "ripe
blueberries" therefore could not coexist. `DuplicateAskSheet` offered two
answers, and the second one — "Nej, vanlig blåbär" — could only clear the
qualifier, because clearing it was the only thing the model could do.

The answer was already written down. `Contribution.modifier`'s own comment said
it: *"when the household genuinely wants ripe mango tracked as its own thing with
its own cadence, that is the registry's split"*. What was missing was any way to
reach that split from where the question actually comes up. So the sheet now has
three answers, and the middle one is the split — reached from the add bar, and
from the entry sheet's "Gör «mogna» till en egen vara" for the same realisation
arrived at later.

### What travels, and what does not

Only the **manual** ask moves to the new vara: its amount and its urgency. A
recipe's share stays on the original and has to — the recipe asked for blåbär,
not for the ripe ones, and moving its contribution would make its own breakdown a
lie. Same line `move_item` already draws, for the same reason.

The plan lives in `splitSortOps` (`src/components/list-model.ts`), pure and
ordered, next to `mergeVaraOps` and for the same reason: the cases worth arguing
about do not reproduce reliably in a browser. One of them is load-bearing and
invisible in a list of ops — **the original's manual contribution is cleared
BEFORE the entry is removed**. `remove_item` tombstones the entry and leaves
contributions exactly where they are, so emitting the removal first means
re-adding plain blåbär next month resurrects "2 kg mogna" on it: the very ghost
this change exists to remove, reintroduced by the fix for it. There is a test
that re-adds and asserts the entry comes back empty.

### Hiding, which is the other half

Splitting is now one gesture from three screens, which makes the catalog easy to
grow — and a catalog that only grows makes every later search worse. "Mogna
blåbär" was worth a vara in March and is clutter in July, and the app cannot know
which.

So `CatalogItem.hidden`, with its own last-write-wins clock
(`drizzle/0006_hidden_varor.sql`, `CATALOG_FIELDS` gains a fifth entry).
Deliberately **not** the soft delete sitting next to it: `deleted_at` means "we
do not buy this", is refused while the vara is on a list or carries products, and
turns a live tile into a stand-in. Hiding makes no claim about the thing at all,
so it has no blockers and no side effects, and `/varor` still lists it with a
"dold" chip and a switch to undo.

The migration is hand-written for one reason, and it is the clock rather than the
flag: `drizzle-kit` would default `hidden_updated_at` to `now()`, stamping every
vara in the catalog with the deploy's timestamp — so a genuine "dölj den här"
made on a phone that was offline yesterday would arrive OLDER than a fact nobody
ever asserted, and lose. It is backfilled from the row clock instead, and
`upgrade-path.test.ts` asserts exactly that.

Search **demotes** hidden varor rather than dropping them, and that is what keeps
hiding from being a one-way door. Filtering would mean typing the exact name of
something you hid returns nothing, the add bar offers to CREATE it, and the
household ends up with a second vara under the same word while the first one's
purchase history is stranded. Picking a hidden row un-hides it — reaching for a
vara by name is asking for it back.

## Three smaller things from the same report

**"Broccoli tillagd", when broccoli was already on the list.** The add bar's
confirmation strip built its label as `${name} tillagd` unconditionally, so the
most common no-op in the app — searching for something already listed and
pressing it — reported a success that had not happened, on the same strip that
carries undo. A confirmation you cannot distinguish from a no-op teaches people
to stop reading it. It now says what actually changed ("mängd 2 l", "sort
mogna", "visas igen") or "står redan på listan" with no Ångra, plus the way out
of the dead end: hold the row for a second sort.

**"Behövs till → Tillagd".** Reported as literally incomprehensible, and it was:
a heading promising a recipe, above a row that named no recipe, on every ordinary
item on the list. The section now appears only when there is genuinely a
breakdown — two contributions, or a recipe — and reads "Därför står den här",
with sources named rather than acts ("Du la till den", "Skannad i butiken").

**Long-press did not exist in search results.** It opened the details sheet from
a catalog tile and from "Vanligast", and did nothing on a search row two pixels
below them. That is the one surface where it matters most: anything already on
the list is filtered out of the well and the frequent grid, so typing is the ONLY
way back to it — and "I already have broccoli, I want the frozen ones too" was
therefore unreachable by construction. The gesture moved into `useLongPress`
rather than being copied.

## Enter finishes a sheet

Every field in every sheet committed on Enter and blurred, which left the
keyboard able to fill a sheet in and not to submit it — you reached for the mouse
for the last step of every one. `useFocusTrap` now takes an optional primary
action, so Enter with no field holding it does the affirmative thing: type "12",
Tab, type "fryst", Enter, Enter.

It is in the focus trap rather than in each sheet because that is the only place
that knows where focus went after the blur — which is `<body>`, outside the
dialog. Treating body as "inside" is what makes type-Enter-Enter work at all.

One measured bug on the way, and it is the reason the contract is explicit: the
trap listens on `window`, so it runs AFTER React has bubbled the event through
the sheet — by which time the field has already committed and blurred. A single
Enter therefore did both jobs, and the second Enter the user was about to press
would have done something else entirely. Fields now `preventDefault` to claim the
keypress and the trap skips an already-handled Enter.

Given only to sheets that ask one question with one answer. A sheet that is a
menu of equals — the entry breakdown, the vara sheet, the three-way sort question
— gets nothing, because Enter picking one of five buttons for you is how a
keypress ends up removing something.

## A test that had been silently skipping itself

`upgrade-path.test.ts` returns early when nothing is pending since
`DEPLOYED_THROUGH`, which was every run between 0005 shipping and 0006 landing.
When it finally ran again it failed on its own fixture: the vara insert omitted
the four `*_updated_by` columns 0003 had made NOT NULL, the purchase omitted
`client_op_id`, and the barcode was still written in its pre-0005 shape — a
database state 0005 had restructured away. The fixture had never been moved when
the constant was bumped. Fixed, and it now guards the 0006 backfill it was
skipped past.

## An audit's findings, triaged

A read-only sweep of the screens the sort work did not touch. Three of six
findings survived checking; the other three are recorded here because the
reasons they were rejected are the interesting part.

**Taken: `role="alert"` was missing from two copies of one pattern.**
`recipe-import.tsx` wraps its failure card in an always-mounted live region,
with a comment explaining that a flip from "loading" to "error" is otherwise
completely silent — nothing is focused, so nothing announces. That exact
loading/error/ready block was then copied into `recipe-list.tsx` and
`recipe-detail.tsx` without it. A bug class this codebase had already found and
fixed once, unfixed in both copies.

**Taken: "Har alltid hemma" never said what it does.** Its only effect is on a
screen it does not mention — a recipe leaves the vara off the list by default —
and the label reads as a note to self. Now carries a line saying so, using the
`hint` the "Dold" switch beside it introduced. Same complaint as "Behövs till →
Tillagd", one screen over.

**Rejected: "give the merge sheet Enter-to-pick-top-match, like its siblings".**
The inconsistency is real and the fix is backwards. `varor-place-sheet` can
afford Enter because placing a product is reversible and says so in its own
comment; merging tombstones a vara, re-points its products and carries its
shopping across, and its rows commit on a single tap with **no confirmation
step**. Binding that to a keystroke is precisely what the sheets' Enter contract
exists to prevent — "a menu of equals gets no primary, because Enter picking one
of five buttons for you is how a keypress ends up removing something". Merge
keeps Escape and nothing else.

**Rejected: "recipe import creates varor with no review".** It does not.
`recipe-detail.tsx` computes `pendingCreates` but dispatches nothing; the sheet
draws each unmatched ingredient as a row badged NY VARA, every row can be
switched off, and `handleConfirm` filters the creates to `usedIds` — so
excluding a row creates no vara at all. The review is there and is per
ingredient.

**Rejected: "fold `recipe-add-sheet` into `<Sheet>`".** The shared contract is
`useFocusTrap`, and both full-bleed modals use it — that is the seam. `Sheet` is
a bottom sheet carrying the hard-won latch that ignores the stray click a
long-press synthesizes, and giving it a full-bleed mode would mean maintaining
that fix through a branch that never needs it.

---

# Putting it back within half an hour takes the purchase with it, 2026-08-02

**This reverses the rejection recorded above.** That entry said:

> **Rejected: making a catalog re-add retract the purchase.** It is what people
> actually do, and the audit suggested it — but it cannot tell "I mis-tapped"
> from "I need another one", and inventing a retraction is the same class of
> error as inventing a purchase. **Known residual:** the strip holds only the
> most recent removal, so a mis-tap noticed five taps later is still unreachable.

**The objection is still true and is still not answered.** Nothing can tell the
two apart. What changed is that the residual was measured rather than assumed:
three buy-mode taps and the strip offers only the third, so the repair anybody
actually makes — tapping the vara back on out of the catalog — left a purchase
that never happened standing in the one table this app never prunes, with
`use_count` bumped and `last_used_at` moved. That is the sole input to the
cadence engine and to `/statistik`.

So it is a choice between two wrongs, and the app already has a stated
preference: `use-mode.ts:20` — "you under-record purchases, you never invent
one". Retracting on a re-add errs to the same side. Inside half an hour the
mis-tap reading is the likelier of the two by a wide margin, and outside it
nothing happens at all.

**The cost, stated plainly.** Buy bananas, decide within the half hour that you
want more, put them back on the list, and that purchase is gone from the
history. A recipe added on the way home that wants something just bought does
the same. Both under-record. Neither invents.

**Half an hour, not the 90 minutes `modeAfterIdle` already computes.** A first
attempt reused that window because sharing the constant looked like consistency.
It is not: `modeAfterIdle` answers "are you still in a shop", and you can be
forty minutes into a shop and genuinely want a second carton. Two questions, two
constants. Thirty minutes is a judgement about a mis-tap on a 92px tile noticed
a few taps later, not a measurement.

**Two conditions, and only two.** The vara had actually left the list, and there
is a purchase of it on this list inside the window. The first is what makes
"add" mean "add BACK": `add_item` is also fired by setting an amount through the
duplicate sheet and by a recipe topping up something already on the list, and
without it your partner re-adding mjölk over SSE and you then setting "2 l"
would delete a genuine purchase for an item that never went anywhere.

**Deliberately not conditioned on who, or on which device.** An earlier attempt
kept a token in the buying phone's `localStorage`, which meant the partner at
home could not fix a mis-tap they could plainly see, and made the repair depend
on which handset you happened to be holding. The household shops as one. The
server is the only place that knows about a purchase both phones can see, so the
rule lives there and the token store is gone.

**Scanning is the one exception.** `add_and_buy` sets `keepsPurchase`, because a
scan asserts the product is in your hand — scanning the same vara twice is two
bottles, and without the opt-out the add half would take back the first a moment
before the remove half wrote the second, leaving one where there were two.

Six tests. Four fail without the rule; the other two — the 31-minute case and
the scan exemption — pass either way and are regression guards rather than
evidence for the change.
