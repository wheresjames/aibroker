#!/usr/bin/env bash
#
# Run every test suite in the repo:
#   1. JS/TS unit tests (vitest, across all pnpm workspaces)
#   2. Python API integration tests (pytest)
#
# The pytest suite needs a reachable Postgres (see tests/README.md). If one is already
# listening (e.g. `docker compose up -d postgres`) it is used as-is; otherwise, when Docker
# is available, this script starts a throwaway Postgres for the run and removes it after.
# Without Postgres and without Docker, the server-backed tests skip rather than fail.
#
# Both suites run even if the first fails, so you see all results in one pass.
#
# Usage: ./test.sh [extra args passed to pytest]

set -uo pipefail
cd "$(dirname "$0")"

PG_HOST="${AIBROKER_TEST_PG_HOST:-localhost}"
PG_PORT="${AIBROKER_TEST_PG_PORT:-5432}"
PG_CONTAINER="aibroker-test-pg"
started_pg=""
status=0

cleanup() {
  if [ -n "$started_pg" ]; then
    echo "==> Removing throwaway Postgres"
    docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

pg_reachable() {
  timeout 2 bash -c "exec 3<>/dev/tcp/${PG_HOST}/${PG_PORT}" 2>/dev/null
}

echo "==> JS/TS tests (vitest via pnpm)"
corepack pnpm -r test || status=1

echo
if pg_reachable; then
  echo "==> Using Postgres already listening on ${PG_HOST}:${PG_PORT}"
elif command -v docker >/dev/null 2>&1; then
  echo "==> Starting throwaway Postgres on port ${PG_PORT} for integration tests"
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  if docker run -d --name "$PG_CONTAINER" \
      -e POSTGRES_USER=aibroker -e POSTGRES_PASSWORD=aibroker -e POSTGRES_DB=aibroker \
      -p "${PG_PORT}:5432" postgres:16-alpine >/dev/null 2>&1; then
    started_pg=1
    for _ in $(seq 1 30); do
      docker exec "$PG_CONTAINER" pg_isready -U aibroker >/dev/null 2>&1 && break
      sleep 1
    done
  else
    echo "!! Could not start Postgres via Docker; integration tests will be skipped." >&2
  fi
else
  echo "!! No Postgres reachable and Docker not found; integration tests will be skipped." >&2
fi

echo
echo "==> Python API integration tests (pytest)"
python3 -m pytest "$@" || status=1

echo
if [ "$status" -eq 0 ]; then
  echo "✅ All test suites passed."
else
  echo "❌ One or more test suites failed." >&2
fi
exit "$status"
