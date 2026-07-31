# syntax=docker/dockerfile:1
#
# Recipus production image. Mirrors longhaul's, which is the reference for how
# apps are built and shipped to the beelink — see docs/deploy.md.

# ---- deps: one install, reused by both later stages -------------------------
FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---- builder ----------------------------------------------------------------
FROM node:24-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# src/db/index.ts throws when DATABASE_URL is unset, and Next imports every page
# module while building. Nothing connects during a build — this only has to be
# present and well-formed. The real URL arrives at runtime from the compose
# env_file; if this placeholder ever ends up in a running container, the app
# fails loudly at the first query rather than quietly writing somewhere wrong.
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5432/build

# The sprite is gitignored (regenerable, ~300 SVGs of vendor art), so a clean
# checkout does not have one and production would fall back to system emoji —
# which is precisely the inconsistent-across-phones look OpenMoji was chosen to
# avoid. --strict fails the build on a partial fetch: an image that ships half a
# sprite is worse than one that ships none, and far worse than a build you retry.
RUN pnpm tsx scripts/build-icon-sprite.ts --strict

RUN pnpm build

# ---- runner -----------------------------------------------------------------
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Cadence suggestions are computed from day boundaries ("bought 8 days ago"), so
# the container's clock has to agree with the household's. UTC would quietly
# shift every interval by a few hours.
ENV TZ=Europe/Stockholm

# Build stamp for the in-app "Om" version display (src/lib/version.ts). The
# image does not ship .git (see .dockerignore), so CI passes the commit SHA and
# build time as build-args and they are baked into runtime env here. Unset ->
# the dev fallback reads the working tree instead. Same wiring as longhaul.
ARG GIT_SHA
ARG BUILD_TIME
ENV RECIPUS_GIT_SHA=$GIT_SHA
ENV RECIPUS_BUILD_TIME=$BUILD_TIME

# pg_dump for the entrypoint's pre-migration snapshot. It refuses to dump a
# server newer than itself, so this major must be >= the shared postgres on the
# beelink (17.x). Bump it before upgrading that, or every deploy fails its
# snapshot and refuses to start.
RUN apk add --no-cache postgresql17-client \
  && addgroup -g 1001 -S nodejs \
  && adduser -S nextjs -u 1001

# Full node_modules, so drizzle-kit exists at runtime and the entrypoint can
# migrate. The standalone bundle's own node_modules subset merges on top.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
# public/ carries the service worker, the manifest and the sprite built above.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh && chown -R nextjs:nodejs /app

USER nextjs
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
