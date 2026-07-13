"""Phase 1 access-model integration checks: catalog metadata, scope removal, capability
tables, and audit metadata against the real migrated database + running API."""

from conftest import auth


def table_exists(db, table: str) -> bool:
    row = db._conn.execute(
        "select 1 from information_schema.tables where table_schema = 'public' and table_name = %s",
        (table,),
    ).fetchone()
    return row is not None


def test_token_scopes_column_is_removed(client, db):
    assert db.column_exists("api_tokens", "scopes") is False
    # Identity/ownership/expiry/revocation/prefix/last-use all survive.
    for column in ("user_id", "token_prefix", "token_hash", "expires_at", "revoked_at", "last_used_at"):
        assert db.column_exists("api_tokens", column) is True, column


def test_tool_definitions_have_catalog_metadata_columns(client, db):
    for column in ("domain", "action", "risk", "reversible", "executor_kind", "credential_kinds", "description", "reviewed"):
        assert db.column_exists("tool_definitions", column) is True, column


def test_server_capabilities_table_exists(client, db):
    assert table_exists(db, "server_capabilities") is True
    assert db.column_exists("server_capabilities", "server_plugin_id") is True
    assert db.column_exists("server_credentials", "server_plugin_id") is True


def test_plugin_runtime_tables_exist(client, db):
    assert table_exists(db, "plugins") is True
    assert table_exists(db, "server_plugins") is True
    assert db.column_exists("tool_definitions", "plugin_key") is True


def test_audit_events_have_normalized_metadata_columns(client, db):
    for column in ("executor_kind", "operation_id", "session_id", "reason", "tool_domain", "tool_action", "tool_risk", "error_class"):
        assert db.column_exists("audit_events", column) is True, column


def test_admin_tools_returns_catalog_version_and_axes(client, db):
    admin = db.user(role="global_admin")
    response = client.get("/admin/tools", headers=auth(admin["id"]))
    assert response.status_code == 200, response.text
    body = response.json()
    assert "catalog_version" in body
    assert body["actions"] == ["read", "create", "change", "remove", "operate"]
    assert "host_access" in body["domains"]


def test_token_creation_has_no_scopes(client, db):
    admin = db.user(role="global_admin")
    created = client.post(
        "/admin/tokens",
        headers=auth(admin["id"]),
        json={"user_id": admin["id"], "name": "phase1", "expires_at": "2035-01-01T00:00:00Z"},
    )
    assert created.status_code == 200, created.text
    token = created.json()["token"]
    assert "scopes" not in token
    assert isinstance(created.json()["secret"], str) and created.json()["secret"]

    listed = client.get("/admin/tokens", headers=auth(admin["id"]))
    assert listed.status_code == 200
    tokens = listed.json()["tokens"]
    assert any(row["name"] == "phase1" for row in tokens)
    assert all("scopes" not in row for row in tokens)
