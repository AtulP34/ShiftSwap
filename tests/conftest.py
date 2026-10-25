"""Shared fixtures for the logic tests (availability, matching, requests_flow).

Those modules read and write through db.py, which needs a Flask app
context. The `app` fixture gives every test a fresh database file in a
temp folder and keeps an app context open for the whole test.
"""

import sys
from datetime import date
from pathlib import Path

import pytest

# make the project root importable (api.py, db.py, ...) when running `pytest` from anywhere
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import api  # noqa: E402
import db  # noqa: E402

# Far-future dates so "shift hasn't started yet" checks always pass.
DAY = "2099-01-05"
WEEKDAY = date.fromisoformat(DAY).weekday()


@pytest.fixture
def app(tmp_path):
    api.app.config["DATABASE"] = str(tmp_path / "test.sqlite")
    with api.app.app_context():
        db.init_db()
        yield api.app


@pytest.fixture
def world(app):
    """A workplace with a manager and two trained, available cooks.

    Returns a dict of ids: manager, sam, ali, workplace, cook (role).
    """
    ids = {}
    for key, name in (("manager", "Maya"), ("sam", "Sam"), ("ali", "Ali")):
        ids[key] = db.execute(
            "INSERT INTO users (name, email, password_hash) VALUES (?, ?, 'x')", (name, key + "@example.com"))
    ids["workplace"] = db.execute("INSERT INTO workplaces (name, invite_code) VALUES ('Diner', 'ABC123')")
    ids["cook"] = db.execute("INSERT INTO roles (workplace_id, name) VALUES (?, 'Cook')", (ids["workplace"],))
    for key in ("manager", "sam", "ali"):
        db.execute("INSERT INTO memberships (user_id, workplace_id, is_manager) VALUES (?, ?, ?)",
                   (ids[key], ids["workplace"], 1 if key == "manager" else 0))
    for key in ("sam", "ali"):
        give_role(ids[key], ids["cook"])
        add_weekly(ids[key], "08:00", "22:00")
    return ids


def give_role(user_id, role_id):
    db.execute("INSERT INTO member_roles (user_id, role_id) VALUES (?, ?)", (user_id, role_id))


def add_weekly(user_id, start, end, weekday=WEEKDAY):
    db.execute("INSERT INTO availability_weekly (user_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)",
               (user_id, weekday, start, end))


def add_exception(user_id, start, end, kind, day=DAY):
    db.execute("INSERT INTO availability_exceptions (user_id, date, start_time, end_time, kind) VALUES (?, ?, ?, ?, ?)",
               (user_id, day, start, end, kind))


def add_shift(world, assignee, start, end, day=DAY):
    return db.execute(
        "INSERT INTO shifts (workplace_id, role_id, assignee_id, start_dt, end_dt) VALUES (?, ?, ?, ?, ?)",
        (world["workplace"], world["cook"], assignee, f"{day}T{start}", f"{day}T{end}"))


def assignee(shift_id):
    return db.query("SELECT assignee_id FROM shifts WHERE id = ?", (shift_id,), one=True)["assignee_id"]


def status(request_id):
    return db.query("SELECT status FROM requests WHERE id = ?", (request_id,), one=True)["status"]
