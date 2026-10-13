"""Tests that prove the rules in schema.sql actually work.

Each test builds a brand-new database in memory (nothing is saved to
disk), tries to insert some data, and checks that SQLite either accepts
it or rejects it with an IntegrityError.

Run with: pytest tests/test_schema.py -v
"""

import sqlite3
from pathlib import Path

import pytest

# schema.sql lives one folder up from this tests/ folder.
SCHEMA = Path(__file__).resolve().parent.parent / "schema.sql"


@pytest.fixture
def db():
    """Give each test a fresh, empty in-memory database with all tables."""
    # ':memory:' means the database only exists in RAM, so every test
    # starts clean and nothing needs to be deleted afterward.
    conn = sqlite3.connect(":memory:")
    # Same as db.py: foreign keys are OFF unless we turn them on.
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA.read_text())
    yield conn
    conn.close()


def seed(db):
    """Insert one valid user, workplace, role, and shift. Returns their ids.

    Most tests need a little valid data to point at, so this saves repeating it.
    """
    user = db.execute(
        "INSERT INTO users (name, email, password_hash) VALUES ('Ana', 'ana@example.com', 'x')"
    ).lastrowid
    workplace = db.execute(
        "INSERT INTO workplaces (name, invite_code) VALUES ('Diner', 'ABC123')"
    ).lastrowid
    role = db.execute(
        "INSERT INTO roles (workplace_id, name) VALUES (?, 'Cashier')", (workplace,)
    ).lastrowid
    shift = db.execute(
        "INSERT INTO shifts (workplace_id, role_id, assignee_id, start_dt, end_dt) "
        "VALUES (?, ?, ?, '2026-10-12T09:00', '2026-10-12T17:00')",
        (workplace, role, user),
    ).lastrowid
    return user, workplace, role, shift


def test_shift_end_must_be_after_start(db):
    """Rule: CHECK (end_dt > start_dt) on shifts. Backwards and zero-length shifts are rejected."""
    user, workplace, role, _ = seed(db)
    insert = (
        "INSERT INTO shifts (workplace_id, role_id, assignee_id, start_dt, end_dt) "
        "VALUES (?, ?, ?, ?, ?)"
    )
    # Ends before it starts.
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(insert, (workplace, role, user, "2026-10-12T17:00", "2026-10-12T09:00"))
    # Ends exactly when it starts (zero length).
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(insert, (workplace, role, user, "2026-10-12T09:00", "2026-10-12T09:00"))


def test_request_status_must_be_known(db):
    """Rule: CHECK status IN (...) on requests. A made-up status is rejected."""
    user, _, _, shift = seed(db)
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO requests (type, shift_id, requester_id, status) "
            "VALUES ('coverage', ?, ?, 'pending')",
            (shift, user),
        )


def test_swap_requires_offered_shift(db):
    """Rule: a 'swap' request must name the shift offered in return."""
    user, _, _, shift = seed(db)
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO requests (type, shift_id, requester_id) VALUES ('swap', ?, ?)",
            (shift, user),
        )


def test_foreign_key_to_missing_user_fails(db):
    """Rule: REFERENCES users(id). You cannot point at a user who does not exist."""
    with pytest.raises(sqlite3.IntegrityError):
        # There are no users at all, so user 999 cannot exist.
        db.execute("INSERT INTO notifications (user_id, message) VALUES (999, 'hi')")


def test_duplicate_email_fails(db):
    """Rule: users.email is UNIQUE. Two accounts cannot share an email."""
    db.execute("INSERT INTO users (name, email, password_hash) VALUES ('A', 'same@example.com', 'x')")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO users (name, email, password_hash) VALUES ('B', 'same@example.com', 'y')")


def test_valid_full_chain_succeeds(db):
    """Rule check in reverse: correct data passes every constraint.

    Builds the whole path: user, workplace, membership, role, shift,
    request, request_event. If any constraint is too strict, this fails.
    """
    user, workplace, role, shift = seed(db)
    coworker = db.execute(
        "INSERT INTO users (name, email, password_hash) VALUES ('Ben', 'ben@example.com', 'y')"
    ).lastrowid
    db.execute("INSERT INTO memberships (user_id, workplace_id) VALUES (?, ?)", (user, workplace))
    db.execute("INSERT INTO member_roles (user_id, role_id) VALUES (?, ?)", (user, role))
    request = db.execute(
        "INSERT INTO requests (type, shift_id, requester_id, target_user_id) "
        "VALUES ('coverage', ?, ?, ?)",
        (shift, user, coworker),
    ).lastrowid
    db.execute(
        "INSERT INTO request_events (request_id, actor_id, from_status, to_status) "
        "VALUES (?, ?, NULL, 'awaiting_coworker')",
        (request, user),
    )
    # The request got its default status and the event was recorded.
    assert db.execute("SELECT status FROM requests WHERE id = ?", (request,)).fetchone()[0] == "awaiting_coworker"
    assert db.execute("SELECT COUNT(*) FROM request_events").fetchone()[0] == 1


def test_deleting_workplace_cleans_up_everything(db):
    """Rule: the ON DELETE CASCADE chain. Deleting a workplace removes its
    roles, shifts, requests, and history without any foreign key errors.
    """
    user, workplace, _, shift = seed(db)
    request = db.execute(
        "INSERT INTO requests (type, shift_id, requester_id) VALUES ('coverage', ?, ?)",
        (shift, user),
    ).lastrowid
    db.execute(
        "INSERT INTO request_events (request_id, actor_id, to_status) VALUES (?, ?, 'awaiting_coworker')",
        (request, user),
    )
    db.execute("DELETE FROM workplaces WHERE id = ?", (workplace,))
    for table in ("roles", "shifts", "requests", "request_events"):
        assert db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
