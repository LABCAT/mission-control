#!/usr/bin/env bash
# Proves every Payload migration rolls back and re-applies: migrate up, roll every batch
# back down, then migrate up again. The schema before and after must match, so a down()
# that silently leaves tables behind fails the check instead of passing it.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a disposable Postgres database}"

command -v psql > /dev/null || {
  echo "::error::psql is required to inspect the schema"
  exit 1
}

cd "$(dirname "$0")/../../apps/cms"

psql_q() {
  psql "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"
}

applied_migration_count() {
  local exists
  exists=$(psql_q "SELECT to_regclass('public.payload_migrations') IS NOT NULL")
  if [ "$exists" != "t" ]; then
    echo 0
    return
  fi
  psql_q "SELECT count(*) FROM payload_migrations WHERE batch <> -1"
}

# One line per batch; empty once nothing is applied.
applied_batches() {
  local exists
  exists=$(psql_q "SELECT to_regclass('public.payload_migrations') IS NOT NULL")
  [ "$exists" = "t" ] || return 0
  psql_q "SELECT DISTINCT batch FROM payload_migrations WHERE batch <> -1 ORDER BY batch"
}

table_count() {
  psql_q "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"
}

# A stable description of everything a migration can create or drop.
schema_fingerprint() {
  psql_q "
    SELECT string_agg(line, E'\n' ORDER BY line) FROM (
      SELECT 'table ' || table_name AS line
        FROM information_schema.tables
       WHERE table_schema = 'public'
      UNION ALL
      SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type
             || ' nullable=' || is_nullable
             || ' default=' || coalesce(column_default, '-')
        FROM information_schema.columns
       WHERE table_schema = 'public'
      UNION ALL
      SELECT 'index ' || indexname || ' ' || indexdef
        FROM pg_indexes
       WHERE schemaname = 'public'
      UNION ALL
      SELECT 'constraint ' || conrelid::regclass::text || ' ' || conname || ' '
             || pg_get_constraintdef(oid)
        FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace
    ) lines"
}

echo "==> Migrating up"
pnpm payload migrate

migrations_up=$(applied_migration_count)
if [ "$migrations_up" -eq 0 ]; then
  echo "::error::No migrations ran, so there is nothing to prove"
  exit 1
fi
before=$(schema_fingerprint)
echo "Applied $migrations_up migration(s) in $(table_count) table(s)"

echo "==> Rolling back"
# migrate:down rolls back one batch, so loop until no batch is left. That covers a PR that
# adds a second batch as well as a fresh database where everything landed in batch 1.
guard=0
while [ -n "$(applied_batches)" ]; do
  guard=$((guard + 1))
  if [ "$guard" -gt 50 ]; then
    echo "::error::Still rolling back after 50 batches; migrate:down is not clearing migrations"
    exit 1
  fi
  pnpm payload migrate:down
done

tables_left=$(table_count)
if [ "$tables_left" -ne 0 ]; then
  echo "::error::$tables_left table(s) left in the public schema after rolling back:"
  psql_q "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
  exit 1
fi
echo "Rolled back cleanly: no migrations and no tables left"

echo "==> Migrating up again"
pnpm payload migrate

reapplied=$(applied_migration_count)
if [ "$reapplied" -ne "$migrations_up" ]; then
  echo "::error::Re-applied $reapplied of $migrations_up migration(s)"
  exit 1
fi

after=$(schema_fingerprint)
if [ "$before" != "$after" ]; then
  echo "::error::The re-applied schema differs from the schema before the rollback:"
  diff <(echo "$before") <(echo "$after") || true
  exit 1
fi
echo "Round-trip clean: $reapplied migration(s) re-applied and $(table_count) table(s) restored identically"
