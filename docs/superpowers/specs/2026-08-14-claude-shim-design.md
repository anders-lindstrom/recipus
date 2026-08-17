# Recipus — off the API key, onto the subscription

**Date:** 2026-08-14
**Status:** specified, not built
**Scope:** one new host-local service on beelink (`agentic-os/shim/`), two rewritten call sites in
Recipus (`src/lib/ai-add/parse.ts`, `src/lib/recipes/llm.ts`), and the removal of
`ANTHROPIC_API_KEY` from this repo entirely.
**Spans two repos.** The service lives in `agentic-os`; the consumer changes live here.

> Written in English rather than Swedish, unlike this folder's other specs. Those describe the
> household's domain in the household's language. This one describes a systemd unit, an HTTP
> contract and a credential chain, on a box whose own documentation is English.

---

## 1. Why

Recipus reaches Claude through `@anthropic-ai/sdk` with `ANTHROPIC_API_KEY` — billable API usage.
Anders pays for a Claude subscription and wants that used instead. This is a billing decision, and
it turns out to have an architecture attached to it.

The two existing call sites:

| File | Purpose | Shipped |
|---|---|---|
| `src/lib/recipes/llm.ts` | Recipe extraction when a page has no JSON-LD | pre-existing |
| `src/lib/ai-add/parse.ts` | Bild/text/röst → clean Swedish lines | 2026-08-13 |

The second one inherited the pattern from the first, and the spec that shipped it said so in as
many words ("byggd som `src/lib/recipes/llm.ts`"). Neither the spec nor the plan surfaced the
billing assumption for a decision.

## 2. The finding that shapes everything

**Only the Claude Code credential reaches the subscription.**

The Anthropic SDK resolves credentials in this order: `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN`
→ an `ant auth login` OAuth profile → Workload Identity Federation → the default profile on disk.
That OAuth profile is a **Developer Platform** login. It removes the static key; it does not move
the billing. Everything in that chain is API usage.

The subscription credential is Claude Code's own `/login`, stored at `~/.claude/.credentials.json`
under `claudeAiOauth` — precisely the file `agentic-os`'s `claude_credentials_expired` reads. So
agentic-os is already on the subscription, and reaching it means going through Claude Code.

Two doors lead there, and both are subscription-backed:

- **`claude -p`**, the CLI. What `agentic-os/bin/lib.sh`'s `run_claude` already drives.
- **The Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — Claude Code packaged as a library,
  honouring the same credential resolution.

### 2.1 The foot-gun

An empty `ANTHROPIC_API_KEY=` does **not** fall through to the next credential. It wins its
precedence slot and authenticates with an empty key. `.env` and `.env.example` in this repo both
ship it empty today. Recipus is accidentally safe — `parse.ts` and `llm.ts` both test the variable
before constructing a client — but the shim will not be, so its unit unsets the variable explicitly
rather than trusting it to be absent.

## 3. Why a host-side service and not something simpler

`agentic-os/docker-compose.yml` states the rule for that box:

> Web UI only. The briefing jobs run on the HOST via systemd timers: they need the authenticated
> claude CLI and git push, **which do not belong in a container.**

The `beelink-deploy` skill states the deployment consequence:

> `agentic-os` is deliberately host-local: its jobs need the authenticated `claude` CLI and
> `git push`, so it is built locally and never touches the registry. Don't "fix" it onto this
> pipeline.

Recipus is the opposite shape on both counts: the container *is* the app, and the parse happens
inside a request while someone waits for a dialog. Three ways to bridge that, and only one respects
the rule the box already runs by:

| | How | Verdict |
|---|---|---|
| **A. Host-side shim** | A service on beelink, authenticated by the host's Claude Code login; the Recipus container calls it | **Chosen** |
| B. Claude Code in the Recipus container | `CLAUDE_CODE_OAUTH_TOKEN` in the container env | Breaks the rule above, and puts a subscription-wide credential in a container holding the household's data |
| C. Mount `~/.claude` into the container | Bind the credentials file in | Worst: the CLI *refreshes* that token, so it needs write access to the live credential |

The shim is an endpoint in **agentic-os**, not its own project: that repo already owns the
authenticated CLI on that host, the health file, `classify_claude`, and the ntfy alerting. One repo
stays the single place that knows how to call Claude on that box.

## 4. Mechanism: the Agent SDK, not a subprocess

The shim uses `@anthropic-ai/claude-agent-sdk` in-process rather than shelling out to `claude -p`.

- **Latency.** A spawn plus an agent loop per request, against a library call plus an agent loop.
- **Errors.** Typed failures instead of classifying stderr text.
- **Images.** Native handling rather than a temp file and a stdout contract.
- **Language.** TypeScript, like Recipus.

The cost, stated plainly: agentic-os is a shell repo, so this puts a second language on that host,
and it does **not** inherit `run_claude`'s already-debugged `classify_claude` / health / ntfy
scaffolding. That scaffolding is re-expressed in TypeScript (§8), which is the single largest piece
of work in this spec that is not the parse itself.

The `claude-api` skill deliberately does not document the Agent SDK's surface. Its API comes from
`code.claude.com/docs/en/agent-sdk` at build time — not from memory, and not inferred from the
Anthropic SDK's shapes.

## 5. The service

`agentic-os/shim/`, run by `agentic-os-shim.service`, installed by `install.sh` beside the existing
timers. It is a service rather than a timer — the only always-on piece in a repo of scheduled jobs.

### 5.1 Auth, both directions

**Outbound.** The Agent SDK reads `~/.claude/.credentials.json`. The unit sets
`UnsetEnvironment=ANTHROPIC_API_KEY` so §2.1 cannot bite.

**Inbound.** A bearer token in `SHIM_INGEST_SECRET`, modelled on `/api/voice`'s
`VOICE_INGEST_SECRET`: **the service refuses to start without one** rather than falling back to
unauthenticated. It binds `0.0.0.0`, because the Recipus container sits in a bridge network and
cannot reach the host's loopback — so the token is load-bearing, not ceremony.

> **Superseded 2026-08-17, before this ever deployed.** The single `SHIM_INGEST_SECRET` was replaced
> by a per-client map, `SHIM_CLIENTS=name:token,name:token`, so that the token a caller presents *is*
> which app it is — self-reported identity being worthless in the usage stats the shim now writes.
> Recipus needed no code change: it already sent a bearer token, and that value simply became its own.
> See `agentic-os/docs/superpowers/specs/2026-08-14-claude-usage-stats-design.md` §4. The paragraph
> above is left as it was written.

### 5.2 Networking

Port **8301**, beside agentic-os's 8300 — confirmed free with `sudo netstat -tulpn | grep LISTEN`
before anything is written. (8080 is `otbr-web`; 5100–5103 are hue-lights / alberto / longhaul /
recipus; 8088 is the Watchtower API.)

Recipus reaches it through `AI_SHIM_URL` in its deploy `.env`. The host half of that URL is
`beelink.host` if that name resolves on the box — `agentic-os/docker-compose.yml` references it —
and `192.168.50.197` otherwise. Verified, not assumed. No new DNS entries either way.

**Never exposed publicly.** No nginx-proxy-manager host, nothing appended to `DOMAINS`, no Authelia
rule. Exposing it would require all three, and it must have none of them.

## 6. The contract, and why the seam does not move

Two endpoints rather than one with a branching response shape — the two callers want different
things back, and a single route returning `{lines}` or `{recipe}` depending on its input is a union
every consumer has to narrow for no gain.

```
POST /parse                                POST /recipe
Authorization: Bearer <SHIM_INGEST_SECRET> Authorization: Bearer <SHIM_INGEST_SECRET>

  { kind: "text",  text }                    { html, url }
  { kind: "image", data, mediaType }

→ 200 { lines: [{ text, group }] }         → 200 { recipe: { … } }
→ 503 { error }                            → 503 { error }
```

`parseInput` keeps its exact signature and its exact contract — `AiInput` → `ParsedLine[] | null`,
never throws. Only its guts change, from an Anthropic SDK call to a `fetch`. **Nothing downstream
moves**: `rows.ts`, `services/ai-add.ts`, `api/routes/ai.ts`, `ai-add-model.ts`, `ai-add-sheet.tsx`,
and every op are untouched. Exactly two test files change — `parse.test.ts` and
`recipes/llm.test.ts` — each from an SDK mock to a fetch mock.

The degradation story survives intact because it was always expressed in terms of `null`: text
falls through to `interpretUtterance`, images answer 503, and the dialog's error card still offers
a way forward.

`extractRecipeWithLlm` moves the same way, keeping its own `ImportedRecipe | null` contract.

## 7. Structured output without `zodOutputFormat`

The single real loss. `messages.parse` enforces the schema at the API; the Agent SDK returns text.

The shim therefore prompts for JSON only, extracts it from the response, validates against the zod
schema, and **retries once** on a validation failure before giving up and returning `null`. One
retry, not a loop: a model that fails the schema twice is not going to pass on the fifth attempt,
and a request someone is waiting on cannot spend that time.

**Recipus re-validates the response against its own copy of the schema.** The shim is ours, which
is exactly why it gets no special trust — a contract asserted on both sides is a contract that
cannot silently drift.

## 8. Health, and the failure nobody would otherwise notice

An interactively-authenticated credential expires. agentic-os already has the whole apparatus for
that — `classify_claude` mapping failures to `OK | AUTH | RATE_LIMIT | OFFLINE | UNKNOWN`, a health
file, and `claude_health_transition` firing ntfy **only on state change** so a dead token cannot
produce a push storm.

The shim re-expresses that classification in TypeScript, writes the same health file, and fires the
same alert through the same topic. The distinction matters more here than for a briefing: a failed
briefing is a job that did not run, whereas a dead credential in Recipus is an AI button that
quietly stops working, discovered by someone standing in a shop.

Recipus's own behaviour is unchanged — every failure is still `null`.

## 9. Images are untrusted input reaching a tool-capable agent

A shared screenshot comes from another app and may contain anything, including text written to be
read as instructions. The agent that reads it has file-read capability. So:

- **`Read` only.** No `Bash`, no write tools, no web tools.
- **A dedicated empty scratch directory** as the working directory, holding exactly the one image
  under inspection.
- **The file is deleted in a `finally`**, so a crash cannot leave the household's shopping on disk.
- **Turns are bounded**, so a prompt-injected loop terminates.

This is the security design of the feature, not a hardening detail bolted on afterwards.

## 10. Removing the key

`ANTHROPIC_API_KEY` leaves this repo: both call sites, `.env.example`, `docs/`, and any comment
that references it. Both call sites move together — leaving one behind means the key must still be
set in production, which defeats the entire exercise.

## 11. Testing

**Shim** — unit tests with the Agent SDK mocked: JSON extraction, schema validation, the single
retry, the classification of each failure class, and the refusal to start without a secret.

**Recipus** — `parse.test.ts` and `recipes/llm.test.ts` rewritten against a stubbed `fetch`: no
`AI_SHIM_URL` ⇒ `null` with no request made; non-2xx ⇒ `null`; malformed body ⇒ `null`; a body that
fails the local schema check ⇒ `null`; a good body ⇒ the lines. The other 852 tests are expected to
pass untouched, and any that do not indicate the seam moved when it should not have.

**By hand, on the box** — one text parse and one real Bring screenshot through the deployed shim,
with the wall-clock time of each recorded in the plan's report. That number is the thing this design
cannot predict.

## 12. Known costs, stated up front

- **Latency is unmeasured.** In-process beats a spawn, but it is still an agent loop in front of
  someone waiting on a dialog. First thing to measure, and the one number that could send us back
  to the API key.
- **Shared limits.** Recipus now draws on the same subscription as the briefings and Anders' coding
  sessions. One usage-limit window takes out all three.
- **A second language on that host.** agentic-os becomes shell plus TypeScript.
- **Manual re-login.** When the credential expires, a human runs `claude` on the box and completes
  `/login`. §8 makes that discoverable; nothing makes it automatic.

## 13. Deliberately not in scope

Changing `/api/voice` or `/api/alexa` (they run no LLM at all). Any change to the reducer, the ops,
the dialog, or the share target. Putting the shim behind Authelia or on the public internet.
Automating the re-login.
