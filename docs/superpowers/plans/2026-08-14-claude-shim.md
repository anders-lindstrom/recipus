# Claude Shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Recipus off billable `ANTHROPIC_API_KEY` usage and onto Anders' Claude subscription, by routing both LLM call sites through a host-local service on beelink that authenticates with the box's Claude Code credential.

**Architecture:** A small TypeScript service (`agentic-os/shim/`) runs as a systemd **user** unit on beelink, calls Claude through `@anthropic-ai/claude-agent-sdk` (which reads `~/.claude/.credentials.json` — the subscription), and exposes two bearer-authenticated LAN endpoints. Recipus's `parseInput` and `extractRecipeWithLlm` keep their exact signatures and contracts; only their internals change from an Anthropic SDK call to a `fetch`. Every failure still resolves to `null`, so the existing degradation behaviour is untouched.

**Tech Stack:** TypeScript (ESM, node22), Hono + `@hono/node-server`, `@anthropic-ai/claude-agent-sdk`, zod, npm; `node --import tsx --test` for the shim's tests, vitest for Recipus's. systemd user units.

**Spec:** [`docs/superpowers/specs/2026-08-14-claude-shim-design.md`](../specs/2026-08-14-claude-shim-design.md)

## Global Constraints

- **Two repos.** The shim lives in `~/programmering/private/agentic-os`; the consumer changes live in `~/programmering/private/recipus`. Never mix them in one commit. Tasks name the repo explicitly.
- **`ANTHROPIC_API_KEY` is being deleted, not deprecated.** By the end of Task 7 it must appear nowhere in Recipus except in the two dated historical documents named below. It is never read, never set, never documented as an option.
- **Ruling on historical documents:** `docs/superpowers/specs/2026-08-13-ai-add-design.md` and `docs/superpowers/plans/2026-08-13-ai-add.md` keep their text. They record a decision as it stood on that date, and rewriting them would falsify the record. `docs/superpowers/specs/2026-07-29-recipus-design.md` gets a one-line pointer to the new spec rather than a rewrite. Every *living* document (`docs/voice.md`, `docs/deploy.md`, `.env.example`, `README.md`) is corrected in full.
- **An empty `ANTHROPIC_API_KEY=` is worse than an absent one** — it wins its precedence slot in the SDK credential chain and authenticates with an empty key. Delete the line; never leave it blank.
- **The shim refuses to start without `SHIM_INGEST_SECRET`.** No fallback to unauthenticated, matching `/api/voice`'s rule that a secret whose absence silently disables auth is discovered by someone else.
- **Nothing in this plan is exposed publicly.** No nginx-proxy-manager host, nothing appended to `DOMAINS` in `~/services/ddns/docker-compose.yml`, no Authelia rule.
- **Never rely on `cd` in a script that runs on beelink.** The login shell is zsh with zoxide, which aliases `cd` to `z`; on a missing directory `z` prints `no match found` and **exits 0**. Use absolute paths and `-C`/`-f` flags.
- Every string a Recipus user reads stays Swedish. Code and comments are English, in both repos.
- Conventional Commits: imperative, lowercase, no trailing period, under 72 chars. NEVER add Co-Authored-By or any AI attribution.
- Commit with `git_agent commit`, NOT `git commit`. If `git_agent` is not found, run `source ~/dotfiles/.config/op/agents.sh` first. Plain `git` for read-only operations.
- Recipus's gate is `pnpm test && pnpm tsc --noEmit && pnpm lint` (852 unit tests, 62 e2e). The shim's is `npm run typecheck && npm test`.

## File Structure

### `agentic-os/shim/` (new)

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json` | ESM, node22, following `agentic-os/web/`'s conventions |
| `src/health.ts` | Classify a failure as `OK\|AUTH\|RATE_LIMIT\|OFFLINE\|UNKNOWN`; write the health file; alert on state change only |
| `src/extract.ts` | Pull a JSON object out of model text (fences, surrounding prose) |
| `src/claude.ts` | The Agent SDK call: prompt → text → extract → validate → one retry → `T \| null` |
| `src/schemas.ts` | The zod schemas both endpoints validate against |
| `src/image.ts` | Scratch-dir lifecycle for an untrusted image |
| `src/server.ts` | Hono app: bearer auth, `POST /parse`, `POST /recipe` |
| `src/index.ts` | Entry point; refuses to start without `SHIM_INGEST_SECRET` |

### `agentic-os/` (modified)

`systemd/agentic-os-shim.service.in` (new), `install.sh` (enable the unit), `README.md` + `CLAUDE.md` (document it).

### `recipus/` (modified)

`src/lib/ai-add/parse.ts`, `src/lib/recipes/llm.ts`, `src/api/routes/ai.ts`, `src/lib/recipes/paste.ts`, `src/components/recipe-import.tsx`, four test files, `.env.example`, `docs/voice.md`, `docs/deploy.md`, `docs/superpowers/specs/2026-07-29-recipus-design.md`, `deploy/docker-compose.yml`.

---

### Task 1: Shim scaffold and its two pure helpers

**Repo:** `agentic-os`

**Files:**
- Create: `shim/package.json`, `shim/tsconfig.json`, `shim/src/health.ts`, `shim/src/extract.ts`
- Test: `shim/src/health.test.ts`, `shim/src/extract.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type ClaudeHealth = "OK" | "AUTH" | "RATE_LIMIT" | "OFFLINE" | "UNKNOWN";
  export function classifyFailure(message: string): ClaudeHealth;
  export function extractJson(raw: string): unknown | null;
  ```

- [ ] **Step 1: Scaffold the package**

Create `shim/package.json`, mirroring `agentic-os/web/package.json`'s conventions (ESM, npm, tsx test runner):

```json
{
  "name": "agentic-os-shim",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test src/*.test.ts",
    "start": "node --import tsx src/index.ts"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
    "@hono/node-server": "^1.13.7",
    "hono": "^4.6.14",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^24.13.3",
    "tsx": "^4.23.1",
    "typescript": "^6.0.3"
  }
}
```

Pin `@anthropic-ai/claude-agent-sdk` to whatever `npm view @anthropic-ai/claude-agent-sdk version` actually reports — record the version you installed in your report.

Create `shim/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

Run `npm install` in `shim/`.

- [ ] **Step 2: Write the failing tests**

Create `shim/src/health.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure } from "./health.ts";

describe("classifyFailure", () => {
  it("names an expired or missing login as AUTH", () => {
    for (const m of [
      "Not logged in",
      "Please run /login",
      "OAuth token has expired",
      "refresh token rejected",
      "unauthorized",
    ]) {
      assert.equal(classifyFailure(m), "AUTH", m);
    }
  });

  it("names a usage cap as RATE_LIMIT", () => {
    for (const m of ["Usage limit reached", "rate limit exceeded", "overloaded"]) {
      assert.equal(classifyFailure(m), "RATE_LIMIT", m);
    }
  });

  it("names a dead network as OFFLINE", () => {
    for (const m of ["getaddrinfo ENOTFOUND", "ECONNREFUSED", "network error", "timed out"]) {
      assert.equal(classifyFailure(m), "OFFLINE", m);
    }
  });

  it("leaves anything unrecognised as UNKNOWN", () => {
    // Only a POSITIVE match yields AUTH — a false max-priority alert trains
    // you to ignore the real one. Same rule as classify_claude in bin/lib.sh.
    assert.equal(classifyFailure("something exploded"), "UNKNOWN");
    assert.equal(classifyFailure(""), "UNKNOWN");
  });

  it("matches regardless of case", () => {
    assert.equal(classifyFailure("NOT LOGGED IN"), "AUTH");
  });
});
```

Create `shim/src/extract.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "./extract.ts";

describe("extractJson", () => {
  it("reads a bare object", () => {
    assert.deepEqual(extractJson('{"lines":[]}'), { lines: [] });
  });

  it("reads an object inside a fenced block", () => {
    const raw = 'Here you go:\n```json\n{"lines":[{"text":"ägg","group":"list"}]}\n```';
    assert.deepEqual(extractJson(raw), { lines: [{ text: "ägg", group: "list" }] });
  });

  it("reads an object with prose on both sides", () => {
    assert.deepEqual(extractJson('Sure! {"a":1} Hope that helps.'), { a: 1 });
  });

  it("handles a nested object without stopping at the first brace", () => {
    assert.deepEqual(extractJson('{"a":{"b":2}}'), { a: { b: 2 } });
  });

  it("returns null when there is no JSON at all", () => {
    assert.equal(extractJson("I could not read the image."), null);
  });

  it("returns null on malformed JSON rather than throwing", () => {
    assert.equal(extractJson('{"a":'), null);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `cd ~/programmering/private/agentic-os/shim && npm test`
Expected: FAIL — cannot find `./health.ts` / `./extract.ts`.

- [ ] **Step 4: Implement**

Create `shim/src/health.ts`:

```ts
/**
 * Is claude usable, and does anyone need to be told?
 *
 * A TypeScript re-expression of `classify_claude` / `claude_health_transition`
 * in bin/lib.sh, for the one job in this repo that is a service rather than a
 * timer. The rules are copied deliberately rather than reinvented:
 *
 *  - Only a POSITIVE match yields AUTH. Anything unrecognised stays UNKNOWN and
 *    is treated as an ordinary failure — a false max-priority alert trains you
 *    to ignore the real one.
 *  - Alert only on state CHANGES. A dead token across a day of requests would
 *    otherwise produce a push storm, and you would mute the topic.
 *
 * The stakes differ from a briefing's, which is why this exists at all: a failed
 * briefing is a job that did not run, whereas a dead credential here is an AI
 * button that quietly stops working, discovered by someone standing in a shop.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ClaudeHealth = "OK" | "AUTH" | "RATE_LIMIT" | "OFFLINE" | "UNKNOWN";

const AUTH_MARKERS = [
  "not logged in",
  "please run /login",
  "invalid api key",
  "authentication_error",
  "oauth token has expired",
  "refresh token",
  "unauthorized",
];

const RATE_LIMIT_MARKERS = [
  "usage limit reached",
  "rate limit",
  "rate_limit_error",
  "overloaded",
];

const OFFLINE_MARKERS = [
  "getaddrinfo",
  "enotfound",
  "econnrefused",
  "connection refused",
  "could not resolve",
  "network error",
  "timed out",
];

export function classifyFailure(message: string): ClaudeHealth {
  const lower = message.toLowerCase();
  if (AUTH_MARKERS.some((m) => lower.includes(m))) return "AUTH";
  if (RATE_LIMIT_MARKERS.some((m) => lower.includes(m))) return "RATE_LIMIT";
  if (OFFLINE_MARKERS.some((m) => lower.includes(m))) return "OFFLINE";
  return "UNKNOWN";
}

/**
 * Record the status, and return whether it CHANGED.
 *
 * The caller alerts only on a true return. Reading and writing the same file
 * bin/lib.sh uses means the web dashboard's health view covers this service too,
 * with nothing new to teach it.
 */
export function recordHealth(status: ClaudeHealth, healthFile: string): boolean {
  let previous = "UNSET";
  try {
    previous = readFileSync(healthFile, "utf8").trim();
  } catch {
    // No file yet — the first observation is always a change.
  }
  mkdirSync(dirname(healthFile), { recursive: true });
  writeFileSync(healthFile, `${status}\n`);
  return previous !== status;
}
```

Create `shim/src/extract.ts`:

```ts
/**
 * The JSON in the model's answer, if there is any.
 *
 * The one real cost of leaving the Anthropic SDK behind. `messages.parse` with
 * `zodOutputFormat` enforced the schema at the API; the Agent SDK returns text,
 * so the shape becomes our problem. This is the smaller half of that problem —
 * finding the object. Validating it is `claude.ts`'s job, and re-validating it
 * on arrival is Recipus's.
 *
 * Brace-counting rather than a regex: a regex either stops at the first `}` and
 * truncates every nested object, or matches greedily to the last one and
 * swallows trailing prose. Counting is the only reading that survives
 * `{"a":{"b":2}}`.
 */
export function extractJson(raw: string): unknown | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const c = raw[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    // Braces inside a string literal are text, not structure.
    if (inString) continue;

    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd ~/programmering/private/agentic-os/shim && npm test && npm run typecheck`
Expected: PASS, 11 tests, typecheck clean.

- [ ] **Step 6: Commit (in agentic-os)**

```bash
cd ~/programmering/private/agentic-os
git add shim/
git_agent commit -m "feat(shim): scaffold the claude shim and its pure helpers"
```

---

### Task 2: The Agent SDK caller

**Repo:** `agentic-os`

**Files:**
- Create: `shim/src/claude.ts`
- Test: `shim/src/claude.test.ts`

**Interfaces:**
- Consumes: `extractJson` (Task 1), `classifyFailure` (Task 1).
- Produces:
  ```ts
  export interface AskOptions {
    systemPrompt: string;
    prompt: string;
    /** Absolute path the agent may read from. Omit for text-only work. */
    scratchDir?: string;
  }
  export class ClaudeUnavailableError extends Error {
    readonly health: ClaudeHealth;
  }
  /** Resolves to the validated object, or null when the model answered but the shape never validated. */
  export function askForJson<T>(opts: AskOptions, schema: z.ZodType<T>): Promise<T | null>;
  ```

**The one part of this plan that is researched rather than specified.** The `claude-api` skill deliberately does not document the Agent SDK's surface, and this plan will not invent it.

- [ ] **Step 1: Read the Agent SDK docs and write down its actual API**

WebFetch `https://code.claude.com/docs/en/agent-sdk` (and the TypeScript page it links). Record in your report, verbatim:

1. The import and the entry function (the docs describe a `query(prompt, options)` shape — confirm the exact name, whether it returns a promise or an async iterable, and how to obtain the final assistant text).
2. How to pass a system prompt.
3. How to restrict the tool set to `Read` only — the exact option name and value shape.
4. How to set the working directory.
5. How to bound the number of turns.
6. What it throws, and whether errors carry a typed shape or only a message.

If any of these cannot be established from the docs, **stop and report NEEDS_CONTEXT** rather than guessing. Everything downstream depends on this being right, and a plausible-looking wrong binding will fail only at runtime on the box.

- [ ] **Step 2: Write the failing test**

The test mocks the SDK module, so it pins `askForJson`'s contract regardless of the binding you found. Replace `MODULE` and `ENTRY` with the real module specifier and entry-function name from Step 1, and adjust only the mock's *shape* to match — never the assertions.

Create `shim/src/claude.test.ts`:

```ts
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

// Replace with the real specifier + entry name established in Step 1.
const MODULE = "@anthropic-ai/claude-agent-sdk";

const Schema = z.object({ lines: z.array(z.object({ text: z.string() })) });

/** Install a mock that returns `replies` in order, one per call. */
function mockSdk(replies: (string | Error)[]) {
  let i = 0;
  return mock.fn(async () => {
    const reply = replies[i++];
    if (reply instanceof Error) throw reply;
    return reply;
  });
}

describe("askForJson", () => {
  it("returns the validated object on a clean first answer", async () => {
    const { askForJson } = await import("./claude.ts");
    // Wire the mock per Step 1's shape before calling.
    const result = await askForJson({ systemPrompt: "s", prompt: "p" }, Schema);
    assert.deepEqual(result, { lines: [{ text: "ägg" }] });
  });

  it("retries exactly once when the first answer fails the schema", async () => {
    // First reply is well-formed JSON of the WRONG shape; second is correct.
    // Asserting the call count is the point: one retry, never a loop — a model
    // that fails the schema twice will not pass on the fifth attempt, and a
    // person is waiting on this request.
    const sdk = mockSdk(['{"nope":1}', '{"lines":[{"text":"ägg"}]}']);
    const { askForJson } = await import("./claude.ts");
    const result = await askForJson({ systemPrompt: "s", prompt: "p" }, Schema);
    assert.deepEqual(result, { lines: [{ text: "ägg" }] });
    assert.equal(sdk.mock.callCount(), 2);
  });

  it("returns null after two failures, without a third attempt", async () => {
    const sdk = mockSdk(['{"nope":1}', "still not json"]);
    const { askForJson } = await import("./claude.ts");
    assert.equal(await askForJson({ systemPrompt: "s", prompt: "p" }, Schema), null);
    assert.equal(sdk.mock.callCount(), 2);
  });

  it("throws ClaudeUnavailableError carrying AUTH when the login is dead", async () => {
    const sdk = mockSdk([new Error("Not logged in. Please run /login")]);
    const { askForJson, ClaudeUnavailableError } = await import("./claude.ts");
    await assert.rejects(
      () => askForJson({ systemPrompt: "s", prompt: "p" }, Schema),
      (err: unknown) => {
        assert.ok(err instanceof ClaudeUnavailableError);
        assert.equal(err.health, "AUTH");
        return true;
      },
    );
    // An unusable credential is not retried — the second attempt would fail
    // identically and only doubles the latency of a request that cannot work.
    assert.equal(sdk.mock.callCount(), 1);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd ~/programmering/private/agentic-os/shim && npm test -- --test-name-pattern askForJson`
Expected: FAIL — cannot find `./claude.ts`.

- [ ] **Step 4: Implement**

Write `shim/src/claude.ts` against the binding from Step 1. The behaviour the tests pin:

- One call. If it throws, classify the message with `classifyFailure` and throw `ClaudeUnavailableError` carrying that health — **do not retry a transport failure**, only a schema failure.
- On success, `extractJson` the text, then `schema.safeParse` it. If either fails, make **exactly one** more call and repeat. A second failure returns `null`.
- The system prompt and prompt come from the caller; `scratchDir`, when given, is the working directory and the agent gets `Read` and nothing else. When absent, the agent gets **no tools at all**.
- Bound the turns. Text work needs one; the image path needs enough for a single read plus the answer.

Comment the retry rule and the no-tools default where they sit — the next reader will otherwise "improve" the retry into a loop.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd ~/programmering/private/agentic-os/shim && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/programmering/private/agentic-os
git add shim/
git_agent commit -m "feat(shim): ask claude for json, validated, with one retry"
```

---

### Task 3: Schemas and the authenticated server

**Repo:** `agentic-os`

**Files:**
- Create: `shim/src/schemas.ts`, `shim/src/server.ts`, `shim/src/index.ts`
- Test: `shim/src/server.test.ts`

**Interfaces:**
- Consumes: `askForJson`, `ClaudeUnavailableError` (Task 2); `classifyFailure`, `recordHealth` (Task 1).
- Produces:
  ```ts
  export const LinesSchema: z.ZodType<{ lines: { text: string; group: "list" | "other" }[] }>;
  export const RecipeSchema: z.ZodType<{ title: string; servings: number; servingsUnit: string; imageUrl: string | null; ingredientLines: string[]; instructions: string[] }>;
  export function createServer(deps: { secret: string }): Hono;
  ```

The two schemas mirror Recipus exactly — `LinesSchema` matches the one deleted from `src/lib/ai-add/parse.ts`, and `RecipeSchema` matches `RecipeSchema` in `src/lib/recipes/llm.ts`. Read both files before writing them.

The system prompts move across unchanged too: `SYSTEM_PROMPT` from `src/lib/ai-add/parse.ts` (the Swedish one about one thing per line and the `other` group) and the one from `src/lib/recipes/llm.ts` (the Swedish one about verbatim `ingredientLines`). Copy them verbatim — they are tuned, and this task is a transport change, not a prompt change.

- [ ] **Step 1: Write the failing test**

Create `shim/src/server.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "./server.ts";

const SECRET = "test-secret";
const app = createServer({ secret: SECRET });

function post(path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("the shim's door", () => {
  it("refuses a request with no token", async () => {
    const res = await post("/parse", { kind: "text", text: "ägg" });
    assert.equal(res.status, 401);
  });

  it("refuses a request with the wrong token", async () => {
    const res = await post("/parse", { kind: "text", text: "ägg" }, "wrong");
    assert.equal(res.status, 401);
  });

  it("rejects a malformed body with 400, not 500", async () => {
    const res = await post("/parse", { kind: "nonsense" }, SECRET);
    assert.equal(res.status, 400);
  });

  it("answers /health without a token, for the unit's readiness check", async () => {
    const res = await app.request("/health");
    assert.equal(res.status, 200);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ~/programmering/private/agentic-os/shim && npm test -- --test-name-pattern "shim's door"`
Expected: FAIL — cannot find `./server.ts`.

- [ ] **Step 3: Implement the server**

`shim/src/server.ts` — a Hono app with:

- `GET /health` — unauthenticated, returns 200. It proves the process is up, nothing more; it must not call Claude, or the readiness check becomes a billable request.
- Bearer middleware on everything else, comparing with a **timing-safe** comparison (`crypto.timingSafeEqual` over equal-length buffers — guard the length first, since `timingSafeEqual` throws on a mismatch).
- `POST /parse` — zod-validated body of `{kind:"text",text}` or `{kind:"image",data,mediaType}`; calls `askForJson(..., LinesSchema)`; 200 with the result, or 503 when it throws `ClaudeUnavailableError`.
- `POST /recipe` — body `{html,url}`; calls `askForJson(..., RecipeSchema)`; same error mapping.
- A malformed body is **400**, distinct from 503. Recipus treats both as `null`, but the distinction is what makes a log readable.
- On a `ClaudeUnavailableError`, call `recordHealth` and — only when it returns `true` — fire the ntfy alert. Reuse the topic and the message shape from `claude_health_transition` in `bin/lib.sh`, including the `Fix: ssh to beelink, then run 'claude' and complete /login.` line.

Image requests pass through `withScratchImage` from Task 4. Until Task 4 lands, have `POST /parse` handle only `kind: "text"` and return 501 for `kind: "image"`; Task 4 replaces that.

- [ ] **Step 4: Implement the entry point**

`shim/src/index.ts`:

```ts
/**
 * The shim's front door, and the one check it makes before opening it.
 *
 * Refusing to start without a secret rather than falling back to an open
 * endpoint. Same rule as `/api/voice` in recipus and `authenticate()` beside
 * it: a secret whose absence silently disables authentication is discovered by
 * somebody else, and this door reaches a subscription.
 *
 * Binds 0.0.0.0 deliberately. The recipus container sits in a docker bridge
 * network and cannot reach this host's loopback, so 127.0.0.1 would look
 * secure and simply not work — which is how a bearer token ends up being
 * removed "because it must be the problem". The token is the security boundary
 * here; the bind address is not.
 */

import { serve } from "@hono/node-server";
import { createServer } from "./server.ts";

const secret = process.env.SHIM_INGEST_SECRET;
if (!secret) {
  console.error("SHIM_INGEST_SECRET is not set. Refusing to start.");
  process.exit(1);
}

const port = Number(process.env.SHIM_PORT ?? 8301);
serve({ fetch: createServer({ secret }).fetch, port, hostname: "0.0.0.0" });
console.log(`shim listening on 0.0.0.0:${port}`);
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd ~/programmering/private/agentic-os/shim && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Prove the refusal to start**

Run: `cd ~/programmering/private/agentic-os/shim && env -u SHIM_INGEST_SECRET npm start; echo "exit:$?"`
Expected: the refusal message and a non-zero exit. Paste the actual output into your report.

- [ ] **Step 7: Commit**

```bash
cd ~/programmering/private/agentic-os
git add shim/
git_agent commit -m "feat(shim): serve parse and recipe behind a bearer token"
```

---

### Task 4: Images, as untrusted input

**Repo:** `agentic-os`

**Files:**
- Create: `shim/src/image.ts`
- Modify: `shim/src/server.ts` (replace the 501 branch)
- Test: `shim/src/image.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  /** Writes the image to a fresh empty dir, runs `fn`, and deletes the dir whether or not `fn` throws. */
  export function withScratchImage<T>(
    image: { data: string; mediaType: string },
    fn: (dir: string, filename: string) => Promise<T>,
  ): Promise<T>;
  ```

**This is the security design of the feature, not a hardening detail.** A shared screenshot arrives from another app and may contain text written to be read as instructions, and the agent that reads it has file-read capability. The containment is: `Read` only, a working directory holding exactly one file, bounded turns, and deletion in a `finally`.

- [ ] **Step 1: Write the failing test**

Create `shim/src/image.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { withScratchImage } from "./image.ts";

const IMAGE = { data: Buffer.from("not-really-a-jpeg").toString("base64"), mediaType: "image/jpeg" };

describe("withScratchImage", () => {
  it("hands over a directory containing exactly the one image", async () => {
    await withScratchImage(IMAGE, async (dir, filename) => {
      // Exactly one file: the agent's working directory must hold nothing it
      // was not given, because everything in it is reachable by Read.
      assert.deepEqual(readdirSync(dir), [filename]);
      assert.equal(readFileSync(`${dir}/${filename}`, "utf8"), "not-really-a-jpeg");
      return null;
    });
  });

  it("deletes the directory after a successful run", async () => {
    let captured = "";
    await withScratchImage(IMAGE, async (dir) => {
      captured = dir;
      return null;
    });
    assert.equal(existsSync(captured), false);
  });

  it("deletes the directory even when the run throws", async () => {
    // The one that matters. A crash must not leave the household's shopping
    // sitting on the host's disk.
    let captured = "";
    await assert.rejects(
      withScratchImage(IMAGE, async (dir) => {
        captured = dir;
        throw new Error("boom");
      }),
    );
    assert.equal(existsSync(captured), false);
  });

  it("gives each call its own directory", async () => {
    const dirs: string[] = [];
    await withScratchImage(IMAGE, async (d) => void dirs.push(d));
    await withScratchImage(IMAGE, async (d) => void dirs.push(d));
    assert.notEqual(dirs[0], dirs[1]);
  });

  it("names the file by its media type, so the agent can tell what it is", async () => {
    await withScratchImage({ ...IMAGE, mediaType: "image/png" }, async (_dir, filename) => {
      assert.ok(filename.endsWith(".png"));
      return null;
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ~/programmering/private/agentic-os/shim && npm test -- --test-name-pattern withScratchImage`
Expected: FAIL — cannot find `./image.ts`.

- [ ] **Step 3: Implement**

`shim/src/image.ts` uses `mkdtemp` under `os.tmpdir()` for a fresh directory per call, writes the decoded base64 as `image.<ext>` derived from the media type (`image/jpeg` → `.jpg`, `image/png` → `.png`, `image/webp` → `.webp`), calls `fn(dir, filename)`, and removes the directory recursively in a `finally`.

Write the comment explaining *why* the directory is fresh and empty: it is the agent's working directory, and anything else in it would be readable by an agent holding an attacker-influenced screenshot.

- [ ] **Step 4: Wire it into the server**

Replace `POST /parse`'s 501 branch: for `kind: "image"`, wrap the `askForJson` call in `withScratchImage`, passing the scratch directory as `scratchDir` and naming the file in the prompt so the agent reads it.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd ~/programmering/private/agentic-os/shim && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/programmering/private/agentic-os
git add shim/
git_agent commit -m "feat(shim): read a shared image in a scratch dir of its own"
```

---

### Task 5: The systemd unit and its install

**Repo:** `agentic-os`

**Files:**
- Create: `systemd/agentic-os-shim.service.in`
- Modify: `install.sh`, `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: `shim/src/index.ts` (Task 3).
- Produces: a running `agentic-os-shim.service` on port 8301.

Note the existing convention, read from `install.sh` before you start: these are systemd **user** units rendered from `systemd/*.in` into `~/.config/systemd/user`, with `__REPO_DIR__` and `__PATH__` substituted. The loop already picks up any new `.in` file; only the explicit `enable --now` needs adding.

- [ ] **Step 1: Write the unit template**

Create `systemd/agentic-os-shim.service.in`, modelled on `agentic-os-trigger.service.in`:

```ini
[Unit]
Description=agentic-os claude shim (recipus and other LAN callers)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=__REPO_DIR__/shim
Environment=PATH=__PATH__
# An empty or stale ANTHROPIC_API_KEY does not fall through to the next
# credential — it wins its precedence slot and authenticates with an empty key,
# silently shadowing the Claude Code login this service exists to use.
UnsetEnvironment=ANTHROPIC_API_KEY
ExecStart=/usr/bin/env npm start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Enable it in install.sh**

Find the line that enables the trigger service (`systemctl --user enable --now agentic-os-trigger.service`) and add the shim beside it. In the same edit, add a check next to the existing dependency loop that `SHIM_INGEST_SECRET` is present in the repo's `.env`, failing the install with a clear message if not — the unit will otherwise start, exit 1, and be restarted forever by `Restart=on-failure`.

- [ ] **Step 3: Verify the port is actually free before committing to it**

On beelink:

```bash
sudo netstat -tulpn | grep LISTEN | grep -E ':(8300|8301)\b' || echo "8301 free"
```

Expected: 8300 in use by agentic-os-web, 8301 free. If 8301 is taken, pick the next free port, and change it in this unit, in `index.ts`'s default, and in Task 6's `AI_SHIM_URL` — record the port you chose in your report.

- [ ] **Step 4: Document it**

Add a short section to `agentic-os/README.md` covering: what the shim is, that it is the only always-on service in a repo of timers, the port, that it is LAN-only and must never be added to `DOMAINS` or put behind Authelia, and that `SHIM_INGEST_SECRET` lives in the repo `.env`. Add one line to `CLAUDE.md`'s description of the repo so the next agent knows the shim exists.

State plainly in the README that this service puts Recipus on the same subscription as the briefings, so a usage-limit window takes out both.

- [ ] **Step 5: Commit**

```bash
cd ~/programmering/private/agentic-os
git add systemd/ install.sh README.md CLAUDE.md
git_agent commit -m "feat(shim): run the shim as a user unit on 8301"
```

---

### Task 6: Recipus — `parse.ts` onto the shim

**Repo:** `recipus`

**Files:**
- Modify: `src/lib/ai-add/parse.ts`, `src/api/routes/ai.ts`
- Test: `src/lib/ai-add/parse.test.ts` (rewrite)

**Interfaces:**
- Consumes: `POST /parse` (Tasks 3–4).
- Produces: `parseInput(input: AiInput): Promise<ParsedLine[] | null>` — **unchanged signature and unchanged contract.**

The whole point of this task is that nothing downstream moves. `rows.ts`, `services/ai-add.ts`, `ai-add-model.ts`, `ai-add-sheet.tsx`, the ops and the e2e specs are untouched. If you find yourself editing one of them, stop and report — the seam moved when it should not have.

- [ ] **Step 1: Rewrite the test**

Replace `src/lib/ai-add/parse.test.ts` wholesale. It no longer mocks the Anthropic SDK; it stubs `fetch`.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseInput } from "./parse";

const ORIGINAL_URL = process.env.AI_SHIM_URL;
const ORIGINAL_SECRET = process.env.AI_SHIM_SECRET;

describe("parseInput", () => {
  beforeEach(() => {
    process.env.AI_SHIM_URL = "http://beelink.host:8301";
    process.env.AI_SHIM_SECRET = "test-secret";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_URL === undefined) delete process.env.AI_SHIM_URL;
    else process.env.AI_SHIM_URL = ORIGINAL_URL;
    if (ORIGINAL_SECRET === undefined) delete process.env.AI_SHIM_SECRET;
    else process.env.AI_SHIM_SECRET = ORIGINAL_SECRET;
  });

  it("returns null without calling anything when the shim is not configured", async () => {
    delete process.env.AI_SHIM_URL;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await parseInput({ kind: "text", text: "mjölk" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts text to /parse with the bearer token and returns the lines", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ lines: [{ text: "2 l mjölk", group: "list" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const lines = await parseInput({ kind: "text", text: "2 l mjölk" });

    expect(lines).toEqual([{ text: "2 l mjölk", group: "list" }]);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("http://beelink.host:8301/parse");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer test-secret");
    expect(JSON.parse(init!.body as string)).toEqual({ kind: "text", text: "2 l mjölk" });
  });

  it("passes an image through with its media type", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ lines: [] }), { status: 200 }),
    );
    await parseInput({ kind: "image", data: "AAAA", mediaType: "image/jpeg" });
    expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)).toEqual({
      kind: "image",
      data: "AAAA",
      mediaType: "image/jpeg",
    });
  });

  it("returns null on a non-2xx answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));
    expect(await parseInput({ kind: "text", text: "x" })).toBeNull();
  });

  it("returns null when the shim is unreachable, rather than throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await parseInput({ kind: "text", text: "x" })).toBeNull();
  });

  it("returns null on a body that does not match the schema", async () => {
    // The shim is ours, which is exactly why it gets no special trust: a
    // contract asserted on one side only is a contract that drifts silently.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ lines: [{ text: 42, group: "list" }] }), { status: 200 }),
    );
    expect(await parseInput({ kind: "text", text: "x" })).toBeNull();
  });

  it("drops blank lines rather than passing them on", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ lines: [{ text: "  ", group: "list" }, { text: " ägg ", group: "list" }] }),
        { status: 200 },
      ),
    );
    expect(await parseInput({ kind: "text", text: "x" })).toEqual([
      { text: "ägg", group: "list" },
    ]);
  });

  it("returns an empty array, not null, when the model found nothing", async () => {
    // The distinction the whole degradation story rests on: [] means "looked
    // and found nothing" and stays a 200; null means "could not help" and
    // becomes a 503 for images.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ lines: [] }), { status: 200 }),
    );
    expect(await parseInput({ kind: "text", text: "x" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/lib/ai-add/parse.test.ts`
Expected: FAIL — the current implementation calls the Anthropic SDK, not `fetch`.

- [ ] **Step 3: Rewrite `parse.ts`**

Keep the file's doc comment's *argument* (the model is a front door, not a second matcher) and update its *mechanics*. Delete the `Anthropic` import, the SDK call, `AI_ADD_MODEL`, `MAX_TOKENS`, and the `SYSTEM_PROMPT` — the prompt now lives in the shim, and keeping a second copy here is the drift this codebase keeps arguing against.

Keep: `ParsedLine`, `LineGroup`, `AiInput`, the `MAX_TEXT_CHARS` cap, the blank-line filter, and the never-throws rule.

Add: a `LinesSchema` used to validate the shim's response, and this shape —

```ts
const SHIM_TIMEOUT_MS = 60_000;

export async function parseInput(input: AiInput): Promise<ParsedLine[] | null> {
  const base = process.env.AI_SHIM_URL;
  const secret = process.env.AI_SHIM_SECRET;
  if (!base || !secret) return null;

  const body =
    input.kind === "text"
      ? { kind: "text", text: input.text.slice(0, MAX_TEXT_CHARS) }
      : input;

  let payload: unknown;
  try {
    const res = await fetch(`${base}/parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SHIM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    payload = await res.json();
  } catch {
    return null;
  }

  const parsed = LinesSchema.safeParse(payload);
  if (!parsed.success) return null;

  return parsed.data.lines
    .map((line) => ({ text: line.text.trim(), group: line.group }))
    .filter((line) => line.text.length > 0);
}
```

Write the comment explaining why the response is validated even though the shim is ours.

- [ ] **Step 4: Simplify the route**

In `src/api/routes/ai.ts`, delete both `if (!process.env.ANTHROPIC_API_KEY)` pre-checks and the `KEY_MISSING` constant. The post-check added on 2026-08-13 — `image && !result.usedModel` ⇒ 503 — already covers every case the pre-check did, and now covers "the shim is unconfigured or unreachable" too. Rewrite the remaining 503 message so it no longer names an environment variable that will not exist: something that says the image could not be read, in Swedish, and update the OpenAPI `description` on line 86 accordingly.

- [ ] **Step 5: Run the tests**

Run: `pnpm test && pnpm tsc --noEmit && pnpm lint`
Expected: green. The route tests in `src/api/routes/ai.test.ts` assert on the 503 *status*, not the message, so they should pass unchanged — if one asserts the old text, update that assertion and say so in your report.

- [ ] **Step 6: Commit**

```bash
cd ~/programmering/private/recipus
git add src/lib/ai-add/parse.ts src/lib/ai-add/parse.test.ts src/api/routes/ai.ts
git_agent commit -m "feat(ai-add): read through the shim instead of the api"
```

---

### Task 7: Recipus — the recipe importer, and the last of the key

**Repo:** `recipus`

**Files:**
- Modify: `src/lib/recipes/llm.ts`, `src/lib/recipes/paste.ts`, `src/components/recipe-import.tsx`, `.env.example`, `deploy/docker-compose.yml`, `docs/voice.md`, `docs/deploy.md`, `docs/superpowers/specs/2026-07-29-recipus-design.md`, `README.md`
- Test: `src/lib/recipes/llm.test.ts` (rewrite), `src/lib/recipes/import.test.ts`, `tests/e2e/recipes.spec.ts`

**Interfaces:**
- Consumes: `POST /recipe` (Task 3).
- Produces: `extractRecipeWithLlm(html: string, url: string): Promise<ImportedRecipe | null>` — **unchanged signature and unchanged contract.**

- [ ] **Step 1: Rewrite `llm.test.ts`**

Same shape as Task 6's rewrite: stub `fetch` rather than the SDK. Cover — no `AI_SHIM_URL` ⇒ `null` with no request; a good body ⇒ the recipe with `method: "llm"` and `sourceUrl` set; non-2xx ⇒ `null`; a rejected fetch ⇒ `null`; a body failing the schema ⇒ `null`; `servings` of 0 or `NaN` ⇒ defaulted to 4 and `"portioner"`; and trailing empty `instructions` entries trimmed away. Those last two are existing behaviour in `llm.ts` that must survive the transport change — read the file and keep every one of its post-processing rules.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/lib/recipes/llm.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `llm.ts`**

Delete the `Anthropic` import, `MODEL`, `MAX_TOKENS`, the `RecipeSchema` used as an output format, and the `SYSTEM_PROMPT` (it moves to the shim). Keep `extractPageText` and `MAX_PAGE_TEXT_CHARS` — the trimming happens before the wire, not on the box. Keep every post-processing rule. `POST` to `${AI_SHIM_URL}/recipe` with `{ html: extractPageText(html), url }`, validate the response with a local schema, and return `null` on any failure.

- [ ] **Step 4: Fix the two stale comments**

`src/lib/recipes/paste.ts` and `src/components/recipe-import.tsx` each explain a failure mode in terms of "no `ANTHROPIC_API_KEY`". The failure still exists — the importer can still fail and still offers the paste path — but its cause is now "the shim could not read the page". Rewrite both comments to say that, keeping their arguments intact.

- [ ] **Step 5: Purge the variable**

Remove `ANTHROPIC_API_KEY` from `.env.example`, from `deploy/docker-compose.yml` if it appears there, and from your own `.env` (it is gitignored; edit it by hand and say in your report that you did). Add `AI_SHIM_URL` and `AI_SHIM_SECRET` to `.env.example` with a comment saying what they are and that the app degrades rather than breaking when they are unset.

Update `docs/deploy.md` (the env table) and `docs/voice.md` (three places: the prose about the key, the example `ANTHROPIC_API_KEY=sk-ant-...`, and the troubleshooting row) to describe the shim instead. Add a line to `docs/deploy.md` recording that the shim is a host service in agentic-os, not part of this repo's deploy, and that Watchtower knows nothing about it.

Append one line to `docs/superpowers/specs/2026-07-29-recipus-design.md` where it mentions the key, pointing at `2026-08-14-claude-shim-design.md` — a pointer, not a rewrite, because that document records what was true then.

Then prove the purge:

```bash
cd ~/programmering/private/recipus
grep -rn "ANTHROPIC_API_KEY" --include="*.ts" --include="*.tsx" --include="*.md" \
  --include="*.yml" --include="*.example" . | grep -v node_modules
```

Expected: matches **only** in `docs/superpowers/specs/2026-08-13-ai-add-design.md`, `docs/superpowers/plans/2026-08-13-ai-add.md`, `docs/superpowers/specs/2026-08-14-claude-shim-design.md` and this plan. Paste the output into your report. Any other match is unfinished work.

- [ ] **Step 6: Update the e2e comment**

`tests/e2e/recipes.spec.ts:9` explains the test in terms of a household with no key. The test itself is about a failed import offering a way through, which is unchanged — update the comment to name the shim and leave the test alone.

- [ ] **Step 7: Run everything**

Run: `pnpm test && pnpm tsc --noEmit && pnpm lint && pnpm test:e2e`
Expected: 852 unit tests and 62 e2e green. `pnpm exec playwright install chromium` first if the browser is missing.

- [ ] **Step 8: Commit**

```bash
cd ~/programmering/private/recipus
git add -A
git_agent commit -m "feat(recipes): import through the shim and drop the api key"
```

---

### Task 8: Deploy it, and measure the thing the design could not predict

**Repo:** both, plus the box

**Files:** none — this task produces a report and a `.env` on beelink.

**Interfaces:**
- Consumes: everything above.
- Produces: the latency numbers §12 of the spec asks for.

This is the task that answers whether the design was right. Do not skip the measurement or report it from memory.

- [ ] **Step 1: Push both repos**

Recipus goes through its normal pipeline (`git_agent push`; GitHub Actions → registry → Watchtower). agentic-os is host-local by design and **must not** touch the registry — pull it on the box.

- [ ] **Step 2: Install the shim on beelink**

```bash
ssh beelink
cd ~/dev/agentic-os && git pull      # confirm the actual path first with: docker inspect / ls ~
openssl rand -hex 32                 # the value for SHIM_INGEST_SECRET
```

Add `SHIM_INGEST_SECRET=…` to agentic-os's `.env`, run `npm install` in `shim/`, run `./install.sh`, then:

```bash
systemctl --user status agentic-os-shim.service
curl -fsS http://127.0.0.1:8301/health
```

If the unit is not running after a reboot, check `loginctl show-user "$USER" --property=Linger` — user units stop at logout without lingering. The trigger service already depends on this, so it is likely already enabled; say either way in your report.

- [ ] **Step 3: Point Recipus at it**

Determine the host half of the URL:

```bash
getent hosts beelink.host || echo "beelink.host does not resolve — use 192.168.50.197"
```

Add `AI_SHIM_URL` and `AI_SHIM_SECRET` to `~/services/recipus/.env`, then
`docker compose -f ~/services/recipus/docker-compose.yml up -d`.

- [ ] **Step 4: Prove the whole path, and time it**

From inside the Recipus container, so the test covers the container→host hop:

```bash
docker exec recipus wget -qO- --header="Content-Type: application/json" \
  --header="Authorization: Bearer $SECRET" \
  --post-data='{"kind":"text","text":"2 l mjölk, ägg och keso"}' \
  http://<host>:8301/parse
```

Then, in the app on a phone: one typed parse, and one real Bring screenshot shared in. **Time both with a stopwatch** and record the wall-clock seconds in your report.

- [ ] **Step 5: Prove the alerting**

Stop the shim (`systemctl --user stop agentic-os-shim.service`), try an image parse in the app, and confirm: the dialog shows the Swedish "could not read the image" message rather than hanging or claiming it found nothing, and a typed parse still works through the deterministic fallback. Restart the service. Report what you saw.

- [ ] **Step 6: Write the report**

Record in `docs/superpowers/plans/2026-08-14-claude-shim-report.md` (in Recipus): the measured latencies, the port used, whether `beelink.host` resolved, the Agent SDK version, whether lingering was already enabled, and anything about the shim's behaviour that the spec got wrong. Commit it.

**If the typed-parse latency is above about five seconds, say so prominently** — that is the number that would send this design back to the API key, and it is better surfaced in a report than discovered in a shop.

---

## Self-Review

**Spec coverage.** §2/§2.1 the credential and the foot-gun → Tasks 5 (`UnsetEnvironment`) and 7 (the purge). §3 host-side placement → Task 5. §4 the Agent SDK → Task 2. §5.1 auth both ways → Tasks 3 and 5. §5.2 networking and the port → Tasks 3, 5 (verify free), 8 (verify reachable). §6 the contract and the unmoved seam → Tasks 6 and 7. §7 structured output with one retry, validated on both sides → Tasks 2 and 6. §8 health and alerting → Tasks 1 and 3, proven in Task 8. §9 images as untrusted input → Task 4. §10 removing the key → Task 7, with a grep that proves it. §11 testing → every task, plus Task 8's by-hand measurement. §12 the costs → Task 8 measures the one that is unknown and Task 5 documents the shared-limit one.

**Known gap, stated rather than hidden:** Task 2's implementation depends on Agent SDK API details this plan does not contain, because the reference skill does not document them and inventing them would be worse than naming the gap. The task's tests fully pin the *contract*; Step 1 names the source, the six facts to extract, and the instruction to stop rather than guess.
