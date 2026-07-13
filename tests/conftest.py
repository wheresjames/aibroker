"""Pytest fixtures for the AIBroker black-box API suite.

These are integration tests: they boot the real Fastify API server against a throwaway
Postgres database and drive it over HTTP. Requirements to run them:

  * A reachable Postgres (defaults to the docker-compose one on localhost:5432). Start it
    with `docker compose up -d postgres` if it is not already running.
  * Node/pnpm available on PATH (the same toolchain used by `pnpm dev`).
  * Python deps from tests/requirements.txt (`pip install -r tests/requirements.txt`).

If Postgres is not reachable, the server-backed tests are skipped (not failed) with a
message explaining how to start it. Pure tests (e.g. migration file checks) still run.

Configuration via environment:
  AIBROKER_TEST_ADMIN_DATABASE_URL  maintenance connection used to create/drop the test DB
                                    (default postgresql://aibroker:aibroker@localhost:5432/postgres)
  AIBROKER_TEST_DB_NAME             throwaway database name (default aibroker_pytest)
  AIBROKER_TEST_API_PORT            port the test API server listens on (default 8099)
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import signal
import subprocess
import tempfile
import time
from urllib.parse import urlsplit, urlunsplit

import httpx
import psycopg
import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADMIN_URL = os.environ.get(
    "AIBROKER_TEST_ADMIN_DATABASE_URL",
    "postgresql://aibroker:aibroker@localhost:5432/postgres",
)
TEST_DB_NAME = os.environ.get("AIBROKER_TEST_DB_NAME", "aibroker_pytest")
TEST_API_PORT = int(os.environ.get("AIBROKER_TEST_API_PORT", "8099"))
TEST_SESSION_SECRET = "pytest_session_secret_change_me_00"


def _test_database_url() -> str:
    parts = urlsplit(ADMIN_URL)
    return urlunsplit(parts._replace(path=f"/{TEST_DB_NAME}"))


@pytest.fixture(scope="session")
def test_database_url() -> str:
    """Create a throwaway test database and drop it when the session ends."""
    try:
        admin = psycopg.connect(ADMIN_URL, autocommit=True, connect_timeout=3)
    except Exception as exc:  # pragma: no cover - environment dependent
        pytest.skip(
            f"Postgres not reachable at {ADMIN_URL} ({exc}). "
            "Start it with `docker compose up -d postgres`."
        )
    try:
        admin.execute(f'drop database if exists "{TEST_DB_NAME}" with (force)')
        admin.execute(f'create database "{TEST_DB_NAME}"')
        yield _test_database_url()
    finally:
        try:
            admin.execute(f'drop database if exists "{TEST_DB_NAME}" with (force)')
        finally:
            admin.close()


def _terminate(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        proc.wait(timeout=10)
    except Exception:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            pass


@pytest.fixture(scope="session")
def api_base_url(test_database_url: str):
    """Boot the real API server against the test DB; it runs migrations on startup."""
    base_url = f"http://127.0.0.1:{TEST_API_PORT}"
    env = os.environ.copy()
    env.update(
        {
            "NODE_ENV": "test",
            "AIBROKER_API_PORT": str(TEST_API_PORT),
            "AIBROKER_DATABASE_URL": test_database_url,
            "AIBROKER_REDIS_URL": "redis://localhost:6379",
            "AIBROKER_SESSION_SECRET": TEST_SESSION_SECRET,
            "AIBROKER_ENCRYPTION_KEY_BASE64": base64.b64encode(b"\x00" * 32).decode(),
            "AIBROKER_ALLOW_PRIVATE_CONNECTOR_TARGETS": "true",
            "AIBROKER_MCP_ENABLED": "false",
        }
    )

    log = tempfile.TemporaryFile(mode="w+")
    proc = subprocess.Popen(
        ["corepack", "pnpm", "--filter", "@aibroker/api", "start"],
        cwd=REPO_ROOT,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

    deadline = time.time() + 90
    try:
        while time.time() < deadline:
            if proc.poll() is not None:
                log.seek(0)
                raise RuntimeError(f"API server exited early:\n{log.read()}")
            try:
                if httpx.get(f"{base_url}/health/ready", timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.5)
        else:
            _terminate(proc)
            log.seek(0)
            raise RuntimeError(f"API server did not become ready:\n{log.read()}")
        yield base_url
    finally:
        _terminate(proc)
        log.close()


class Seeder:
    """Insert users directly into the test database for fixture setup."""

    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn
        self._n = 0

    def user(
        self,
        role: str = "user",
        status: str = "active",
        owner_id: str | None = None,
        password_change_required: bool = False,
        email: str | None = None,
        display_name: str | None = None,
    ) -> dict:
        self._n += 1
        row = self._conn.execute(
            """
            insert into users (owner_user_id, email, display_name, password_hash, role, status, password_change_required)
            values (%s, %s, %s, %s, %s, %s, %s)
            returning id, owner_user_id, email, display_name, role, status
            """,
            (
                owner_id,
                email or f"user{self._n}@example.com",
                display_name or f"User {self._n}",
                "seeded-hash",
                role,
                status,
                password_change_required,
            ),
        ).fetchone()
        row["id"] = str(row["id"])
        if row["owner_user_id"] is not None:
            row["owner_user_id"] = str(row["owner_user_id"])
        return row

    def owner_of(self, user_id: str) -> str | None:
        row = self._conn.execute("select owner_user_id from users where id = %s", (user_id,)).fetchone()
        value = row["owner_user_id"] if row else None
        return str(value) if value is not None else None

    def status_of(self, user_id: str) -> str | None:
        row = self._conn.execute("select status from users where id = %s", (user_id,)).fetchone()
        return row["status"] if row else None

    def history_rows(self) -> list[dict]:
        return self._conn.execute(
            "select user_id, previous_owner_user_id, new_owner_user_id, changed_by_user_id, reason from user_ownership_history"
        ).fetchall()

    def audit_rows(self, event_type: str) -> list[dict]:
        return self._conn.execute(
            "select event_type, actor_user_id, status from audit_events where event_type = %s",
            (event_type,),
        ).fetchall()

    def column_exists(self, table: str, column: str) -> bool:
        row = self._conn.execute(
            "select 1 from information_schema.columns where table_schema = 'public' and table_name = %s and column_name = %s",
            (table, column),
        ).fetchone()
        return row is not None


@pytest.fixture()
def db(api_base_url: str, test_database_url: str):
    """A clean database per test, plus a Seeder. Depends on api_base_url so migrations ran."""
    conn = psycopg.connect(test_database_url, autocommit=True, row_factory=psycopg.rows.dict_row)
    conn.execute("truncate users, user_ownership_history, audit_events cascade")
    try:
        yield Seeder(conn)
    finally:
        conn.close()


@pytest.fixture()
def client(api_base_url: str):
    with httpx.Client(base_url=api_base_url, timeout=10) as http_client:
        yield http_client


def auth(user_id: str) -> dict:
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": user_id, "exp": int(time.time()) + 3600}, separators=(",", ":")).encode()
    ).decode().rstrip("=")
    signature = base64.urlsafe_b64encode(
        hmac.new(TEST_SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).digest()
    ).decode().rstrip("=")
    return {"x-aibroker-session": f"{payload}.{signature}"}
