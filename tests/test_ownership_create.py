"""Create-user ownership rules: only team_admins and global_admins can own users."""

import uuid

from conftest import auth

MISSING_UUID = "00000000-0000-0000-0000-000000000000"


def create(client, actor_id, **body):
    payload = {
        "email": f"new-{uuid.uuid4().hex[:8]}@example.com",
        "display_name": "New User",
        "password": "password123",
        "status": "active",
    }
    payload.update(body)
    return client.post("/admin/users", headers=auth(actor_id), json=payload)


def test_global_admin_creates_a_root_global_admin_with_no_owner(client, db):
    admin = db.user(role="global_admin")
    response = create(client, admin["id"], role="global_admin")
    assert response.status_code == 200
    assert response.json()["user"]["owner_user_id"] is None


def test_allows_a_team_admin_owner_and_records_history(client, db):
    admin = db.user(role="global_admin")
    team_admin = db.user(role="team_admin", owner_id=admin["id"])
    response = create(client, admin["id"], role="user", owner_user_id=team_admin["id"], reason="onboarding")
    assert response.status_code == 200
    assert response.json()["user"]["owner_user_id"] == team_admin["id"]

    history = db.history_rows()
    assert len(history) == 1
    assert str(history[0]["new_owner_user_id"]) == team_admin["id"]
    assert str(history[0]["changed_by_user_id"]) == admin["id"]
    assert history[0]["previous_owner_user_id"] is None
    assert history[0]["reason"] == "onboarding"


def test_allows_a_global_admin_owner(client, db):
    admin = db.user(role="global_admin")
    response = create(client, admin["id"], role="auditor", owner_user_id=admin["id"])
    assert response.status_code == 200


def test_allows_a_team_admin_owned_by_another_team_admin(client, db):
    admin = db.user(role="global_admin")
    team_admin = db.user(role="team_admin", owner_id=admin["id"])
    response = create(client, admin["id"], role="team_admin", owner_user_id=team_admin["id"])
    assert response.status_code == 200


def test_rejects_a_plain_user_as_owner(client, db):
    admin = db.user(role="global_admin")
    plain_user = db.user(role="user", owner_id=admin["id"])
    response = create(client, admin["id"], role="user", owner_user_id=plain_user["id"])
    assert response.status_code == 400
    assert response.json() == {"error": "invalid_owner", "message": "Only team_admins and global_admins can own users."}
    assert db.history_rows() == []


def test_rejects_an_auditor_as_owner(client, db):
    admin = db.user(role="global_admin")
    auditor = db.user(role="auditor", owner_id=admin["id"])
    response = create(client, admin["id"], role="user", owner_user_id=auditor["id"])
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_owner"


def test_rejects_a_non_existent_owner(client, db):
    admin = db.user(role="global_admin")
    response = create(client, admin["id"], role="user", owner_user_id=MISSING_UUID)
    assert response.status_code == 400
    assert response.json()["error"] == "owner_not_found"


def test_requires_a_team_admin_to_place_new_users_under_an_owner(client, db):
    team_admin = db.user(role="team_admin")
    response = create(client, team_admin["id"], role="user")
    assert response.status_code == 400
    assert response.json()["error"] == "owner_required"


def test_lets_a_team_admin_create_a_user_owned_by_themselves(client, db):
    team_admin = db.user(role="team_admin")
    response = create(client, team_admin["id"], role="user", owner_user_id=team_admin["id"])
    assert response.status_code == 200


def test_stops_a_team_admin_from_creating_a_global_admin(client, db):
    team_admin = db.user(role="team_admin")
    response = create(client, team_admin["id"], role="global_admin")
    assert response.status_code == 403
    assert response.json()["error"] == "admin_denied"


def test_stops_a_team_admin_from_using_an_owner_outside_their_scope(client, db):
    admin = db.user(role="global_admin")
    team_admin_a = db.user(role="team_admin", owner_id=admin["id"])
    team_admin_b = db.user(role="team_admin", owner_id=admin["id"])
    response = create(client, team_admin_a["id"], role="user", owner_user_id=team_admin_b["id"])
    assert response.status_code == 403
    assert response.json()["error"] == "admin_denied"


def test_rejects_a_short_password_before_touching_ownership(client, db):
    admin = db.user(role="global_admin")
    response = create(client, admin["id"], role="user", owner_user_id=admin["id"], password="short")
    assert response.status_code == 400
    assert response.json()["error"] == "validation_error"
