# Decisions & gotchas — autonomous build session, 2026-07-29

Running log kept while you were away. Read this first.

---

## Decisions I made without asking

**1. List entry ids are derived, not generated.** `entryId(listId, catalogItemId)`
rather than a UUID. Two phones offline in different shops both adding milk cannot
coordinate on a random id, so deriving it makes those two adds literally the same
operation and the sync reducer converges with no special case. Same trick for
recipe contributions. This is the single most load-bearing decision in the data
model.

**2. Removal is a tombstone, not a delete.** A hard delete would let a stale
`add_item` from a phone that was offline silently resurrect something you already
bought. Tombstones are pruned at 30 days along with the op log.

**3. "Bought" vs "changed my mind" are different removals.** Tapping an item off
the list logs a purchase; the long-press "ta bort — köpte inte" does not. Without
this the cadence engine slowly learns nonsense from every abandoned item.

**4. Catalog icons are emoji codepoints, not image files.** `iconRef` stores e.g.
`"1F95B"`. The app renders the system emoji today and can render an OpenMoji
sprite once `pnpm icons:build` exists, with no data migration. Keeps the swap to
custom art you mentioned as a later option genuinely cheap.

**5. Service worker is offline-FIRST, inverting longhaul's posture.** longhaul
caches nothing but an error page because stale health data is worse than none. A
shopping list is the opposite, so the shell is cached and navigations are served
from cache with background revalidation. The app opens instantly in a shop
basement.

**6. The SW deliberately refuses to cache an Authelia redirect as the app shell.**
It checks for a real same-origin HTML response before caching. Without that check,
one expired session would poison every future cold start with a login page.

**7. Recipe import falls back to the LLM only when JSON-LD is missing**, and
returns null rather than throwing when `ANTHROPIC_API_KEY` is unset — so URL
import keeps working for the big Swedish recipe sites with no API key at all.

**8. Anthropic model pinned to `claude-opus-5`** with structured outputs via
`messages.parse()` + a zod schema. I did not wire up refusal fallbacks: this is a
recipe parser, where a safety refusal is effectively impossible, and adding them
would push the call onto the beta endpoint and away from the validated-parse
helper. Say the word if you want them anyway.

**9. UPC-A barcodes are zero-padded to 13 digits before storage**, so the same
physical product can never occupy two rows in the barcode map.

**10. Recipe servings ranges take the LOWER bound** ("4-6 portioner" → 4). Scaling
up from too little is a smaller failure than buying for six when you needed four —
and you can always bump the stepper.

---

## Open questions for you

- **Authelia session TTL** needs to be long (weeks, with "remember me") before this
  is usable in a shop. Code can't fix that; it's a deployment setting. The app
  degrades gracefully — a lapsed session shows a banner over a working offline
  list rather than a redirect — but you'll still have to re-auth to sync.
- **Custom illustrations** for the top ~100 items remain the obvious visual
  upgrade. The data model is ready; it's a pure asset-production task.

---

## Gotchas

- `git_agent` reports LOCKED in this shell, so I committed with signing disabled.
  Nothing is pushed — the branch is local, as the away-mode contract requires.
- Dev Postgres runs on **port 5434** (longhaul owns 5433).
