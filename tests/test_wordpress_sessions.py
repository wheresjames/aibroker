"""WordPress login sessions and the Elementor page-builder tools (AB-ELEMENTOR Phase 1).

The endpoint tests always run. The live end-to-end test drives the real MCP call path
against a WordPress + Elementor site and runs only when these are set:

  AIBROKER_ELEMENTOR_CONTRACT_URL       e.g. http://localhost:18089
  AIBROKER_ELEMENTOR_CONTRACT_USER      WordPress user (Editor role is enough)
  AIBROKER_ELEMENTOR_CONTRACT_APP_PASSWORD  an application password for that user
  AIBROKER_ELEMENTOR_CONTRACT_PASSWORD  the user's login password (for the session)
  AIBROKER_ELEMENTOR_CONTRACT_POST_ID   a published Elementor page with a heading widget
"""

import base64
import datetime
import json
import os
import re
import uuid

import httpx
import pytest

from conftest import auth

ELEMENTOR_TOOLS = [
    "wordpress.elementor_get_document", "wordpress.elementor_apply_operations", "wordpress.elementor_list_widget_types",
    "wordpress.elementor_list_snapshots", "wordpress.elementor_restore_snapshot",
]


def _wordpress_target(db, base_url: str = "https://example.com") -> tuple[str, str]:
    server = db._conn.execute(
        "insert into servers(name,address) values(%s,%s) returning id", (f"WP {uuid.uuid4()}", httpx.URL(base_url).host)
    ).fetchone()
    plugin = db._conn.execute(
        """insert into server_plugins(server_id,plugin_key,instance_name,config)
           values(%s,'wordpress','Site',%s::jsonb) returning id""",
        (server["id"], json.dumps({"base_url": base_url})),
    ).fetchone()
    return str(server["id"]), str(plugin["id"])


def _grant(db, user_id: str, server_id: str, admin_id: str, tools: list[str]) -> None:
    policy = db._conn.execute(
        "insert into policies(name,created_by) values(%s,%s) returning id", (f"Elementor {uuid.uuid4()}", admin_id)
    ).fetchone()
    for tool in tools:
        db._conn.execute("insert into policy_permissions(policy_id,tool_name,effect) values(%s,%s,'allow')", (policy["id"], tool))
    db._conn.execute(
        """insert into server_bindings(subject_type,subject_id,server_id,policy_id,created_by)
           values('user',%s,%s,%s,%s)""", (user_id, server_id, policy["id"], admin_id),
    )


def test_session_endpoints_require_a_bound_wordpress_plugin(client, db):
    admin, user, stranger = db.user(role="global_admin"), db.user(), db.user()
    server_id, plugin_id = _wordpress_target(db)
    _grant(db, user["id"], server_id, admin["id"], ELEMENTOR_TOOLS[:1])

    listed = client.get("/me/wordpress-sessions", headers=auth(user["id"]))
    assert listed.status_code == 200
    assert [(row["server_plugin_id"], row["state"]) for row in listed.json()["sessions"]] == [(plugin_id, "not_connected")]
    assert client.get("/me/wordpress-sessions", headers=auth(stranger["id"])).json()["sessions"] == []

    missing = client.post("/me/wordpress-sessions", json={"server_plugin_id": plugin_id, "username": "u"}, headers=auth(user["id"]))
    assert missing.status_code == 400
    unbound = client.post("/me/wordpress-sessions", json={"server_plugin_id": plugin_id, "username": "u", "password": "p"},
                          headers=auth(stranger["id"]))
    assert unbound.status_code == 404
    assert client.delete(f"/me/wordpress-sessions/{plugin_id}", headers=auth(user["id"])).status_code == 404


def test_session_credentials_are_owned_and_unique_per_user(db):
    user = db.user()
    _server_id, plugin_id = _wordpress_target(db)
    insert = """insert into server_credentials(server_plugin_id,kind,owner_user_id,encrypted_payload)
                values(%s,%s,%s,'{}'::jsonb)"""
    db._conn.execute(insert, (plugin_id, "wordpress_session", user["id"]))
    with pytest.raises(Exception):
        db._conn.execute(insert, (plugin_id, "wordpress_session", user["id"]))
    with pytest.raises(Exception):
        db._conn.execute(insert, (plugin_id, "wordpress_session", None))
    with pytest.raises(Exception):
        db._conn.execute(insert, (plugin_id, "wordpress_rest_application_password", user["id"]))


def test_capture_endpoints_are_owner_only_and_expire(client, db):
    owner, other = db.user(), db.user()
    _server_id, plugin_id = _wordpress_target(db)
    capture = db._conn.execute(
        """insert into credential_captures(server_plugin_id, owner_user_id, kind, expires_at)
           values(%s,%s,'wordpress_two_factor', now() + interval '5 minutes') returning id""", (plugin_id, owner["id"])).fetchone()
    capture_id = str(capture["id"])
    foreign = client.post("/me/wordpress-sessions/two-factor", json={"capture_id": capture_id, "code": "123456"}, headers=auth(other["id"]))
    assert foreign.status_code == 404
    assert client.post(f"/me/login-captures/{capture_id}/frame", headers=auth(owner["id"])).status_code == 404, "2FA captures have no browser"
    assert client.delete(f"/me/login-captures/{capture_id}", headers=auth(other["id"])).status_code == 404
    assert client.delete(f"/me/login-captures/{capture_id}", headers=auth(owner["id"])).json() == {"status": "cancelled"}

    expired = db._conn.execute(
        """insert into credential_captures(server_plugin_id, owner_user_id, kind, expires_at)
           values(%s,%s,'wordpress_two_factor', now() - interval '1 second') returning id""", (plugin_id, owner["id"])).fetchone()
    response = client.post("/me/wordpress-sessions/two-factor", json={"capture_id": str(expired["id"]), "code": "123456"}, headers=auth(owner["id"]))
    assert response.status_code == 404
    assert db._conn.execute("select status from credential_captures where id=%s", (expired["id"],)).fetchone()["status"] == "expired"


CONTRACT = {key: os.environ.get(f"AIBROKER_ELEMENTOR_CONTRACT_{key}") for key in ("URL", "USER", "APP_PASSWORD", "PASSWORD", "POST_ID")}


@pytest.mark.skipif(not all(CONTRACT.values()), reason="live Elementor contract site not configured")
def test_elementor_tools_end_to_end(client, db):
    admin, user = db.user(role="global_admin"), db.user()
    server_id, plugin_id = _wordpress_target(db, CONTRACT["URL"])
    _grant(db, user["id"], server_id, admin["id"], ELEMENTOR_TOOLS)
    saved = client.post(f"/admin/servers/{server_id}/plugins/{plugin_id}/credential",
                        json={"username": CONTRACT["USER"], "application_password": CONTRACT["APP_PASSWORD"]}, headers=auth(admin["id"]))
    assert saved.status_code == 200, saved.text
    expires = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1)).isoformat()
    secret = client.post("/me/tokens", json={"name": "elementor", "expires_at": expires}, headers=auth(user["id"])).json()["secret"]
    bearer = {"authorization": f"Bearer {secret}"}
    post_id = CONTRACT["POST_ID"]

    def call(tool: str, **input):
        response = client.post("/mcp/call", json={"tool": f"wordpress.elementor_{tool}", "input": {"server_plugin_id": plugin_id, "id": post_id, **input}},
                               headers=bearer, timeout=60)
        return response.status_code, response.json()

    def heading(document: dict) -> dict:
        def find(nodes):
            for node in nodes:
                if node.get("widgetType") == "heading":
                    return node
                found = find(node.get("children", []))
                if found:
                    return found
        return find(document["outline"])

    def live_html() -> str:
        return httpx.get(f"{CONTRACT['URL']}/?page_id={post_id}", follow_redirects=True, timeout=30).text

    status, body = call("get_document")
    assert status == 200, body
    document = body["result"]
    target = heading(document)
    marker = f"AIBroker {uuid.uuid4().hex[:6]}"
    key = lambda: uuid.uuid4().hex + uuid.uuid4().hex[:8]

    # A published page needs publish: true when no session can hold a draft.
    status, body = call("apply_operations", expected_hash=document["hash"], idempotency_key=key(),
                        operations=[{"action": "update_settings", "element_id": target["id"], "settings": {"title": marker}}])
    assert status == 409 and body["error"] == "publish_confirmation_required", body

    status, body = call("apply_operations", expected_hash=document["hash"], idempotency_key=key(), publish=True,
                        operations=[{"action": "update_settings", "element_id": target["id"], "settings": {"title": marker}},
                                    {"action": "insert", "parent_id": None, "element": {"elType": "container", "elements": [
                                        {"elType": "widget", "widgetType": "button", "settings": {"text": "Contact"}}]}}])
    assert status == 200, body
    applied = body["result"]
    assert applied["transport"] == "rest" and applied["cache"] in ("refreshed", "site_cache_cleared"), applied
    assert marker in live_html()

    # Stale hashes are refused.
    status, body = call("apply_operations", expected_hash=document["hash"], idempotency_key=key(), publish=True,
                        operations=[{"action": "remove", "element_id": applied["created_ids"][0]}])
    assert status == 409 and body["error"] == "revision_conflict", body

    # With a session, a change to the live page becomes the caller's draft preview.
    connected = client.post("/me/wordpress-sessions", json={"server_plugin_id": plugin_id, "username": CONTRACT["USER"],
                                                             "password": CONTRACT["PASSWORD"]}, headers=auth(user["id"]), timeout=60)
    assert connected.status_code == 200, connected.text
    assert [row["state"] for row in client.get("/me/wordpress-sessions", headers=auth(user["id"])).json()["sessions"]] == ["connected"]
    status, body = call("get_document", view="draft")
    assert status == 200, body
    draft_marker = f"Draft {uuid.uuid4().hex[:6]}"
    status, body = call("apply_operations", expected_hash=body["result"]["hash"], idempotency_key=key(),
                        operations=[{"action": "update_settings", "element_id": target["id"], "settings": {"title": draft_marker}}])
    assert status == 200 and body["result"]["saved_as"] == "draft_preview", body
    html = live_html()
    assert marker in html and draft_marker not in html

    status, body = call("list_widget_types")
    assert status == 200 and "heading" in body["result"]["widget_types"], body

    # Roll the live page back to its state before the first change.
    status, body = call("list_snapshots")
    first_snapshot = body["result"]["snapshots"][-1]["id"]
    status, live = call("get_document")
    status, body = call("restore_snapshot", snapshot_id=first_snapshot, expected_hash=live["result"]["hash"], idempotency_key=key(), publish=True)
    assert status == 200, body
    assert marker not in live_html()

    disconnected = client.delete(f"/me/wordpress-sessions/{plugin_id}", headers=auth(user["id"]))
    assert disconnected.status_code == 200
    assert [row["state"] for row in client.get("/me/wordpress-sessions", headers=auth(user["id"])).json()["sessions"]] == ["not_connected"]


# ---- AB-ELEMENTOR Phase 2: 2FA relay, live browser login, templates, page settings ----
#
# Extra variables for the Phase 2 live tests:
#   AIBROKER_ELEMENTOR_CONTRACT_2FA_USER / _2FA_PASSWORD / _2FA_SECRET  an account enrolled in
#       TOTP two-factor (Two Factor, WP 2FA or Wordfence); the secret is its base32 key
#   AIBROKER_ELEMENTOR_CONTRACT_BROWSER=1   a browser worker is running for live captures
#   AIBROKER_ELEMENTOR_CONTRACT_ADMIN_USER / _ADMIN_APP_PASSWORD  an administrator (templates)

import hashlib
import hmac
import struct
import time

PHASE2 = {key: os.environ.get(f"AIBROKER_ELEMENTOR_CONTRACT_{key}") for key in (
    "2FA_USER", "2FA_PASSWORD", "2FA_SECRET", "BROWSER", "ADMIN_USER", "ADMIN_APP_PASSWORD")}


def _totp(secret: str) -> str:
    key = base64.b32decode(secret.upper() + "=" * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack(">Q", int(time.time() // 30)), hashlib.sha1).digest()
    offset = digest[-1] & 15
    return str((struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000).zfill(6)


def _live_target(client, db):
    admin, user = db.user(role="global_admin"), db.user()
    server_id, plugin_id = _wordpress_target(db, CONTRACT["URL"])
    _grant(db, user["id"], server_id, admin["id"], ELEMENTOR_TOOLS + [
        "wordpress.elementor_set_page_settings", "wordpress.elementor_list_templates", "wordpress.elementor_apply_unsafe_operations"])
    saved = client.post(f"/admin/servers/{server_id}/plugins/{plugin_id}/credential",
                        json={"username": CONTRACT["USER"], "application_password": CONTRACT["APP_PASSWORD"]}, headers=auth(admin["id"]))
    assert saved.status_code == 200, saved.text
    return admin, user, server_id, plugin_id


@pytest.mark.skipif(not (CONTRACT["URL"] and PHASE2["2FA_USER"] and PHASE2["2FA_PASSWORD"] and PHASE2["2FA_SECRET"]),
                    reason="live two-factor account not configured")
def test_two_factor_relay_end_to_end(client, db):
    _admin, user, _server_id, plugin_id = _live_target(client, db)
    started = client.post("/me/wordpress-sessions", json={"server_plugin_id": plugin_id, "username": PHASE2["2FA_USER"],
                                                           "password": PHASE2["2FA_PASSWORD"]}, headers=auth(user["id"]), timeout=60)
    assert started.status_code == 409 and started.json()["error"] == "two_factor_required", started.text
    capture_id = started.json()["capture_id"]
    missing = client.post("/me/wordpress-sessions/two-factor", json={"capture_id": str(uuid.uuid4()), "code": "123456"}, headers=auth(user["id"]))
    assert missing.status_code == 404
    done = client.post("/me/wordpress-sessions/two-factor", json={"capture_id": capture_id, "code": _totp(PHASE2["2FA_SECRET"])},
                       headers=auth(user["id"]), timeout=60)
    assert done.status_code == 200, done.text
    assert done.json()["session"]["state"] == "connected"
    row = db._conn.execute("select status, encrypted_payload from credential_captures where id=%s", (capture_id,)).fetchone()
    assert row["status"] == "completed" and row["encrypted_payload"] == {}


def _drive_login(client, user_id: str, capture_id: str, username: str, password: str) -> None:
    """wp-login.php focuses the username field on load; type, tab, type, enter."""
    events = [{"type": "text", "text": username}, {"type": "key", "key": "Tab"}, {"type": "text", "text": password}, {"type": "key", "key": "Enter"}]
    response = client.post(f"/me/login-captures/{capture_id}/input", json={"events": events}, headers=auth(user_id), timeout=60)
    assert response.status_code == 200, response.text


@pytest.mark.skipif(not (all(CONTRACT.values()) and PHASE2["BROWSER"]), reason="live browser worker not configured")
def test_live_browser_login_end_to_end(client, db):
    _admin, user, _server_id, plugin_id = _live_target(client, db)
    started = client.post("/me/wordpress-sessions/browser", json={"server_plugin_id": plugin_id}, headers=auth(user["id"]), timeout=60)
    assert started.status_code == 200, started.text
    capture_id, frame = started.json()["capture_id"], started.json()["frame"]
    assert frame["status"] == "active" and "wp-login.php" in frame["url"] and len(frame["image_base64"]) > 1000
    other = db.user()
    assert client.post(f"/me/login-captures/{capture_id}/frame", headers=auth(other["id"])).status_code == 404

    _drive_login(client, user["id"], capture_id, CONTRACT["USER"], CONTRACT["PASSWORD"])
    for _ in range(30):
        finished = client.post(f"/me/login-captures/{capture_id}/finish", headers=auth(user["id"]), timeout=60)
        assert finished.status_code == 200, finished.text
        if finished.json()["status"] == "completed":
            break
        time.sleep(1)
    assert finished.json()["session"]["state"] == "connected", finished.text
    assert [row["state"] for row in client.get("/me/wordpress-sessions", headers=auth(user["id"])).json()["sessions"]] == ["connected"]


@pytest.mark.skipif(not (all(CONTRACT.values()) and PHASE2["BROWSER"]), reason="live browser worker not configured")
def test_playwright_state_captured_with_live_browser(client, db):
    admin = db.user(role="global_admin")
    origin = CONTRACT["URL"].rstrip("/")
    server = db._conn.execute("insert into servers(name,address) values(%s,%s) returning id", (f"PW {uuid.uuid4()}", "localhost")).fetchone()
    plugin = db._conn.execute(
        """insert into server_plugins(server_id,plugin_key,instance_name,config) values(%s,'playwright','Browser',%s::jsonb) returning id""",
        (server["id"], json.dumps({"base_url": f"{origin}/", "allowed_origins": [origin], "allowed_path_prefixes": ["/wp-admin"],
                                   "viewport_width": 1280, "viewport_height": 800, "locale": "en-US", "timezone": "UTC", "color_scheme": "light"})),
    ).fetchone()
    started = client.post(f"/admin/servers/{server['id']}/plugins/{plugin['id']}/credential/capture",
                          json={"start_url": f"{origin}/wp-login.php"}, headers=auth(admin["id"]), timeout=60)
    assert started.status_code == 200, started.text
    capture_id = started.json()["capture_id"]
    _drive_login(client, admin["id"], capture_id, CONTRACT["USER"], CONTRACT["PASSWORD"])
    time.sleep(3)
    finished = client.post(f"/me/login-captures/{capture_id}/finish", headers=auth(admin["id"]), timeout=60)
    assert finished.status_code == 200 and finished.json()["status"] == "completed", finished.text
    stored = db._conn.execute("select count(*) as n from server_credentials where server_plugin_id=%s and kind='browser_storage_state' and status='active'",
                              (plugin["id"],)).fetchone()
    assert stored["n"] == 1


@pytest.mark.skipif(not (all(CONTRACT.values()) and PHASE2["ADMIN_USER"] and PHASE2["ADMIN_APP_PASSWORD"]), reason="live template admin not configured")
def test_page_settings_templates_and_unsafe_end_to_end(client, db):
    _admin, user, _server_id, plugin_id = _live_target(client, db)
    base = CONTRACT["URL"].rstrip("/")
    admin_auth = (PHASE2["ADMIN_USER"], PHASE2["ADMIN_APP_PASSWORD"])
    marker = uuid.uuid4().hex[:6]
    tree = [{"id": "a0b1c2d", "elType": "container", "settings": {}, "elements": [
        {"id": "b0c1d2e", "elType": "widget", "widgetType": "heading", "settings": {"title": f"Template {marker}"}, "elements": []}]}]
    template = httpx.post(f"{base}/wp-json/wp/v2/elementor_library", auth=admin_auth, timeout=30, json={
        "title": f"Hero {marker}", "status": "publish",
        "meta": {"_elementor_edit_mode": "builder", "_elementor_template_type": "container", "_elementor_data": json.dumps(tree)}})
    assert template.status_code == 201, template.text
    template_id = template.json()["id"]
    page = httpx.post(f"{base}/wp-json/wp/v2/pages", auth=admin_auth, timeout=30, json={
        "title": f"P2 {marker}", "status": "draft",
        "meta": {"_elementor_edit_mode": "builder", "_elementor_template_type": "wp-page", "_elementor_data": "[]", "_elementor_page_settings": {"hide_title": "yes"}}})
    assert page.status_code == 201, page.text
    post_id = str(page.json()["id"])

    expires = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1)).isoformat()
    secret = client.post("/me/tokens", json={"name": "p2", "expires_at": expires}, headers=auth(user["id"])).json()["secret"]
    key = lambda: uuid.uuid4().hex + uuid.uuid4().hex[:8]

    def call(tool: str, **input):
        response = client.post("/mcp/call", json={"tool": f"wordpress.elementor_{tool}", "input": {"server_plugin_id": plugin_id, "id": post_id, **input}},
                               headers={"authorization": f"Bearer {secret}"}, timeout=60)
        return response.status_code, response.json()

    # Templates need a session for an Editor credential; connect one.
    connected = client.post("/me/wordpress-sessions", json={"server_plugin_id": plugin_id, "username": CONTRACT["USER"], "password": CONTRACT["PASSWORD"]},
                            headers=auth(user["id"]), timeout=60)
    assert connected.status_code == 200, connected.text
    status, body = call("list_templates", search=marker)
    assert status == 200 and [t["id"] for t in body["result"]["templates"]] == [template_id], body

    status, body = call("get_document", include_page_settings=True)
    assert status == 200 and body["result"]["page_settings"]["hide_title"] == "yes", body
    document = body["result"]
    status, body = call("apply_operations", expected_hash=document["hash"], idempotency_key=key(),
                        operations=[{"action": "insert_template", "template_id": template_id, "parent_id": None}])
    assert status == 200, body
    status, body = call("set_page_settings", expected_settings_hash=document["settings_hash"], idempotency_key=key(),
                        settings={"hide_title": None, "background_background": "classic", "background_color": "#123456"})
    assert status == 200, body
    status, body = call("apply_operations", expected_hash=body["result"]["hash"], idempotency_key=key(),
                        operations=[{"action": "insert", "parent_id": None, "element": {"elType": "widget", "widgetType": "html"}}])
    assert status == 403 and body["error"] == "unsafe_content", body
    status, body = call("get_document", include_page_settings=True)
    stored = httpx.get(f"{base}/wp-json/wp/v2/pages/{post_id}?context=edit", auth=admin_auth, timeout=30).json()
    assert f"Template {marker}" in stored["meta"]["_elementor_data"]
    assert "b0c1d2e" not in stored["meta"]["_elementor_data"], "template elements must get fresh ids"
    assert stored["meta"]["_elementor_page_settings"].get("background_color") == "#123456"
    assert "hide_title" not in stored["meta"]["_elementor_page_settings"]
