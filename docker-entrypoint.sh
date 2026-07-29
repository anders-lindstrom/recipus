#!/bin/sh
set -e

# Snapshot the database before touching the schema. Drizzle has no down
# migrations, so this dump IS the rollback path. Mount a volume at /backups
# (BACKUP_DIR) to enable it; without one the deploy still goes through, but
# loudly.
#
# pg_dump compresses the file itself rather than piping into gzip: a shell
# pipeline exits with the status of its LAST command, so `pg_dump | gzip`
# reports success even when pg_dump aborts, and `set -e` sails past it leaving
# an empty file that looks exactly like a backup. It writes to a .tmp name that
# is renamed only after pg_dump exits 0, so a half-written dump can never be
# mistaken for a usable one, and a crash-looping container cannot fill the
# directory with them.
#
# Lifted from longhaul, which learned all of the above the hard way.
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-10}"
if [ -d "$BACKUP_DIR" ] && [ -w "$BACKUP_DIR" ]; then
  DUMP="$BACKUP_DIR/pre-migrate-$(date +%Y%m%d-%H%M%S).sql.gz"
  echo "Dumping database to $DUMP ..."
  rm -f "$BACKUP_DIR"/pre-migrate-*.sql.gz.tmp
  pg_dump --dbname="$DATABASE_URL" --compress=gzip:6 --file="$DUMP.tmp"
  mv "$DUMP.tmp" "$DUMP"
  ls -1t "$BACKUP_DIR"/pre-migrate-*.sql.gz 2>/dev/null \
    | tail -n +$((BACKUP_KEEP + 1)) | xargs -r rm --
else
  echo "WARNING: $BACKUP_DIR is not a writable directory — skipping the" \
    "pre-migration dump. Mount a volume there and chown it to uid 1001." >&2
fi

echo "Running database migrations..."
node node_modules/drizzle-kit/bin.cjs migrate

# The catalog seed runs from the server itself, after this, on boot — see
# src/instrumentation.ts. It has to be there rather than here: this image has no
# tsx and no src/, so `pnpm db:seed` cannot run inside the container.
echo "Starting Recipus..."
exec node server.js
