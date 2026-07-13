"""Database invariants for short-lived browser leases and their tool catalog."""

import datetime
import uuid

import psycopg
import pytest


def _token(db, user_id: str, name: str) -> str:
    row = db._conn.execute(
        """insert into api_tokens(user_id,name,token_prefix,token_hash,expires_at)
           values(%s,%s,%s,%s,now()+interval '1 day') returning id""",
        (user_id, name, name[:8], f"hash-{uuid.uuid4()}"),
    ).fetchone()
    return str(row["id"])


def _target(db) -> tuple[str, str]:
    server = db._conn.execute(
        "insert into servers(name,address) values(%s,%s) returning id",
        (f"Browser {uuid.uuid4()}", "example.com"),
    ).fetchone()
    plugin = db._conn.execute(
        """insert into server_plugins(server_id,plugin_key,instance_name,config)
           values(%s,'playwright','Browser',%s::jsonb) returning id""",
        (server["id"], '{"base_url":"https://example.com/","allowed_origins":["https://example.com"]}'),
    ).fetchone()
    return str(server["id"]), str(plugin["id"])


def _lease(db, server_id: str, plugin_id: str, user_id: str, token_id: str, slot: int) -> None:
    now = datetime.datetime.now(datetime.timezone.utc)
    db._conn.execute(
        """insert into leased_sessions(resource_kind,server_id,server_plugin_id,actor_user_id,actor_token_id,
             worker_lease_id,lease_slot,idle_expires_at,absolute_expires_at)
           values('browser',%s,%s,%s,%s,%s,%s,%s,%s)""",
        (server_id, plugin_id, user_id, token_id, uuid.uuid4(), slot,
         now + datetime.timedelta(minutes=5), now + datetime.timedelta(minutes=15)),
    )


def test_browser_tools_and_lease_schema_are_migrated(client, db):
    names = {row["name"] for row in db._conn.execute("select name from tool_definitions where plugin_key='playwright'").fetchall()}
    assert {"playwright.open_session", "playwright.navigate", "playwright.fill", "playwright.click"} <= names
    assert db.column_exists("leased_sessions", "worker_lease_id")
    assert db.column_exists("leased_sessions", "lease_slot")


def test_active_browser_lease_limits_are_database_enforced(client, db):
    server_id, plugin_id = _target(db)
    first, second, third = db.user(), db.user(), db.user()
    first_token, second_token, third_token = (_token(db, first["id"], "first"), _token(db, second["id"], "second"), _token(db, third["id"], "third"))
    _lease(db, server_id, plugin_id, first["id"], first_token, 1)
    with pytest.raises(psycopg.errors.UniqueViolation):
        _lease(db, server_id, plugin_id, first["id"], first_token, 2)
    _lease(db, server_id, plugin_id, second["id"], second_token, 2)
    with pytest.raises(psycopg.errors.UniqueViolation):
        _lease(db, server_id, plugin_id, third["id"], third_token, 1)


def test_terminal_lease_releases_token_and_plugin_slot(client, db):
    server_id, plugin_id = _target(db)
    user = db.user(); token = _token(db, user["id"], "reuse")
    _lease(db, server_id, plugin_id, user["id"], token, 1)
    db._conn.execute("update leased_sessions set status='closed',closed_at=now() where actor_token_id=%s", (token,))
    _lease(db, server_id, plugin_id, user["id"], token, 1)
