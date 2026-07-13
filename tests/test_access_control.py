"""Admin route access control: only active team_admins/global_admins reach /admin/*."""

from conftest import auth

# Representative admin surfaces. The users page is the focus, but every /admin/* route is
# gated by the same requireAdmin preHandler, so they must behave alike.
ADMIN_ROUTES = ["/admin/users", "/admin/groups", "/admin/sites", "/admin/tokens", "/admin/summary"]

MISSING_UUID = "00000000-0000-0000-0000-000000000000"


def test_requires_an_admin_identity_header(client, db):
    for url in ADMIN_ROUTES:
        response = client.get(url)
        assert response.status_code == 401, url
        assert response.json() == {"error": "admin_auth_required"}


def test_rejects_an_unknown_user_id(client, db):
    response = client.get("/admin/users", headers=auth(MISSING_UUID))
    assert response.status_code == 403
    assert response.json() == {"error": "admin_denied"}


def test_denies_non_admin_roles_on_every_admin_route(client, db):
    actors = [db.user(role="user"), db.user(role="auditor")]
    for actor in actors:
        for url in ADMIN_ROUTES:
            response = client.get(url, headers=auth(actor["id"]))
            assert response.status_code == 403, f'{actor["role"]} {url}'
            assert response.json() == {"error": "admin_denied"}


def test_denies_disabled_admins(client, db):
    admin = db.user(role="team_admin", status="disabled")
    response = client.get("/admin/users", headers=auth(admin["id"]))
    assert response.status_code == 403
    assert response.json() == {"error": "admin_denied"}


def test_blocks_admins_that_still_owe_a_password_change(client, db):
    admin = db.user(role="global_admin", password_change_required=True)
    response = client.get("/admin/users", headers=auth(admin["id"]))
    assert response.status_code == 403
    assert response.json() == {"error": "password_change_required"}


def test_allows_team_and_global_admins_to_load_the_users_page(client, db):
    for role in ("team_admin", "global_admin"):
        admin = db.user(role=role)
        response = client.get("/admin/users", headers=auth(admin["id"]))
        assert response.status_code == 200, role
        assert isinstance(response.json()["users"], list)


def test_global_admin_can_load_every_page_data_endpoint(client, db):
    admin = db.user(role="global_admin")
    endpoints = [
        "/admin/summary",
        "/admin/users",
        "/admin/groups",
        "/admin/servers",
        "/admin/tokens",
        "/admin/policies",
        "/admin/bindings",
        "/admin/tools",
        "/admin/audit-events",
        "/me/tokens",
        "/me/activity",
        "/me/broker-config",
    ]
    for url in endpoints:
        response = client.get(url, headers=auth(admin["id"]))
        assert response.status_code == 200, f"{url}: {response.text}"


def test_servers_have_only_server_level_addressing(client, db):
    admin = db.user(role="global_admin")
    response = client.post(
        "/admin/servers",
        headers=auth(admin["id"]),
        json={"name": "Explicit policy server", "address": "example.com"},
    )
    assert response.status_code == 200, response.text
    body = response.json()["server"]
    assert body["address"] == "example.com"
    assert "base_url" not in body
    assert db.column_exists("servers", "environment") is False
