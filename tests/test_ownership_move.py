"""Move-user ownership rules and server-side move validation."""

from conftest import auth

MISSING_UUID = "00000000-0000-0000-0000-000000000000"


def move(client, actor_id, user_id, body):
    return client.post(f"/admin/users/{user_id}/move", headers=auth(actor_id), json=body)


def standard_tree(db):
    """G -> T1 -> U, plus a sibling team admin T2."""
    g = db.user(role="global_admin")
    t1 = db.user(role="team_admin", owner_id=g["id"])
    t2 = db.user(role="team_admin", owner_id=g["id"])
    u = db.user(role="user", owner_id=t1["id"])
    return g, t1, t2, u


def test_requires_a_reason(client, db):
    g, _t1, t2, u = standard_tree(db)
    response = move(client, g["id"], u["id"], {"new_owner_user_id": t2["id"]})
    assert response.status_code == 400
    assert response.json()["error"] == "reason_required"


def test_blocks_a_user_from_owning_themselves(client, db):
    g, _t1, _t2, u = standard_tree(db)
    response = move(client, g["id"], u["id"], {"new_owner_user_id": u["id"], "reason": "x"})
    assert response.status_code == 400
    assert response.json() == {"error": "invalid_owner", "message": "A user cannot own themselves."}


def test_refuses_to_give_a_global_admin_an_owner(client, db):
    g, t1, _t2, _u = standard_tree(db)
    response = move(client, g["id"], g["id"], {"new_owner_user_id": t1["id"], "reason": "x"})
    assert response.status_code == 400
    assert response.json() == {"error": "invalid_owner", "message": "Global admins cannot have owners."}


def test_refuses_to_move_a_user_to_root(client, db):
    g, _t1, _t2, u = standard_tree(db)
    response = move(client, g["id"], u["id"], {"new_owner_user_id": None, "reason": "x"})
    assert response.status_code == 400
    assert response.json() == {"error": "owner_required", "message": "Only global admins can be root owners."}


def test_rejects_a_plain_user_as_the_new_owner(client, db):
    g, t1, _t2, u = standard_tree(db)
    plain_owner = db.user(role="user", owner_id=t1["id"])
    response = move(client, g["id"], u["id"], {"new_owner_user_id": plain_owner["id"], "reason": "x"})
    assert response.status_code == 400
    assert response.json() == {"error": "invalid_owner", "message": "Only team_admins and global_admins can own users."}
    assert db.history_rows() == []


def test_rejects_an_auditor_as_the_new_owner(client, db):
    g, t1, _t2, u = standard_tree(db)
    auditor_owner = db.user(role="auditor", owner_id=t1["id"])
    response = move(client, g["id"], u["id"], {"new_owner_user_id": auditor_owner["id"], "reason": "x"})
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_owner"


def test_rejects_moving_a_user_under_one_of_its_own_descendants(client, db):
    g = db.user(role="global_admin")
    t1 = db.user(role="team_admin", owner_id=g["id"])
    t3 = db.user(role="team_admin", owner_id=t1["id"])
    response = move(client, g["id"], t1["id"], {"new_owner_user_id": t3["id"], "reason": "x"})
    assert response.status_code == 400
    assert response.json() == {"error": "invalid_owner", "message": "A user cannot be moved under one of their descendants."}


def test_rejects_a_non_existent_new_owner(client, db):
    g, _t1, _t2, u = standard_tree(db)
    response = move(client, g["id"], u["id"], {"new_owner_user_id": MISSING_UUID, "reason": "x"})
    assert response.status_code == 400
    assert response.json()["error"] == "owner_not_found"


def test_returns_404_for_a_non_existent_user(client, db):
    g, _t1, t2, _u = standard_tree(db)
    response = move(client, g["id"], MISSING_UUID, {"new_owner_user_id": t2["id"], "reason": "x"})
    assert response.status_code == 404
    assert response.json()["error"] == "user_not_found"


def test_moves_a_user_under_a_valid_admin_owner_with_history_and_audit(client, db):
    g, t1, t2, u = standard_tree(db)
    response = move(client, g["id"], u["id"], {"new_owner_user_id": t2["id"], "reason": "reorg"})
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert db.owner_of(u["id"]) == t2["id"]

    history = db.history_rows()
    assert len(history) == 1
    assert str(history[0]["previous_owner_user_id"]) == t1["id"]
    assert str(history[0]["new_owner_user_id"]) == t2["id"]
    assert str(history[0]["changed_by_user_id"]) == g["id"]
    assert history[0]["reason"] == "reorg"

    audit = db.audit_rows("user_move")
    assert any(row["status"] == "success" for row in audit)


def test_lets_a_team_admin_move_a_user_within_their_own_scope(client, db):
    g = db.user(role="global_admin")
    t1 = db.user(role="team_admin", owner_id=g["id"])
    t1b = db.user(role="team_admin", owner_id=t1["id"])
    u = db.user(role="user", owner_id=t1["id"])
    response = move(client, t1["id"], u["id"], {"new_owner_user_id": t1b["id"], "reason": "reassign"})
    assert response.status_code == 200
    assert db.owner_of(u["id"]) == t1b["id"]


def test_stops_a_team_admin_from_moving_a_user_outside_their_scope(client, db):
    g, t1, t2, _u = standard_tree(db)
    other_user = db.user(role="user", owner_id=t2["id"])
    response = move(client, t1["id"], other_user["id"], {"new_owner_user_id": t1["id"], "reason": "x"})
    assert response.status_code == 403
    assert response.json()["error"] == "admin_denied"
