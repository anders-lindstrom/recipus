# Deploying Recipus to the beelink

```
git push origin master
   │
   ▼
GitHub Action ──test + e2e──> build ──> registry.lindstromhome.cc/recipus:latest
   │
   └──POST──> https://watchtower.lindstromhome.cc/v1/update?image=registry.lindstromhome.cc/recipus
                  │
                  ▼
            Watchtower pulls + recreates ONLY recipus   (other containers untouched)
                  │
                  └──> ntfy push to the `deploys` topic
```

Watchtower's scheduled ~10h scan is the fallback. A missing ntfy ping means the
CI trigger broke, not that the deploy is impossible.

This is the same pipeline as `longhaul` and `hue-lights`. What follows is only
what is specific to Recipus.

---

## One-time setup

### 1. GitHub repo secrets

| Secret | Value |
|---|---|
| `REGISTRY_USERNAME` | `github-ci` |
| `REGISTRY_PASSWORD` | that user's registry password |
| `WATCHTOWER_TOKEN` | contents of `~/services/watchtower/api-token.txt` (`sudo cat` it) |

### 2. Database on the shared Postgres

Recipus gets its own role and its own database, and the role must **own** the
database — otherwise migrations fail against PG15+'s locked-down `public`
schema.

```bash
docker exec -it postgres psql -U postgres
```
```sql
CREATE ROLE recipus LOGIN PASSWORD '<generate one>';
CREATE DATABASE recipus OWNER recipus;
```

No schema to create by hand: `docker-entrypoint.sh` runs `drizzle-kit migrate`
on every boot, and the server seeds the catalog after that.

### 3. `~/services/recipus/`

```bash
mkdir -p ~/services/recipus/backups
sudo chown -R 1001:1001 ~/services/recipus/backups
cp <repo>/deploy/docker-compose.yml ~/services/recipus/docker-compose.yml
```

`.env` in that directory (never committed):

```
DATABASE_URL=postgres://recipus:<the password above>@postgres:5432/recipus
PROXY_AUTH_SECRET=<openssl rand -hex 32>
ANTHROPIC_API_KEY=<optional — only the LLM fallback for recipe import needs it>
```

uid 1001 owning `backups` is load-bearing. If it is not writable the entrypoint
takes the *warning* branch and migrates with no snapshot — and drizzle has no
down migrations, so that dump is the only rollback path.

### 4. Expose it

Three changes, not one (see the `beelink-homelab` skill,
`references/networking.md`):

1. **NPM proxy host** `recipus.lindstromhome.cc` → forward to host `recipus`,
   port `3000`, scheme `http`. The container publishes no host port, so this is
   the only route in.
2. **DDNS `DOMAINS` list** — add the new subdomain.
3. **Authelia rule** on that host, plus two NPM settings on it:
   - inject the request header `X-Proxy-Auth: <the PROXY_AUTH_SECRET value>`
   - pass Authelia's `Remote-User` through

`src/lib/auth.ts` requires both. It fails closed: get either wrong and every
request 401s, which presents as an app that loads and then shows
"Inloggningen har gått ut" forever.

> **Set the Authelia session TTL to weeks, with "remember me".**
> This is the single most important deployment setting and no code can
> compensate for it. Recipus gets opened in a shop, on bad 4G, after three weeks
> of not being touched. A lapsed session there is a 2FA prompt at the checkout
> with a trolley full of food. The client already degrades well — a 401 shows a
> dismissible banner over a working offline list rather than redirecting — but
> the list stops syncing until you re-authenticate.

### 5. First run — and the ordering trap

**Watchtower can only *update* a container that already exists.** On a first
deploy the CI trigger fires against nothing and logs `scanned=0 updated=0`,
which looks like a bad token or a wrong `?image=` ref but is neither. Push
first so the image exists, then create the container once by hand:

```bash
docker compose -f ~/services/recipus/docker-compose.yml up -d
docker logs -f recipus
```

Expect, in order: the pre-migration dump warning-or-success, `drizzle-kit`
applying `0000` and `0001`, `Seeding 19 categories…`, `Seeding 341 catalog
items…`, then `Ready`. Only after this does `git push` → Watchtower → recreate
work.

Do **not** `docker push :latest` from the box to bootstrap. It works, but it
overwrites whatever tag CI last wrote, and a local `docker build` pushes a
Docker v2 manifest where CI's buildx pushes an OCI image index — so `:latest`
stops corresponding to any commit.

---

## Things that are specific to this app

**The catalog seeds itself on boot.** `src/instrumentation.ts` runs the same
seed function `pnpm db:seed` does. It is idempotent and deliberately preserves
everything the household owns (`has_at_home`, `use_count`, `last_used_at`), so a
deploy that adds catalog items ships them and a deploy that adds none changes
nothing. `SEED_ON_BOOT=0` turns it off. This exists because the production image
has no `tsx` and no `src/`, so `pnpm db:seed` cannot run inside the container —
and an empty catalog is a screen with nothing to tap, which is indistinguishable
from a broken deploy.

**`output: "standalone"` and the service worker.** The standalone server does
not serve `.next/static` or `public/` on its own; the Dockerfile copies both
into the standalone directory, and the server runs from there. Get this wrong
and `/sw.js` 404s — at which point offline silently stops working while
everything else looks fine. If offline ever breaks after a deploy, check that
`/sw.js` and `/manifest.webmanifest` return 200 before looking anywhere else.

**The icon sprite is built in the image, not committed.**
`public/icons/openmoji-sprite.svg` is gitignored (regenerable, ~300 SVGs of
vendor art), so the Docker build fetches it with `--strict`: any icon it cannot
fetch fails the build. A blocked deploy you retry is much cheaper than an image
that silently ships half a sprite. If OpenMoji's CDN is down, re-run the
workflow.

**pg_dump's major must be >= the server's.** The runner installs
`postgresql17-client`. `pg_dump` refuses to dump a server newer than itself, so
bump that line *before* upgrading the shared Postgres major, or every deploy
fails its snapshot and refuses to start.

**Timezone.** Cadence suggestions are computed from day boundaries ("bought 8
days ago"), so the container runs `TZ=Europe/Stockholm`. UTC would shift every
interval by a couple of hours.

---

## Operating it

```bash
# Manually trigger a deploy (LAN-direct, bypassing nginx-proxy-manager)
curl -fsS -X POST -H "Authorization: Bearer $(sudo cat ~/services/watchtower/api-token.txt)" \
  "http://127.0.0.1:8088/v1/update?image=registry.lindstromhome.cc/recipus"

docker logs -f recipus
docker exec recipus wget -qO- http://127.0.0.1:3000/api/health   # {"status":"ok","db":"up"}

# What tags does the registry have? (rollback targets)
curl -s -u anders https://registry.lindstromhome.cc/v2/recipus/tags/list
```

**Rollback.** Pin the image to a known-good `:<sha>` in the compose file and
`up -d`. If the bad deploy included a migration, restore the pre-migration dump
from `~/services/recipus/backups/` first — the newest `pre-migrate-*.sql.gz` is
the one taken immediately before it ran.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Every request 401s; the app shows "Inloggningen har gått ut" | `PROXY_AUTH_SECRET` missing from `.env`, or NPM's injected `X-Proxy-Auth` header does not match it |
| Loads, but attributes every change to nobody | NPM is not passing Authelia's `Remote-User` through |
| Container starts, NPM says connection refused | `HOSTNAME=0.0.0.0` missing — Next's standalone server binds `$HOSTNAME`, which Docker sets to the container id |
| App works, but offline does not | `/sw.js` 404 — the standalone server is not being run from a directory with `public/` copied in |
| Tiles show system emoji instead of OpenMoji | The sprite is absent. The build should have failed rather than shipping this — check the Action log for `--strict` |
| Empty catalog | The boot seed failed; `docker logs recipus` will have `[instrumentation] catalog seed failed` and the reason |
| Watchtower logs `scanned=0 updated=0` after a CI trigger | The container does not exist yet — see "First run" |
| CI pushed, container still runs old code | Missing `pull_policy: always`, or the trigger never fired |
