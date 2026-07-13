# API integration tests (pytest)

Black-box integration tests for the AIBroker admin/user API. Each test boots the **real**
Fastify API server against a **throwaway Postgres database** and drives it over HTTP, so
they exercise the actual routing, SQL (including the recursive ownership queries), and the
migration-007 owner-role trigger.

## What is covered

| File | Area |
|---|---|
| `test_access_control.py` | `requireAdmin` gating of `/admin/*` (only active team/global admins) |
| `test_ownership_create.py` | `POST /admin/users` — only team/global admins can own users |
| `test_ownership_move.py` | `POST /admin/users/:id/move` — server-side move validation |
| `test_users_list.py` | `GET /admin/users` scoping/counts and the disable endpoint |
| `test_migrations.py` | Static check that migration 007 installs the owner-role trigger (no server needed) |

> The old frontend `nav-access` unit test is intentionally not ported: `canAccessNav` is
> pure client-side TypeScript with no server surface. The security guarantee it backs —
> non-admins cannot reach the users page — is covered here by `test_access_control.py`.

## Requirements

- **Postgres** reachable (defaults to the docker-compose instance on `localhost:5432`):
  ```bash
  docker compose up -d postgres
  ```
- **Node toolchain** on `PATH` (same one `pnpm dev` uses) — the fixtures start the API via
  `pnpm --filter @aibroker/api start`.
- **Python deps**:
  ```bash
  pip install -r tests/requirements.txt
  ```

If Postgres is not reachable, the server-backed tests are **skipped** (not failed) with a
message; `test_migrations.py` still runs.

## Running

```bash
pytest                 # from the repo root
pytest tests -v        # verbose
```

The fixtures create a throwaway database (`aibroker_pytest` by default), so your dev data
in `aibroker` is never touched, and drop it at the end.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `AIBROKER_TEST_ADMIN_DATABASE_URL` | `postgresql://aibroker:aibroker@localhost:5432/postgres` | Maintenance connection used to create/drop the test DB |
| `AIBROKER_TEST_DB_NAME` | `aibroker_pytest` | Name of the throwaway test database |
| `AIBROKER_TEST_API_PORT` | `8099` | Port the test API server listens on |
