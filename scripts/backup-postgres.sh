#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
DATABASE_URL="${AIBROKER_DATABASE_URL:?Set AIBROKER_DATABASE_URL}"
AGE_RECIPIENT="${AIBROKER_BACKUP_AGE_RECIPIENT:-}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/aibroker-${STAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"
pg_dump "$DATABASE_URL" | gzip -9 > "$OUT"

if [[ -n "$AGE_RECIPIENT" ]]; then
  age -r "$AGE_RECIPIENT" -o "${OUT}.age" "$OUT"
  rm -f "$OUT"
  OUT="${OUT}.age"
fi

echo "Backup written: $OUT"
