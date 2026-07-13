#!/usr/bin/env bash
set -Eeuo pipefail

DATABASE_URL="${AIBROKER_DATABASE_URL:?Set AIBROKER_DATABASE_URL}"
BACKUP_FILE="${1:?Usage: ./scripts/restore-postgres.sh <backup.sql.gz|backup.sql.gz.age>}"

case "$BACKUP_FILE" in
  *.age)
    age -d "$BACKUP_FILE" | gunzip | psql "$DATABASE_URL"
    ;;
  *.gz)
    gunzip -c "$BACKUP_FILE" | psql "$DATABASE_URL"
    ;;
  *)
    psql "$DATABASE_URL" < "$BACKUP_FILE"
    ;;
esac

echo "Restore complete"
