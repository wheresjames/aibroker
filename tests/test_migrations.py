"""Static checks on the clean initial schema (no server or database required)."""

import pathlib

MIGRATIONS = pathlib.Path(__file__).resolve().parents[1] / "packages" / "db" / "src" / "migrations"


def read(name: str) -> str:
    return (MIGRATIONS / name).read_text(encoding="utf-8")


def test_owner_role_trigger_enforces_admin_only_ownership():
    sql = read("001_initial_schema.sql").lower()
    assert "create trigger users_owner_role_check" in sql
    assert "before insert or update of owner_user_id on public.users" in sql
    assert "not in ('team_admin', 'global_admin')" in sql


def test_global_admin_root_invariant_is_preserved():
    sql = read("001_initial_schema.sql").lower()
    assert "users_global_admin_root_check" in sql
