#!/bin/sh
# Forward-only SQL migration runner. Applies db/migrations/*.sql in name order.
# An applied file whose checksum later changes is an error: add a new file instead.
# Each file and its schema_migrations row commit in one transaction, so a concurrent
# second runner fails on the primary key and rolls back instead of applying twice.
set -eu

DIR="${MIGRATIONS_DIR:-/migrations}"
: "${DATABASE_URL:?DATABASE_URL is required}"

q() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -tA "$@"; }

i=0
until pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -gt 30 ] && { echo "migrate: database not reachable" >&2; exit 1; }
  sleep 1
done

q -c "CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now())"

applied=0
for f in "$DIR"/*.sql; do
  [ -e "$f" ] || continue
  v=$(basename "$f" .sql)
  sum=$(sha256sum "$f" | cut -d' ' -f1)
  have=$(q -c "SELECT checksum FROM schema_migrations WHERE version = '$v'")
  if [ -n "$have" ]; then
    if [ "$have" != "$sum" ]; then
      echo "migrate: ERROR $v was modified after it was applied; add a new migration instead" >&2
      exit 3
    fi
    continue
  fi
  echo "migrate: applying $v"
  q --single-transaction -f "$f" \
    -c "INSERT INTO schema_migrations (version, checksum) VALUES ('$v', '$sum')"
  applied=$((applied+1))
done
echo "migrate: done ($applied applied)"
