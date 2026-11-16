# Recipus — recipes from a photo or a PDF

**Date:** 2026-11-16
**Status:** specified, not built
**Spans two repos.** The reading happens in `agentic-os/shim/` (an extension of `POST /recipe`);
everything else lives here.

> Written in English, like `2026-08-14-claude-shim-design.md`, because half of it is an HTTP
> contract with the shim.

---

## 1. Why

The household's recipes do not all live on web pages. They are cookbook pages, PDFs, handwritten
cards and screenshots from Instagram. Today a recipe gets in only by URL (JSON-LD, then the shim's
`/recipe` on page text) or by pasting text. Anything that is a picture or a PDF has to be typed in
by hand, so in practice it never gets in at all.

The goal is a recipe system that takes input from many places: **any single photo, screenshot or
PDF becomes one recipe, and the file it came from is kept beside it.**

## 2. Goals, non-goals, anti-goals

**Goals**
- Upload one image (jpeg/png/webp, including a camera capture on the phone) or one PDF on
  `/recept/importera` and get one recipe out of it.
- Share a photo, screenshot or PDF from another app straight into Recipus as a recipe.
- **Keep the original** file with the recipe it produced, viewable from the recipe screen.
- **Review before saving** for file imports: the read result opens as an editable draft, because a
  model reading handwriting will sometimes misread it.
- Everything after the read (line parser, catalog matching, servings sheet, lists) is the existing
  path, untouched.

**Non-goals**
- Batch import. One file → one recipe, per import. (A PDF with several recipes yields the first or
  most prominent one; the household can import it again for the next — see §6.)
- Snapshotting web pages for URL imports. `sourceUrl` stays what it is; link rot is a later concern.
- Duplicate detection for file imports (there is no URL to key on). Noted for later.
- Tags, search, meal planning, cook mode — real ideas, separate specs.

**Anti-goals** (would make this a failure even if it works)
- A misread recipe saved silently — the household finds out at the stove.
- A second ingredient parser or matcher. All paths share `persistRecipe` (`src/api/routes/recipes.ts`)
  — the §5.6 promise in the main spec.
- Breaking the existing shared-screenshot → shopping-list flow.
- A file that is lost because the model failed. A failed read still keeps the file and still lets the
  household type the recipe in beside it.

## 3. Constraints

- The shim is the only door to Claude (`2026-08-14-claude-shim-design.md` §2–3). Recipus holds no
  model credential.
- The shim's security rules for untrusted images apply unchanged to PDFs: `Read` only, one file in an
  empty scratch dir, deleted in `finally`, bounded turns (shim spec §9).
- Recipus re-validates the shim's answer with its own zod copy of the schema (shim spec §7).
- Every shim failure is `null` on the Recipus side, never a throw (`src/lib/recipes/llm.ts`).
- Deploy order must tolerate either side being ahead: shim change is additive; a Recipus that talks
  to an old shim gets a 4xx → `null` → the manual-review path (§5.4), not a crash.
- The share target is singular (`public/manifest.webmanifest`, routed by `src/app/dela/route.ts`).

## 4. Approaches

| | How | Verdict |
|---|---|---|
| **A. Extend shim `/recipe` to accept a file** | `/recipe` takes `{ kind: "file", data, mediaType }` beside today's `{ html, url }`; same `{ recipe }` response | **Chosen** |
| B. Extract PDF text in Recipus, send only images to the shim | pdf library → text → today's `/recipe` | Rejected: scanned PDFs come out empty, the shim still needs changing for images, and it adds a second reading path |
| C. Reuse `/parse` (which already takes images) | — | Rejected: it returns shopping lines, not title/steps/servings |

Chosen by Anders, 2026-11-16. Claude reads PDFs natively, scanned or not, so a PDF is just another
file to the shim.

## 5. Design

### 5.1 Shim contract (agentic-os)

```
POST /recipe
Authorization: Bearer <client token>

  { html, url }                                   // unchanged
  { kind: "file", data, mediaType }               // new; data is base64, no data-URL prefix
     mediaType ∈ image/jpeg | image/png | image/webp | application/pdf

→ 200 { recipe: { title, servings, servingsUnit, imageUrl, ingredientLines, instructions } }
→ 4xx/5xx { error }
```

- Same response schema as today, so Recipus's `ResponseSchema` in `llm.ts` is reused as is.
  `imageUrl` is `null` for files.
- Written into the scratch dir with the right extension and read with `Read` (which handles images
  and PDFs). Prompt: "this file contains one recipe; if it contains several, return the first or most
  prominent one"; keep the source's language for ingredient lines and steps (as for web pages).
- Caps on the shim side: reject > 10 MB decoded, and PDFs over 20 pages (read only the first 20 if
  that is simpler — builder's call, but say which in the shim's error).
- Usage stats record it as its own operation (`recipe-file`) so latency of file reads is visible.
- Tests in agentic-os: the new body shape, mediaType allow-list, size cap, scratch-dir cleanup.

### 5.2 Storage (Recipus)

New table `recipe_sources`:

| column | type | note |
|---|---|---|
| `id` | text pk | uuid |
| `recipe_id` | text null, fk → `recipes.id` on delete cascade | null while still a draft |
| `kind` | text `image \| pdf \| text` | `text` = the paste path's original |
| `media_type` | text | e.g. `image/jpeg`, `application/pdf`, `text/plain` |
| `storage_key` | text | where the bytes live, see below |
| `sha256` | text | of the bytes, checked on read |
| `byte_size` | integer | |
| `file_name` | text null | when the browser gave one |
| `created_by` | text | |
| `created_at` | timestamptz | |

**The bytes live on disk, the row in Postgres** — the household's existing convention: longhaul keeps
attachments in `~/services/longhaul/data/storage`, expense-app keeps receipts in
`~/services/expense-app/data/receipts`. Recipus gets `~/services/recipus/data/storage`, bind-mounted
at `/app/data/storage`, `STORAGE_DIR` env (default `./data/storage`, which is also dev's). backrest
already backs up everything under `~/services`, so no backup change is needed. Hard cap **10 MB** per
file.

Postgres `bytea` was the other option and was rejected (decided with Anders, 2026-11-16):
- **Every dump would carry every file.** `pg-backup.sh` keeps 14 nightly dumps, and the entrypoint
  dumps the whole database before every migration. A few hundred recipe photos would be multiplied
  into each of them, and pg_dump's compression stops restic deduplicating them. On disk, restic
  stores each unchanged file once.
- What it would have bought — the file and the row committed together — is cheap to get back here:

Rules for the storage module (copy longhaul's `src/lib/storage.ts` `StorageAdapter` / `LocalFSStorage`,
including its path-containment check, rather than inventing one):
- **File first, row second.** Write the file, then insert the row. A crash between them leaves a file
  with no row, which is harmless; never the reverse.
- Key: `sources/<uuid>.<ext>`, with the extension taken from the allow-listed media type, never from
  the uploaded file name.
- A file with no row (older than 24 h) and a row whose file is gone are both reported by the prune job;
  the former is deleted, the latter logged loudly. `GET …/source` answers 404 with a clear message
  when the file is missing rather than 500.
- Deploy: `mkdir -p data/storage && sudo chown -R 1001:1001 data/storage` beside the existing
  `backups` step in `deploy/docker-compose.yml`'s comment and `docs/deploy.md`. Without it the
  container cannot write, and that must fail the import with an error, not silently skip the save.
- A table rather than columns on `recipes` so a recipe can later carry more than one source (a
  two-page spread) without a migration. **For now: at most one per recipe.**
- **Orphans** (`recipe_id IS NULL` older than 24 h — an abandoned draft) are deleted, row and file, by
  the existing prune job (`src/lib/services/prune.ts`). When prune hard-deletes an old soft-deleted
  recipe, the cascade removes its source rows; prune must delete those files too (collect the keys
  before the delete).
- The paste path also writes its pasted text as a `kind: "text"` source, so "the original next to
  the thing we created" holds for every non-URL import. Cheap, same table.
- Soft-deleting a recipe keeps its source (it may be restored); the cascade only bites on a hard
  delete.

### 5.3 Flow

```
pick / capture / share file
        │
        ▼
POST /api/recipes/read  (multipart: file)
  • validate type + size
  • INSERT recipe_sources (recipe_id NULL)           ← file is safe from here on
  • extractRecipeFromFile(bytes, mediaType) → shim   ← null on any failure
  • → 200 { sourceId, draft | null }
        │
        ▼
Review screen (client): editable title, servings + unit, ingredient lines, steps;
original shown alongside (image inline, PDF as a link/embed)
        │  "Spara"
        ▼
POST /api/recipes  { sourceId, title, servings, servingsUnit, ingredientLines, instructions }
  • persistRecipe(...)        ← the one parser/matcher path
  • UPDATE recipe_sources SET recipe_id = … WHERE id = sourceId AND recipe_id IS NULL AND created_by = actor
  • → the recipe; client navigates to /recept/{id}
```

- `extractRecipeFromFile` lives in `src/lib/recipes/llm.ts` beside `extractRecipeWithLlm`, shares its
  `ResponseSchema`, timeout and never-throw rule, and sets `sourceUrl: null`, `method: "llm"`.
- `persistRecipe` gains an optional `sourceId` (or the route attaches it in the same transaction —
  builder's call, but it must be one transaction).
- The draft lives in the client only; refreshing the review screen loses edits but not the file. A
  `GET /api/recipes/sources/{id}` lets the review screen show the original and lets a reload with
  `?source=` resume as a blank-draft review. (Builder may skip the resume if it gets complicated.)

### 5.4 When the read fails

`draft: null` still opens the review screen — empty, with the original beside it and a one-line
notice ("Kunde inte läsa receptet — skriv in det bredvid originalet"). The household can type it in
or give up; nothing is lost and the abandoned file is pruned after 24 h. This also covers the shim
being unconfigured or old.

### 5.5 UI

- `/recept/importera` (`src/components/recipe-import.tsx`) gets a third input beside URL and paste:
  **"Från bild eller PDF"** — a file input with `accept="image/*,application/pdf"`; on mobile the OS
  offers camera or files. Images go through the AI-add picker's client-side re-encode
  (`src/lib/client/image-file.ts`, JPEG), but with a **2400 px** long edge instead of its 1600 px: what
  is shrunk here is also the kept original, and a dense cookbook page or a handwritten card needs the
  extra resolution to stay legible. Add the edge as a parameter rather than a second copy. PDFs go as
  is.
- While reading: a progress state that says it can take up to a minute (shim latency is tens of
  seconds).
- Review screen: a new client component; reuse the edit controls of the recipe screen where they fit
  (`recipeEditSchema` already exists for PATCH).
- Recipe screen (`/recept/[id]`): a **"Visa original"** link when a source exists →
  `GET /api/recipes/{id}/source` streams the bytes with their media type and
  `Content-Disposition: inline`. For an image source with no `imageUrl`, the recipe may show the
  original as its picture — builder's call.

### 5.6 Share target

- Manifest `files.accept` adds `application/pdf`. `MAX_SHARE_BYTES` in `src/app/dela/route.ts` rises
  to 10 MB for PDFs only (images keep 6 MB).
- **A shared PDF** → parked like an image (`share-inbox.ts`, extended to accept the PDF type) →
  redirect to `/recept/importera?share=<token>`, which uploads it through `/api/recipes/read`.
- **A shared image** is ambiguous (shopping list or recipe?). It keeps going to the list's AI dialog
  as today, and the dialog gains a **"Spara som recept i stället"** action that hands the same parked
  image to the recipe flow. This keeps today's flow at zero extra taps. *(Claude's call — see §8.)*

### 5.7 Limits, privacy

- Bytes are served only through authenticated API routes, never a public path.
- A recipe's source is visible to the whole household, like the recipe.
- Untrusted-content rules are the shim's (§3); Recipus never interprets the file itself.

## 6. Testing

**Recipus**
- `llm.test.ts`: `extractRecipeFromFile` against a stubbed fetch — unconfigured ⇒ `null`, no request;
  non-2xx ⇒ `null`; bad body ⇒ `null`; good body ⇒ recipe with `sourceUrl: null`.
- Route tests: `/api/recipes/read` rejects wrong type / over-size; stores the source even when the
  read returns `null`; `POST /api/recipes` attaches the source only once and only for its creator;
  `GET …/source` returns the bytes and media type.
- Prune: orphan > 24 h deleted, attached source kept.
- `dela/route.test.ts`: PDF → recipe import; image still → AI dialog.
- Playwright: upload an image with the shim stubbed → review → save → recipe shows "Visa original";
  failed read → empty review → type and save.

**Shim** — see §5.1.

**By hand on beelink** — one handwritten card, one cookbook photo, one multi-page PDF, one Instagram
screenshot through the deployed shim, wall-clock time of each recorded.

## 7. Left to the builder

Component structure of the review screen; whether the source attach lives in `persistRecipe` or the
route (one transaction either way); the PDF preview widget; the resume-after-reload nicety; whether
an image source doubles as the recipe picture; how the shim caps PDF pages.

## 8. Calls made by Claude, for Anders to check

- Originals on disk under `STORAGE_DIR` (longhaul's pattern), 10 MB cap, orphan drafts pruned after
  24 h.
- Pasted text is kept as a `text` source too.
- The kept "original" of a photo is the re-encoded 2400 px JPEG, not the full-size camera file.
- Old soft-deleted recipes are hard-deleted by the existing prune job, and their sources go with
  them through the cascade.
- Shared images keep going to the shopping-list dialog, with a "Spara som recept i stället" action;
  shared PDFs go straight to the recipe flow.
- A multi-recipe file yields one recipe (the first/most prominent).
- A failed read still opens an empty review beside the original.
