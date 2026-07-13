#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TEST_DATABASE_URL="${AIBROKER_RESTORE_TEST_DATABASE_URL:?Set AIBROKER_RESTORE_TEST_DATABASE_URL}"

latest="$(find "$BACKUP_DIR" -type f \( -name '*.sql' -o -name '*.sql.gz' -o -name '*.sql.gz.age' \) | sort | tail -n 1)"
if [[ -z "$latest" ]]; then
  echo "No backup files found in $BACKUP_DIR" >&2
  exit 1
fi

echo "Restoring $latest into isolated test database"
AIBROKER_DATABASE_URL="$TEST_DATABASE_URL" "$(dirname "$0")/restore-postgres.sh" "$latest"
psql "$TEST_DATABASE_URL" -c "select count(*) as audit_events from audit_events;"
psql "$TEST_DATABASE_URL" -c "select count(*) as credentials from site_credentials;"
echo "Backup drill complete"
