"""Authenticated browser state must be confined to explicit path prefixes (AB-ELEMENTOR D15)."""

import json
import uuid

from conftest import auth

STATE = {"cookies": [{"name": "sid", "value": "x", "domain": "example.com", "path": "/"}], "origins": []}


def _target(db, prefixes: list[str] | None) -> tuple[str, str]:
    config = {"base_url": "https://example.com/", "allowed_origins": ["https://example.com"]}
    if prefixes is not None:
        config["allowed_path_prefixes"] = prefixes
    server = db._conn.execute(
        "insert into servers(name,address) values(%s,%s) returning id", (f"Scope {uuid.uuid4()}", "example.com")
    ).fetchone()
    plugin = db._conn.execute(
        """insert into server_plugins(server_id,plugin_key,instance_name,config)
           values(%s,'playwright','Browser',%s::jsonb) returning id""",
        (server["id"], json.dumps(config)),
    ).fetchone()
    return str(server["id"]), str(plugin["id"])


def _save_state(client, admin, server_id, plugin_id):
    return client.post(
        f"/admin/servers/{server_id}/plugins/{plugin_id}/credential",
        json={"storage_state": STATE}, headers=auth(admin["id"]),
    )


def test_storage_state_rejected_without_path_prefixes(client, db):
    admin = db.user(role="global_admin")
    for prefixes in (None, [], ["/"]):
        server_id, plugin_id = _target(db, prefixes)
        response = _save_state(client, admin, server_id, plugin_id)
        assert response.status_code == 400, prefixes
        assert "allowed_path_prefixes" in response.json().get("message", "")


def test_storage_state_accepted_with_narrow_prefixes(client, db):
    admin = db.user(role="global_admin")
    server_id, plugin_id = _target(db, ["/app"])
    assert _save_state(client, admin, server_id, plugin_id).status_code == 200


def test_prefixes_cannot_be_widened_while_state_is_stored(client, db):
    admin = db.user(role="global_admin")
    server_id, plugin_id = _target(db, ["/app"])
    assert _save_state(client, admin, server_id, plugin_id).status_code == 200
    base = {"base_url": "https://example.com/", "allowed_origins": ["https://example.com"]}
    for prefixes in ([], ["/"]):
        response = client.patch(
            f"/admin/servers/{server_id}/plugins/{plugin_id}",
            json={"config": {**base, "allowed_path_prefixes": prefixes}}, headers=auth(admin["id"]),
        )
        assert response.status_code == 400, prefixes
    ok = client.patch(
        f"/admin/servers/{server_id}/plugins/{plugin_id}",
        json={"config": {**base, "allowed_path_prefixes": ["/app", "/account"]}}, headers=auth(admin["id"]),
    )
    assert ok.status_code == 200
