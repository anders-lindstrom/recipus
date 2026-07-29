# Recipus

Hushållets handlingslista — en Bring-ersättare som fungerar i butiken, med
recept, streckkoder och förslag baserade på vad ni faktiskt brukar köpa.

Design: [`docs/superpowers/specs/2026-07-29-recipus-design.md`](./docs/superpowers/specs/2026-07-29-recipus-design.md) ·
Beslutslogg: [`DECISIONS.md`](./DECISIONS.md)

## Stack

Next.js 16 (App Router, TS) · Drizzle ORM + Postgres · Tailwind 4 ·
vitest för motorerna · Playwright för flödet · OpenMoji-ikoner ·
`zxing-wasm` som streckkodsavkodare där `BarcodeDetector` saknas.

Samma stack som longhaul, så de två projekten sköts likadant.

## Utveckling

```bash
# Postgres (dev) — port 5434, longhaul äger 5433. Samma major som beelinken.
docker run -d --name recipus-pg \
  -e POSTGRES_USER=recipus -e POSTGRES_PASSWORD=recipus -e POSTGRES_DB=recipus \
  -p 5434:5432 postgres:17-alpine

cp .env.example .env          # DATABASE_URL, PROXY_AUTH_SECRET, DEV_AUTH_USER

pnpm install
pnpm db:migrate               # drizzle-migrationer
pnpm db:seed                  # 19 kategorier, 341 svenska varor, en startlista
pnpm icons:build              # valfritt: hämtar OpenMoji-sprite (annars systememoji)
pnpm dev
```

I produktion seedas katalogen om vid varje start (`src/instrumentation.ts`), så
`pnpm db:seed` är bara till för utveckling.

```bash
pnpm test                     # 361 tester — motorerna är testdrivna
pnpm tsc --noEmit
pnpm lint
pnpm test:e2e                 # Playwright, egen lista per test
```

## Struktur

```
src/lib/units/        tolka och slå ihop mängder ("2 dl", "½ msk") + tester
src/lib/ingredients/  receptrad → mängd + vara, matchad mot katalogen
src/lib/cadence/      köphistorik → medianintervall → "brukar vara slut nu"
src/lib/sync/         op-typer och reduceraren — körs på BÅDA sidor
src/lib/recipes/      URL-import via JSON-LD, LLM som reserv
src/lib/barcode/      EAN-validering och Open Food Facts
src/lib/services/     delad affärslogik (läsvägar, op-tillämpning på servern)
src/lib/client/       IndexedDB, utkorg, SSE  (ej klar — se DECISIONS.md)
src/db/               drizzle-schema, migrationer, seed-data
src/components/       brickor, sökrad, avdelningsrad, receptblad, skanner
src/app/globals.css   designtokens: färg, typskala, radier, rörelse
```

## Det som bär hela designen

**Reduceraren körs på båda sidor.** Webbläsaren tillämpar din tryckning direkt;
servern tillämpar samma op med samma funktion. En andra implementation hade
förr eller senare tyckt något annat, och då slutar två telefoners listor matcha
utan att något felmeddelande syns.

**En vara finns högst en gång per lista.** Muffinsreceptet och pastasåsen som
båda vill ha grädde ger *två bidrag*, inte två brickor — annars går du förbi
mejerihyllan två gånger och köper hälften av vad du behövde.

**Att bocka av betyder köpt.** Långtryck ger "ta bort — köpte inte", som
medvetet inte skriver någon köphistorik. Utan den skillnaden lär sig
förslagsmotorn att du köper saffran varje vecka.

## Deploy

Samma pipeline som longhaul: push till `master` → GitHub Actions kör tester och
bygger imagen till `registry.lindstromhome.cc/recipus` → Watchtower drar och
återskapar bara den containern. NPM + Authelia står framför.

Hela runbooken — databasroll, NPM-host, Authelia-regel, första körningen och
felsökning — finns i [`docs/deploy.md`](./docs/deploy.md).

> ⚠️ **Authelias sessionstid måste vara lång** (veckor, med "remember me") innan
> det här är användbart i en butik. Appen klarar en utgången session — den visar
> en banner över en fungerande offline-lista i stället för att kasta dig till en
> inloggningssida — men du kan inte synka förrän du loggat in igen.
