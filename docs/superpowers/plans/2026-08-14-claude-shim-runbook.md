# Task 8 runbook — deploy the shim and measure it

**Date:** 2026-08-14 · **For:** Anders, on beelink · **Status:** not started

Tasks 1–7 are built, reviewed and committed on `feat/claude-shim` in both repos. Task 8 is the only
one left, and it is yours because it needs SSH access to the box (only reachable through the
interactive 1Password agent) and stopwatch numbers from a phone.

Nothing here has run on beelink. Every claim below about that box is unverified by construction.

## What you are deploying

| Repo | Branch | Range | State |
|---|---|---|---|
| `agentic-os` | `feat/claude-shim` | `a11a2d2..24fb3b5` | 5 commits, 62 tests green |
| `recipus` | `feat/claude-shim` | `6b157c1..6bb4114` | 3 commits, 870 unit green, e2e 61/62 |

Neither is pushed. Merge to `master` yourself when you are happy.

`agentic-os` is host-local by design — build it on the box, never through the registry or Watchtower.
The shim inherits that rule.

---

## Before you start: the four things most likely to bite

These are ordered by how likely they are to be what goes wrong, not by severity.

### 1. `node`/`npm` may not be on the unit's PATH

**The most likely first-boot failure.** `install.sh` builds the unit's `PATH` from the `claude`
binary's directory plus `$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin`. If Node is installed through
a version manager (nvm, fnm, asdf, volta), `npm` lives in none of those and
`ExecStart=/usr/bin/env npm start` fails with `status=203/EXEC`, which reads as mysterious.

Nobody could establish how Node is installed on that box from here — there is no trace of it in either
repo. Check before you install:

```bash
which node npm
readlink -f "$(which npm)"
```

If it is under `~/.nvm`, `~/.asdf`, `~/.local/share/fnm` or similar, add that directory to
`UNIT_PATH` in `install.sh` (around line 55) before running it.

### 2. Port 8301 is unverified

The plan chose it because 8300 is agentic-os-web, 8080 is `otbr-web`, 5100–5103 are
hue-lights/alberto/longhaul/recipus, and 8088 is Watchtower's API. Nobody has confirmed it is actually
free. First command on the box:

```bash
ss -tulpn | grep LISTEN | grep -E ':(8300|8301)\b'
```

Expect 8300 in use, 8301 absent. If 8301 is taken, change it in **two** places — and note that the
unit template is *not* one of them, because it carries no port at all:

1. `SHIM_PORT=<port>` in agentic-os's repo-root `.env`. `shim/src/index.ts:71` reads it and falls
   back to 8301, and `index.ts` loads that `.env` itself — so this needs no code edit and no
   `Environment=` line in the unit.
2. `AI_SHIM_URL` in Recipus's deploy `.env`.

Then update the prose that names the port: `README.md:165` and `CLAUDE.md:7` in agentic-os, and
`docs/deploy.md` in Recipus. Those are documentation, not configuration — nothing reads them.

### 3. `maxTurns` is an untested guess

The Agent SDK enforces the turn bound inside a CLI subprocess, so no test here could reach it. The
shim uses **1 turn** for text and **2** for read-plus-answer. If that is off by one, the image path
fails on *every* request.

It fails loudly but misleadingly: `error_max_turns` matches none of the health classifier's markers,
so it surfaces as health `UNKNOWN` and a 503. **Do not chase a phantom auth or network problem** —
check the journal for `error_max_turns` first.

### 4. The prompts ask for JSON in a way no live model has seen

Dropping `zodOutputFormat` did not just remove schema enforcement — it left both copied prompts
*incomplete*. Nothing in them asked for JSON any more, and the recipe prompt's closing "fyll i
schemat" referred to a schema no longer in the request. An output block was added to each, kept as a
separate constant so the tuned Swedish text stays diffable against its original.

**That block has never been tested against a real model.** On your first live call, look at the raw
answer, not just the status code — a prompt that fails to produce JSON looks identical to a model that
had nothing to say. `extractJson` tolerates fences and surrounding prose and `askForJson` retries once,
so the risk is bounded, but this is the one part of the design that cannot be verified without a model.

---

## The deploy

### Step 1 — push and pull

```bash
# on this machine, when you are happy with the branches
git_agent push   # in each repo, after merging to master or pushing the branch
```

Recipus goes through its normal pipeline (GitHub Actions → registry → Watchtower). **agentic-os must
not** — pull it on the box.

```bash
ssh beelink
cd ~/dev/agentic-os   # confirm the real path first: ls ~; docker inspect agentic-os-web
git pull
```

Note: never rely on `cd` inside a script on that box — the login shell is zsh with zoxide, which
aliases `cd` to `z`, and `z` exits 0 on a missing directory. Absolute paths and `-C`/`-f` only.

### Step 2 — the secret

```bash
openssl rand -hex 32
```

**The same value goes in two places:** `SHIM_INGEST_SECRET` in agentic-os's **repo-root** `.env` (not
`shim/`), and `AI_SHIM_SECRET` in `~/services/recipus/.env`. `install.sh` refuses to enable the unit
without it rather than letting the unit crash-loop, and prints this exact command when it does.

While you are in that file: **check whether agentic-os's `.env` defines `ANTHROPIC_API_KEY`.**
The shim deletes it from its own environment after loading, so the shim is safe either way. But if it
is set there, the `claude` CLI on that box may itself be running on the metered key — the same bug one
layer out, and outside this plan's scope. Worth knowing.

### Step 3 — install

```bash
cd ~/dev/agentic-os/shim && npm install    # required: tsx is a devDependency and `npm start` needs it
cd ~/dev/agentic-os && ./install.sh
```

`npm ci --omit=dev` would break the service. `install.sh` checks for `shim/node_modules` and fails
loudly if it is missing.

Then, immediately — this is where issue 1 shows up:

```bash
systemctl --user status agentic-os-shim.service
curl -fsS http://127.0.0.1:8301/health
```

`/health` is unauthenticated and makes no Claude call, so it is free to poll.

Read the status line carefully: you want `active (running)`. The unit is `Restart=on-failure` with
`RestartSec=10` and no start-limit, so a shim that cannot start does **not** end up `failed` — it
sits in `activating (auto-restart)` and retries every ten seconds indefinitely, logging each time.
If you see that, `journalctl --user -u agentic-os-shim.service -n 30` has the reason on the first
line; the two it is designed to print are the missing secret and a missing `shim/node_modules`.

If the unit is not running after a reboot, check lingering:

```bash
loginctl show-user "$USER" --property=Linger
```

The trigger service already depends on it, so it is probably enabled — `install.sh` runs
`loginctl enable-linger` anyway.

### Step 4 — point Recipus at it

```bash
getent hosts beelink.host || echo "does not resolve — use 192.168.50.197"
```

Add to `~/services/recipus/.env`:

```
AI_SHIM_URL=http://<host>:8301
AI_SHIM_SECRET=<the same value as SHIM_INGEST_SECRET>
```

A trailing slash is now harmless (both call sites normalise it), but there is no reason to add one.

```bash
docker compose -f ~/services/recipus/docker-compose.yml up -d
```

The shim binds `0.0.0.0` deliberately: the Recipus container is on a docker bridge network and cannot
reach the host's loopback, so `127.0.0.1` would look secure and simply not work. The bearer token is
the security boundary, not the bind address. **Never** add this to `DOMAINS`, nginx-proxy-manager or
Authelia.

### Step 5 — prove the whole path

From *inside* the container, so the test covers the container→host hop:

```bash
SECRET=<the value you generated in step 2>   # export it FIRST, see below
docker exec recipus wget -qO- \
  --header="Content-Type: application/json" \
  --header="Authorization: Bearer $SECRET" \
  --post-data='{"kind":"text","text":"2 l mjölk, ägg och keso"}' \
  http://<host>:8301/parse
```

**Set `SECRET` in your shell before running that.** Unset, the header goes out as a bare `Bearer `
and the shim answers `401 {"error":"unauthorized"}` — which reads as a wrong secret rather than an
empty variable, and sends you to check the two `.env` files that were right all along.

The container is `node:24-alpine`, so busybox `wget` is present; you do not need `curl` inside it.

Look at the body, not just the exit code — see issue 4.

---

## The measurement, which is the actual point

**Time these two with a stopwatch, on the phone, in the app.**

| What | Seconds |
|---|---|
| One typed parse | |
| One Bring screenshot picked with *"Läs av en bild i stället"* | |
| One Bring screenshot **shared** into the app from another app | |

The two image rows are separate on purpose: **they are not the same request.** The picker path runs
`fileToParseInput`, which downscales to a 1600px JPEG at quality 0.8 — a few hundred KB. The share
path sends the original bytes, up to the 6 MiB cap in `src/app/dela/route.ts:43`, with no downscale
at all. So the shared image is the slower and larger of the two by some margin, and it is also the
one that has never been exercised end to end.

One caveat worth knowing before you read a failure as a broken feature: 6 MiB of original photo is
generous next to what a model will accept for a single image. A full-resolution camera photo shared
in may well come back as "kunde inte tolka bilden" where a screenshot succeeds. That is untested —
if you see it, note the file size in the report rather than assuming the path is broken.

> **If the typed parse is above about five seconds, say so loudly.** That is the number that sends
> this design back to the API key. It is far better discovered here than by someone standing in a shop.

In-process beats spawning `claude -p`, but this is still an agent loop in front of someone waiting on a
dialog, and nobody has measured it.

## Then prove the failure path

```bash
systemctl --user stop agentic-os-shim.service
```

Try an image parse in the app. You should see the Swedish "kunde inte tolka bilden" message rather
than a hang or a false "found nothing", **and a typed parse should still work** through the
deterministic fallback. Restart the service afterwards.

This is the degradation story the whole design rests on: every failure resolves to `null`, text falls
through to `interpretUtterance`, images answer 503, and the dialog's error card offers a way forward.

## Alerting

The shim writes the same `state/claude-health` file the briefings use and fires the same ntfy alert on
the same topic, **only on a state change** — a dead credential across a day of requests would otherwise
produce a push storm and you would mute the topic. The existing dashboard covers it with nothing new to
teach it.

When the credential expires, nothing is automatic: ssh to beelink, run `claude`, complete `/login`.
The AUTH alert says exactly that.

**Recipus now draws on the same subscription as the briefings and your coding sessions.** One
usage-limit window takes out all three.

---

## Open questions nobody could settle from here

- **Does `tools: ["Read"]` also exclude the `Skill` tool?** The SDK's types say omitting `skills` is
  explicitly "**not** 'skills off'", while elsewhere treating `'Skill'` as an ordinary tool name.
  Containment probably holds; it is not proven. Worth confirming on the box that a scratch-dir run
  offers only `Read`.
- **`tests/e2e/list.spec.ts:31`** ("a vara added from the well says so before it goes") fails on clean
  `master` too and is untouched by this branch — pre-existing, and it needs an owner.
  `list.spec.ts:83` is a load flake, passing in isolation.

## Write it up

The plan asks for a report at `docs/superpowers/plans/2026-08-14-claude-shim-report.md`: the measured
latencies, the port used, whether `beelink.host` resolved, the Agent SDK version
(`@anthropic-ai/claude-agent-sdk` 0.3.232), whether lingering was already enabled, and anything about
the shim's behaviour the spec got wrong.
