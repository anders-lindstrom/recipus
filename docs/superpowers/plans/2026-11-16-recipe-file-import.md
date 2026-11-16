# Recipe file import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One photo, screenshot or PDF becomes one recipe, reviewed before saving, with the original
file kept beside it.

**Architecture:** The shim's `POST /recipe` learns a `{kind:"file"}` body and reads it with `Read` in
its scratch dir. Recipus stores the uploaded bytes on disk under `STORAGE_DIR` (longhaul's pattern),
a `recipe_sources` row points at them, the draft comes back to a review form, and saving goes
through the existing `persistRecipe`.

**Tech Stack:** Next.js 16, Hono + zod-openapi, Drizzle/Postgres, vitest, Playwright; shim: Hono,
node:test, Claude Agent SDK.

**Spec:** `docs/superpowers/specs/2026-11-16-recipe-file-import-design.md`

## Global Constraints

- Accepted media types, everywhere: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`.
- Max file size **10 MB** (decoded bytes). Shared images keep their existing 6 MB cap in `/dela`.
- Recipus never throws on a shim failure: every failure is `null` → empty review draft.
- File first, row second. Storage key `sources/<uuid>.<ext>`, ext from media type only.
- Orphan sources (`recipe_id IS NULL`) older than **24 h** are pruned, row and file.
- One source per recipe.
- UI copy is Swedish; code comments English.
- Commits: Conventional Commits, on `feat/recipe-file-import` (recipus) and
  `feat/recipe-file-read` (agentic-os). Never push without asking.

## Review Focus

1. **Double-tap "Spara"** → exactly one recipe. The attach is conditional
   (`recipe_id IS NULL AND created_by = actor`); 0 rows updated rolls the transaction back → 409.
   Test in Task 4.
2. **iPhone HEIC photo** → the client re-encodes every image to JPEG (`image-file.ts`), so HEIC
   arrives as JPEG. A type that is still not allowed gets a Swedish 400, never a 500. Test in Task 4.
3. **PDF over 10 MB** → refused in the browser before upload, with the size in the message; the
   server refuses it too (413/400). Tests in Task 4 (server) and Task 6 (client check, unit).
4. **Storage dir not writable** → the read endpoint answers 500 with
   "Kunde inte spara filen." and writes **no** row. Test in Task 4 (storage stub throwing).
5. **Source file missing on disk** (restore mismatch) → `GET …/source` is a 404 with a message, the
   recipe itself still renders. Test in Task 4.

---

### Task 1: Shim reads a recipe from a file (agentic-os)

**Files:** (repo `agentic-os`, worktree via `wt new feat/recipe-file-read`)
- Modify: `shim/src/image.ts` — add `["application/pdf", ".pdf"]` to `EXTENSION_BY_MEDIA_TYPE`;
  filename stem becomes `file` for pdf (`image.jpg` stays for images so `/parse` is unchanged).
- Modify: `shim/src/schemas.ts` — add `RECIPE_FILE_SYSTEM_PROMPT`.
- Modify: `shim/src/server.ts` — `RecipeRequest` becomes a union; raise `MAX_BODY_BYTES` to 16 MiB.
- Test: `shim/src/image.test.ts`, `shim/src/server.test.ts`

**Interfaces:**
- Produces: `POST /recipe` with `{kind:"file", data, mediaType}` → `200 {recipe}` (same
  `RecipeSchema`), `400` for bad type/base64, `413` over 16 MiB. Usage op `recipe.extract.file`,
  subject `""`.

- [ ] **Step 1: Failing tests**
  - `image.test.ts`: `"accepts a pdf and names it .pdf"` — `withScratchImage({data, mediaType:"application/pdf"})` → filename ends `.pdf`.
  - `server.test.ts`: `"reads a recipe from a file, wrapped in {recipe}"` — post `{kind:"file", data, mediaType:"image/jpeg"}` to `/recipe`; `answer` asserts `opts.scratchDir` set, `opts.systemPrompt === RECIPE_FILE_SYSTEM_PROMPT`, prompt names the file on disk; response `{recipe}`.
  - `"rejects a file recipe with a media type outside the allow-list, with 400"` (`image/gif`).
  - `"records a file recipe as recipe.extract.file"`.
  - Existing `"rejects a /recipe body missing its url with 400"` still passes.
- [ ] **Step 2:** `cd shim && npm test` → new tests FAIL.
- [ ] **Step 3: Implement.** `RecipeRequest = z.union([z.object({html,url}), z.object({kind:z.literal("file"), data:z.string(), mediaType:z.string()})])`; file branch mirrors `/parse`'s image branch (`withScratchImage` → `askForJson({systemPrompt: RECIPE_FILE_SYSTEM_PROMPT, prompt: \`Filen att läsa heter ${filename} och ligger i din arbetskatalog.\`, scratchDir}, RecipeSchema)`, `InvalidImageError` → 400). Error text for a bad body: `"expected {html,url} or {kind:'file',data,mediaType}"`.
  `RECIPE_FILE_SYSTEM_PROMPT` = a file-reading variant of `RECIPE_PROMPT` plus `RECIPE_OUTPUT`:
  "Du läser ett matrecept ur en bild eller PDF (fotograferad kokbokssida, handskrivet receptkort,
  skärmdump, PDF)." Same rules as `RECIPE_PROMPT`, except: lines verbatim in the source's language;
  "Innehåller filen flera recept, ta det första eller mest framträdande."; `imageUrl` always null;
  "Läs bara de 20 första sidorna av en PDF." Keep `RECIPE_PROMPT` untouched (it is a verbatim copy).
  The PDF `Read` may need several page reads: set turns for the file branch to 4 by passing an
  optional `maxTurns` through `AskOptions` (default unchanged).
- [ ] **Step 4:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5:** commit `feat(shim): read a recipe from an image or pdf`.

### Task 2: Storage module and `recipe_sources` table

**Files:**
- Create: `src/lib/storage.ts` (copy of longhaul's `StorageAdapter`/`LocalFSStorage` without sharp/thumbnails), `src/lib/storage.test.ts`
- Modify: `src/db/schema.ts` (add `recipeSources` after `recipeIngredients`)
- Create: `drizzle/0008_recipe_sources.sql` via `pnpm db:generate` (rename the generated file)
- Modify: `.env.example` (`STORAGE_DIR=./data/storage`), `.gitignore` (`/data/`)

**Interfaces:**
- Produces: `storage: StorageAdapter` with `put(key, bytes)`, `get(key): Promise<Buffer>` (rejects with code `ENOENT` when missing), `delete(key)`; `setStorageForTests(adapter)`.
- Produces: `SOURCE_MEDIA_TYPES: ReadonlyMap<string, {kind:"image"|"pdf", ext:string}>`, `MAX_SOURCE_BYTES = 10 * 1024 * 1024` — both in `src/lib/recipes/sources.ts`.
- Produces: `recipeSources` table: `id`, `recipeId` (nullable, fk cascade), `kind` (`"image"|"pdf"|"text"`), `mediaType`, `storageKey`, `sha256`, `byteSize`, `fileName` (nullable), `createdBy`, `createdAt`; index on `recipe_id`, and a partial-friendly index on `created_at`.

- [ ] **Step 1:** Failing tests in `storage.test.ts` (tmp dir): put→get round trip; `get` of missing key rejects with `ENOENT`; key `../x` throws `Invalid storage key`; delete of missing key resolves.
- [ ] **Step 2:** `pnpm vitest run src/lib/storage.test.ts` → FAIL.
- [ ] **Step 3:** Implement storage + `sources.ts` constants + schema; `pnpm db:generate`, `pnpm db:migrate`.
- [ ] **Step 4:** tests PASS; `pnpm tsc --noEmit` clean.
- [ ] **Step 5:** commit `feat(recipes): store recipe source files on disk`.

### Task 3: `extractRecipeFromFile`

**Files:** Modify `src/lib/recipes/llm.ts`, `src/lib/recipes/index.ts`; test `src/lib/recipes/llm.test.ts`.

**Interfaces:**
- Produces: `extractRecipeFromFile(file: {data: string; mediaType: string}): Promise<ImportedRecipe | null>` — POST `${SHIM_URL}/recipe` `{kind:"file", data, mediaType}`, same `ResponseSchema`, `SHIM_TIMEOUT_MS`, servings defaults and step trimming as `extractRecipeWithLlm` (share the post-processing in one private function). Returns `sourceUrl: null`, `imageUrl: null`, `method: "llm"`.

- [ ] **Step 1:** Tests (stubbed fetch, mirror existing ones): unconfigured ⇒ `null` and fetch not called; non-2xx ⇒ `null`; malformed ⇒ `null`; good ⇒ recipe with `sourceUrl: null` and the request body `{kind:"file", data:"QUJD", mediaType:"application/pdf"}`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(recipes): ask the shim to read a recipe file`.

### Task 4: API — read a file, save the draft, serve the original

**Files:** Modify `src/api/routes/recipes.ts`, `src/api/schemas.ts`; create `src/lib/services/recipe-sources.ts`; test `src/api/routes/recipes.test.ts` (dev DB, `test-recipes-` prefix, storage swapped to a tmp dir via `setStorageForTests`, shim via stubbed `fetch`).

**Interfaces:**
- Consumes: Task 2 storage + table, Task 3 `extractRecipeFromFile`, `takeSharedFile` (Task 8 — until then only `{data}` input).
- Produces (service): `saveSource(input: {bytes: Buffer; mediaType: string; fileName: string|null; kind: "image"|"pdf"|"text"; actor: string}): Promise<{id: string}>` — validates type/size, writes file, then row; `attachSource(tx, sourceId, recipeId, actor): Promise<boolean>`; `loadSourceFor(recipeId): Promise<{row, bytes} | null>`.
- Produces (HTTP):
  - `POST /api/recipes/read-file` body `{data: string (base64), mediaType: string, fileName?: string} | {shareToken: string}` → `200 {sourceId: string, draft: {title, servings, servingsUnit, ingredientLines: string[], instructions: string[]} | null}`; `400` type/base64/empty (Swedish: "Filtypen stöds inte. Välj en bild eller en PDF."); `413` > 10 MB ("Filen är för stor (max 10 MB)."); `404` share token gone; `500` storage failure ("Kunde inte spara filen.").
  - `POST /api/recipes/from-file` body `{sourceId, title (1–200), servings (>0, ≤999), servingsUnit (1–40), ingredientText (1–20000), instructions: string[] (≤60, each ≤2000)}` → `200 recipeSchema`; `400` "Hittade inga ingredienser i texten." when `cleanPastedIngredients` yields nothing; `409` "Receptet är redan sparat." when the attach updates 0 rows (rolled back).
  - `GET /api/recipes/{id}/source` → the bytes, `Content-Type` = stored media type, `Content-Disposition: inline`, `Cache-Control: private, max-age=86400`; `404` "Originalet finns inte." when no row or file missing (log `console.error` for the missing file).
  - `recipeSchema` gains `source: {kind: "image"|"pdf"|"text", mediaType: string} | null`; `loadRecipe` and `persistRecipe` fill it.
  - `POST /paste` also stores the pasted `text` as a `kind:"text"` source (`text/plain; charset=utf-8`) attached in the same transaction.
- `persistRecipe` gains an optional `sourceId`; the attach runs inside its transaction and a `false` from `attachSource` throws a `SourceTakenError` the route turns into 409.

- [ ] **Step 1: Failing tests** (`describe("file import")`):
  - `"stores the file even when the shim cannot read it"` → 200, `draft: null`, row exists with `recipe_id` null, file in tmp storage, sha256 matches.
  - `"returns the shim's draft"` (fetch stub returns a recipe).
  - `"refuses a type outside the allow-list"` (`image/gif`) → 400, no row.
  - `"refuses a file over 10 MB"` → 413, no row.
  - `"writes no row when the file cannot be written"` (storage stub `put` rejects) → 500, no row.
  - `"saves the draft and attaches the original"` → recipe returned with `source.kind === "image"`; row's `recipe_id` set.
  - `"a second save of the same source is a 409 and creates no second recipe"`.
  - `"someone else's source cannot be attached"` → 409.
  - `"serves the original with its media type"`; `"404s when the file is gone from disk"`.
  - `"paste keeps the pasted text as the original"`.
- [ ] **Step 2:** `pnpm vitest run src/api/routes/recipes.test.ts` → FAIL.
- [ ] **Step 3:** implement. Use base64 JSON (like `/api/ai/parse`), validated with the same base64 alphabet check as the shim before decoding.
- [ ] **Step 4:** PASS; full `pnpm test`, `pnpm tsc --noEmit`, `pnpm lint`.
- [ ] **Step 5:** commit `feat(recipes): import a recipe from an uploaded file`.

### Task 5: Prune orphans and files

**Files:** Modify `src/lib/services/prune.ts`, `src/lib/services/prune.test.ts`.

**Interfaces:**
- `PruneResult` gains `recipeSources: number`. Inside the transaction: collect `storage_key`s of (a) sources with `recipe_id IS NULL AND created_at < now - 24h` and (b) sources of recipes about to be hard-deleted; delete (a) rows explicitly ((b) cascade). **After** the transaction commits, `storage.delete` each key (best effort, log failures).

- [ ] Step 1: tests — orphan 25 h old: row and file gone; orphan 1 h old: kept; attached source of a live recipe: kept; source of a recipe pruned by retention: file gone.
- [ ] Step 2 FAIL → Step 3 implement → Step 4 PASS → Step 5 commit `feat(recipes): prune abandoned recipe files`.

### Task 6: Upload and review UI

**Files:**
- Modify: `src/lib/client/image-file.ts` — `fileToParseInput(file, maxEdge = MAX_EDGE)`; export `RECIPE_MAX_EDGE = 2400`.
- Create: `src/components/recipe-file-import.tsx` (picker + reading state + review form), `src/components/recipe-file-model.ts` + `.test.ts` (pure: `checkFile(file: {type, size}) → {ok:true} | {ok:false, message}`; `draftToForm(draft|null)`; `formToRequest(form, sourceId)`).
- Modify: `src/components/recipe-import.tsx` — third section "Från bild eller PDF" rendering `RecipeFileImport`; accept `initialShareToken` prop.
- Modify: `src/app/(app)/recept/importera/page.tsx` — pass `?share=` as `initialShareToken`.

**Behaviour:**
- `<input type="file" accept="image/*,application/pdf">`. Images → `fileToParseInput(file, RECIPE_MAX_EDGE)`; PDFs → base64 as is after `checkFile` (10 MB: "Filen är för stor (max 10 MB).").
- Reading state text: "Läser receptet … det kan ta upp till en minut."
- Review form: Titel, Portioner (number) + enhet (default "portioner"), Ingredienser (textarea, one per line), Gör så här (textarea, one step per line), original shown beside/above (img for image, link "Öppna PDF" for pdf, both via a `blob:` URL of the uploaded file). Draft null → empty form plus notice "Kunde inte läsa receptet — skriv in det bredvid originalet."
- "Spara" → `POST /api/recipes/from-file` → `router.push(/recept/{id})`. Disabled while saving. 409 → navigate to the recipe list with the message.
- `initialShareToken` → POST `read-file` `{shareToken}` on mount (behind the same cancellation guard pattern as the existing auto-import effect), then the same review.

- [ ] Step 1: tests for `recipe-file-model.ts` (`checkFile` 10 MB boundary: 10 MB ok, 10 MB + 1 refused; gif refused; HEIC `image/heic` ok because it is re-encoded; `draftToForm(null)` empty with unit "portioner"; `formToRequest` splits steps on newlines and drops blanks).
- [ ] Step 2 FAIL → Step 3 implement → Step 4 PASS + lint/tsc.
- [ ] Step 5: commit `feat(recipes): upload a photo or pdf and review it before saving`.

### Task 7: "Visa original" on the recipe screen

**Files:** Modify `src/components/recipe-detail.tsx` (and its model if it parses the recipe shape).

- When `recipe.source` is `image`/`pdf`: link "Visa original" → `/api/recipes/{id}/source` (`target="_blank"`). When `text`: a disclosure "Visa inklistrad text" that fetches and shows it in a `<pre>`. When the recipe has no `imageUrl` and the source is an image, show the original as the recipe picture.
- [ ] Covered by Task 9's e2e; commit `feat(recipes): show the original a recipe came from`.

### Task 8: Share target — PDFs, and "Spara som recept i stället"

**Files:**
- Modify: `public/manifest.webmanifest` (`files.accept` + `application/pdf`).
- Modify: `src/lib/services/share-inbox.ts` — rename to file semantics (`putSharedFile`/`takeSharedFile`/`peekSharedFile`), keep the same TTL/capacity/actor rules. `peekSharedFile` returns the file without consuming it.
- Modify: `src/app/dela/route.ts` — PDFs (≤ 10 MB) → park → `303 /recept/importera?share=<token>`; images unchanged (→ `/?ai=share&t=`).
- Modify: `src/api/routes/ai.ts` — share branch uses `peekSharedFile` (so the token survives for the recipe action) and refuses a PDF with 400.
- Modify: `src/components/ai-add-sheet.tsx` — when opened with a share token, show a secondary action "Spara som recept i stället" → `router.push(/recept/importera?share=<token>)`.
- Tests: `src/app/dela/route.test.ts` (PDF → importer redirect; 11 MB PDF → `/`; image still → `/?ai=share`), `src/lib/services/share-inbox.test.ts` (peek does not consume, take does), `src/api/routes/ai.test.ts` (share token still usable after a parse).
- [ ] TDD cycle as above; commit `feat(share): send shared pdfs and photos to the recipe importer`.

### Task 9: Deploy wiring and e2e

**Files:**
- Modify: `deploy/docker-compose.yml` — volume `./data/storage:/app/data/storage`, `STORAGE_DIR=/app/data/storage`, first-deploy comment `mkdir -p data/storage backups && sudo chown -R 1001:1001 data/storage backups`.
- Modify: `docs/deploy.md` — the same step, and that backrest covers it with no change.
- Modify: `Dockerfile` only if `/app/data` must exist/owned by 1001 in the image.
- Modify: `README.md` — one line on `STORAGE_DIR`.
- Create: `tests/e2e/recipe-file.spec.ts`:
  - `"a photo the shim cannot read still lands beside an empty form, and saves"` — e2e runs with no `SHIM_URL`, so the real path yields `draft: null`; fill the form; save; recipe page shows "Visa original" and it returns 200 `image/jpeg`.
  - `"a read draft is shown for review before it is saved"` — `page.route("**/api/recipes/read-file", r => { const res = await r.fetch(); body.draft = {...}; r.fulfill({json: body}) })`; edit the title; save; title on recipe page is the edited one.
  - Fixture files: `tests/e2e/fixtures/recipe-card.jpg` (tiny generated JPEG), `tests/e2e/fixtures/recipe.pdf` (tiny one-page PDF).
- [ ] Run `pnpm test:e2e tests/e2e/recipe-file.spec.ts` → PASS; full `pnpm test`, lint, tsc.
- [ ] Commit `build(deploy): mount storage for recipe originals` and `test(e2e): cover recipe import from a file`.

**Not in this plan (needs Anders):** deploying the shim on beelink, creating `~/services/recipus/data/storage` on the box, pushing either branch, opening PRs.
