"""Users list scoping/counts and the disable endpoint."""

from conftest import auth


def build_tree(db):
    """G -> T1 -> {U1, U2, SUB -> U3}, and a detached team admin T2 -> U4.

    Intermediate owners must themselves be admins (enforced by the migration-007 trigger),
    so the third level hangs off a nested team admin rather than a plain user.
    """
    g = db.user(role="global_admin", display_name="Global")
    t1 = db.user(role="team_admin", owner_id=g["id"], display_name="Team One")
    u1 = db.user(role="user", owner_id=t1["id"], display_name="User One")
    u2 = db.user(role="user", owner_id=t1["id"], display_name="User Two")
    sub = db.user(role="team_admin", owner_id=t1["id"], display_name="Sub Team")
    u3 = db.user(role="user", owner_id=sub["id"], display_name="User Three")
    t2 = db.user(role="team_admin", owner_id=g["id"], display_name="Team Two")
    u4 = db.user(role="user", owner_id=t2["id"], display_name="User Four")
    return {"g": g, "t1": t1, "u1": u1, "u2": u2, "sub": sub, "u3": u3, "t2": t2, "u4": u4}


def test_global_admin_sees_the_whole_tree_with_counts_and_owner_names(client, db):
    tree = build_tree(db)
    response = client.get("/admin/users", headers=auth(tree["g"]["id"]))
    assert response.status_code == 200
    users = {u["id"]: u for u in response.json()["users"]}
    assert len(users) == 8

    t1 = users[tree["t1"]["id"]]
    assert t1["owner_display_name"] == "Global"
    assert t1["child_count"] == 3       # user1, user2, sub
    assert t1["descendant_count"] == 4  # user1, user2, sub, user3

    sub = users[tree["sub"]["id"]]
    assert sub["child_count"] == 1
    assert sub["descendant_count"] == 1


def test_scopes_a_team_admin_to_only_their_descendants(client, db):
    tree = build_tree(db)
    response = client.get("/admin/users", headers=auth(tree["t1"]["id"]))
    assert response.status_code == 200
    ids = {u["id"] for u in response.json()["users"]}
    assert ids == {tree["u1"]["id"], tree["u2"]["id"], tree["sub"]["id"], tree["u3"]["id"]}
    # Their own row, the global admin, and the other team's subtree are excluded.
    assert tree["t1"]["id"] not in ids
    assert tree["t2"]["id"] not in ids
    assert tree["u4"]["id"] not in ids


def test_team_admin_can_disable_a_user_within_scope(client, db):
    g = db.user(role="global_admin")
    team_admin = db.user(role="team_admin", owner_id=g["id"])
    user = db.user(role="user", owner_id=team_admin["id"])
    response = client.post(f"/admin/users/{user['id']}/disable", headers=auth(team_admin["id"]))
    assert response.status_code == 200
    assert db.status_of(user["id"]) == "disabled"


def test_team_admin_cannot_disable_a_user_outside_scope(client, db):
    g = db.user(role="global_admin")
    team_admin_1 = db.user(role="team_admin", owner_id=g["id"])
    team_admin_2 = db.user(role="team_admin", owner_id=g["id"])
    user = db.user(role="user", owner_id=team_admin_2["id"])
    response = client.post(f"/admin/users/{user['id']}/disable", headers=auth(team_admin_1["id"]))
    assert response.status_code == 403
    assert db.status_of(user["id"]) == "active"


def test_team_admin_can_edit_a_user_within_scope(client, db):
    g = db.user(role="global_admin")
    team_admin = db.user(role="team_admin", owner_id=g["id"])
    user = db.user(role="user", owner_id=team_admin["id"])
    response = client.patch(
        f"/admin/users/{user['id']}",
        headers=auth(team_admin["id"]),
        json={"display_name": "Updated", "email": user["email"], "role": "user", "status": "active"},
    )
    assert response.status_code == 200
    assert response.json()["user"]["display_name"] == "Updated"


def test_team_admin_cannot_edit_a_user_outside_scope(client, db):
    g = db.user(role="global_admin")
    team_admin_1 = db.user(role="team_admin", owner_id=g["id"])
    team_admin_2 = db.user(role="team_admin", owner_id=g["id"])
    user = db.user(role="user", owner_id=team_admin_2["id"])
    response = client.patch(
        f"/admin/users/{user['id']}",
        headers=auth(team_admin_1["id"]),
        json={"display_name": "Hijacked", "email": user["email"], "role": "user", "status": "active"},
    )
    assert response.status_code == 403
