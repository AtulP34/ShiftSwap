# Most of the code and logic is ours, with AI help.
# DB interactions were mostly written by AI.

import os
import secrets
import sqlite3
import string
from datetime import datetime
from functools import wraps

from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

import db
from db import execute, query

from availability import is_available
from matching import can_swap, find_coverage, has_conflict, has_role
from notify import mark_read, unread_count
from requests_flow import accept, approve, cancel, create_request, decline, manager_decline

# serving the frontend from the same origin means no CORS setup
app = Flask(__name__, static_folder="frontend", static_url_path="")
# sessions need a secret key; set SECRET_KEY for anything beyond local dev
app.secret_key = os.environ.get("SECRET_KEY", "dev")
db.init_app(app)


def me():
    return session.get("user_id")

def now():
    # ISO 8601, minute precision, matches how shift times are stored
    return datetime.now().strftime("%Y-%m-%dT%H:%M")

def error(message, code=400):
    return jsonify({"error": message}), code

def rows(result):
    return [dict(row) for row in result]

def body(*required):
    data = request.get_json(silent=True) or {}
    missing = [f for f in required if data.get(f) in (None, "")]
    return data, missing

def login_required(route):
    @wraps(route)
    def wrapper(*args, **kwargs):
        if me() is None:
            return error("Not logged in", 401)
        # a cookie can outlive its user (e.g. after `flask init-db`); treat that as logged out
        if not query("SELECT 1 FROM users WHERE id = ?", (me(),), one=True):
            session.clear()
            return error("Not logged in", 401)
        return route(*args, **kwargs)
    return wrapper

def membership(user_id, workplace_id):
    return query("SELECT is_manager FROM memberships WHERE user_id = ? AND workplace_id = ?", (user_id, workplace_id), one=True)

def is_member(workplace_id):
    return membership(me(), workplace_id) is not None

def is_manager(workplace_id):
    m = membership(me(), workplace_id)
    return m is not None and m["is_manager"] == 1


# --- shift lookups ---

SHIFT_SELECT = """
    SELECT s.id, s.workplace_id, s.role_id, r.name AS role_name,
           s.assignee_id, u.name AS assignee_name, s.start_dt, s.end_dt,
           (SELECT COUNT(*) FROM requests rq
             WHERE rq.shift_id = s.id AND rq.status IN ('awaiting_coworker', 'awaiting_manager')) AS open_requests
    FROM shifts s
    JOIN roles r ON r.id = s.role_id
    JOIN users u ON u.id = s.assignee_id
"""

def load_shift(shift_id):
    return query(SHIFT_SELECT + " WHERE s.id = ?", (shift_id,), one=True)

def shifts_where(condition, args, start=None, end=None):
    sql = SHIFT_SELECT + " WHERE " + condition
    if start:
        sql += " AND s.end_dt > ?"
        args += (start,)
    if end:
        sql += " AND s.start_dt < ?"
        args += (end,)
    sql += " ORDER BY s.start_dt"
    return rows(query(sql, args))


# --- request lookups (AI-generated) ---

# LEFT JOINs because team posts have no target and coverage requests have no offered shift.
REQUEST_SELECT = """
    SELECT rq.id, rq.type, rq.status, rq.created_at,
           rq.shift_id, rq.requester_id, rq.target_user_id, rq.offered_shift_id,
           requester.name AS requester_name,
           target.name    AS target_name,
           s.workplace_id, s.start_dt, s.end_dt, r.name AS role_name,
           os.start_dt    AS offered_start_dt,
           os.end_dt      AS offered_end_dt
    FROM requests rq
    JOIN shifts s          ON s.id = rq.shift_id
    JOIN roles r           ON r.id = s.role_id
    JOIN users requester   ON requester.id = rq.requester_id
    LEFT JOIN users target ON target.id = rq.target_user_id
    LEFT JOIN shifts os    ON os.id = rq.offered_shift_id
"""

OPEN_STATUSES = ("awaiting_coworker", "awaiting_manager")
FINAL_STATUSES = ("approved", "declined", "canceled")


def requests_where(condition, args):
    sql = REQUEST_SELECT + " WHERE " + condition + " ORDER BY rq.created_at DESC"
    return rows(query(sql, args))


def load_request(request_id):
    found = requests_where("rq.id = ?", (request_id,))
    return found[0] if found else None


def run_action(action, request_id, *extra):
    # actions from requests_flow do their own validation and return (ok, message)
    if load_request(request_id) is None:
        return error("Request not found", 404)
    ok, message = action(request_id, me(), *extra)
    if not ok:
        return error(message)
    return jsonify(load_request(request_id))

# --- end AI-generated ---


def home():
    return send_from_directory(app.static_folder, "index.html")


# --- auth (AI-generated) ---

@app.post("/api/register")
def register():
    data, missing = body("name", "email", "password")
    if missing:
        return error("Missing: " + ", ".join(missing))

    email = data["email"].strip().lower()
    if query("SELECT 1 FROM users WHERE email = ?", (email,), one=True):
        return error("Email already registered", 409)

    user_id = execute(
        "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
        (data["name"].strip(), email, generate_password_hash(data["password"])),
    )
    session["user_id"] = user_id
    return jsonify({"id": user_id, "name": data["name"].strip()}), 201


@app.post("/api/login")
def login():
    data, missing = body("email", "password")
    if missing:
        return error("Missing: " + ", ".join(missing))

    user = query(
        "SELECT * FROM users WHERE email = ?",
        (data["email"].strip().lower(),),
        one=True,
    )
    # one message for both cases so this can't be used to probe which emails exist
    if user is None or not check_password_hash(user["password_hash"], data["password"]):
        return error("Invalid email or password", 401)

    session["user_id"] = user["id"]
    return jsonify({"id": user["id"], "name": user["name"]})


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/me")
@login_required
def who_am_i():
    user = query("SELECT id, name, email FROM users WHERE id = ?", (me(),), one=True)
    workplaces = rows(query(
        """SELECT w.id, w.name, w.invite_code, m.is_manager
           FROM memberships m JOIN workplaces w ON w.id = m.workplace_id
           WHERE m.user_id = ?""",
        (me(),),
    ))
    for w in workplaces:
        if not w["is_manager"]:
            w.pop("invite_code")
    return jsonify({**dict(user), "workplaces": workplaces})

# --- end AI-generated ---


# --- workplaces ---

def new_invite_code():
    alphabet = string.ascii_uppercase + string.digits
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(6))
        if not query("SELECT 1 FROM workplaces WHERE invite_code = ?", (code,), one=True):
            return code


@app.post("/api/workplaces")
@login_required
def create_workplace():
    # whoever creates the workplace is its first manager
    data, missing = body("name")
    if missing:
        return error("Missing: name")

    code = new_invite_code()
    wp_id = execute("INSERT INTO workplaces (name, invite_code) VALUES (?, ?)", (data["name"].strip(), code))
    execute("INSERT INTO memberships (user_id, workplace_id, is_manager) VALUES (?, ?, 1)", (me(), wp_id))
    return jsonify({"id": wp_id, "name": data["name"].strip(), "invite_code": code}), 201


@app.post("/api/workplaces/join")
@login_required
def join_workplace():
    data, missing = body("invite_code")
    if missing:
        return error("Missing: invite_code")

    wp = query("SELECT id, name FROM workplaces WHERE invite_code = ?",
               (data["invite_code"].strip().upper(),), one=True)
    if wp is None:
        return error("Invalid invite code", 404)
    if is_member(wp["id"]):
        return error("You're already in this workplace", 409)

    execute("INSERT INTO memberships (user_id, workplace_id, is_manager) VALUES (?, ?, 0)", (me(), wp["id"]))
    return jsonify(dict(wp)), 201


@app.get("/api/workplaces/<int:wp>/members")
@login_required
def list_members(wp):
    if not is_member(wp):
        return error("Not your workplace", 403)

    members = rows(query(
        """SELECT u.id, u.name, m.is_manager
           FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.workplace_id = ? ORDER BY u.name""",
        (wp,),
    ))
    for m in members:
        m["roles"] = rows(query(
            """SELECT r.id, r.name FROM member_roles mr JOIN roles r ON r.id = mr.role_id
               WHERE mr.user_id = ? AND r.workplace_id = ?""",
            (m["id"], wp),
        ))
    return jsonify(members)


# --- roles ---

@app.get("/api/workplaces/<int:wp>/roles")
@login_required
def list_roles(wp):
    if not is_member(wp):
        return error("Not your workplace", 403)
    return jsonify(rows(query("SELECT id, name FROM roles WHERE workplace_id = ? ORDER BY name", (wp,))))


@app.post("/api/workplaces/<int:wp>/roles")
@login_required
def create_role(wp):
    if not is_manager(wp):
        return error("Managers only", 403)
    data, missing = body("name")
    if missing:
        return error("Missing: name")

    try:
        role_id = execute("INSERT INTO roles (workplace_id, name) VALUES (?, ?)", (wp, data["name"].strip()))
    except sqlite3.IntegrityError:  # unique (workplace_id, name)
        return error("That role already exists", 409)
    return jsonify({"id": role_id, "name": data["name"].strip()}), 201


@app.post("/api/workplaces/<int:wp>/members/<int:user_id>/roles")
@login_required
def give_role(wp, user_id):
    if not is_manager(wp):
        return error("Managers only", 403)
    data, missing = body("role_id")
    if missing:
        return error("Missing: role_id")

    if membership(user_id, wp) is None:
        return error("That person isn't in this workplace", 404)
    if not query("SELECT 1 FROM roles WHERE id = ? AND workplace_id = ?", (data["role_id"], wp), one=True):
        return error("That role isn't in this workplace", 404)

    try:
        execute("INSERT INTO member_roles (user_id, role_id) VALUES (?, ?)", (user_id, data["role_id"]))
    except sqlite3.IntegrityError:
        return error("They already have that role", 409)
    return jsonify({"ok": True}), 201


# --- shifts ---

@app.get("/api/me/shifts")
@login_required
def my_shifts():
    # upcoming only unless the caller asks for an earlier window
    start = request.args.get("from") or now()
    end = request.args.get("to")
    return jsonify(shifts_where("s.assignee_id = ?", (me(),), start, end))


@app.get("/api/workplaces/<int:wp>/shifts")
@login_required
def workplace_shifts(wp):
    if not is_member(wp):
        return error("Not your workplace", 403)
    return jsonify(shifts_where("s.workplace_id = ?", (wp,), request.args.get("from"), request.args.get("to")))


@app.post("/api/workplaces/<int:wp>/shifts")
@login_required
def create_shift(wp):
    if not is_manager(wp):
        return error("Managers only", 403)
    data, missing = body("role_id", "assignee_id", "start_dt", "end_dt")
    if missing:
        return error("Missing: " + ", ".join(missing))

    role_id, assignee = data["role_id"], data["assignee_id"]
    start, end = data["start_dt"], data["end_dt"]

    # ISO strings compare correctly as plain strings
    if end <= start:
        return error("Shift must end after it starts")
    if membership(assignee, wp) is None:
        return error("That person isn't in this workplace")
    if not query("SELECT 1 FROM roles WHERE id = ? AND workplace_id = ?", (role_id, wp), one=True):
        return error("That role isn't in this workplace")
    if not has_role(assignee, role_id):
        return error("That person isn't qualified for this role")
    if has_conflict(assignee, start, end):
        return error("That person already has a shift at that time")

    shift_id = execute(
        "INSERT INTO shifts (workplace_id, role_id, assignee_id, start_dt, end_dt) VALUES (?, ?, ?, ?, ?)",
        (wp, role_id, assignee, start, end),
    )
    return jsonify(dict(load_shift(shift_id))), 201


# --- availability ---

# whitelist, since the table name gets interpolated into SQL below
AVAILABILITY_TABLES = {"weekly": "availability_weekly", "exceptions": "availability_exceptions"}


@app.get("/api/me/availability")
@login_required
def my_availability():
    weekly = rows(query(
        "SELECT * FROM availability_weekly WHERE user_id = ? ORDER BY weekday, start_time", (me(),)))
    exceptions = rows(query(
        "SELECT * FROM availability_exceptions WHERE user_id = ? ORDER BY date, start_time", (me(),)))
    return jsonify({"weekly": weekly, "exceptions": exceptions})


@app.post("/api/me/availability/weekly")
@login_required
def add_weekly():
    # weekday: 0 = Mon ... 6 = Sun
    data, missing = body("weekday", "start_time", "end_time")
    if missing:
        return error("Missing: " + ", ".join(missing))
    if not (0 <= int(data["weekday"]) <= 6):
        return error("weekday must be 0 (Mon) to 6 (Sun)")
    if data["end_time"] <= data["start_time"]:
        return error("End time must be after start time")

    new_id = execute(
        "INSERT INTO availability_weekly (user_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)",
        (me(), int(data["weekday"]), data["start_time"], data["end_time"]),
    )
    return jsonify({"id": new_id}), 201


@app.post("/api/me/availability/exceptions")
@login_required
def add_exception():
    data, missing = body("date", "start_time", "end_time", "kind")
    if missing:
        return error("Missing: " + ", ".join(missing))
    if data["kind"] not in ("unavailable", "available"):
        return error("kind must be 'unavailable' or 'available'")
    if data["end_time"] <= data["start_time"]:
        return error("End time must be after start time")

    new_id = execute(
        "INSERT INTO availability_exceptions (user_id, date, start_time, end_time, kind) VALUES (?, ?, ?, ?, ?)",
        (me(), data["date"], data["start_time"], data["end_time"], data["kind"]),
    )
    return jsonify({"id": new_id}), 201


@app.delete("/api/me/availability/<kind>/<int:row_id>")
@login_required
def delete_availability(kind, row_id):
    table = AVAILABILITY_TABLES.get(kind)
    if table is None:
        return error("Unknown availability type", 404)

    row = query(f"SELECT user_id FROM {table} WHERE id = ?", (row_id,), one=True)
    if row is None:
        return error("Not found", 404)
    if row["user_id"] != me():
        return error("You can only delete your own availability", 403)

    execute(f"DELETE FROM {table} WHERE id = ?", (row_id,))
    return jsonify({"ok": True})


@app.get("/api/workplaces/<int:wp>/availability")
@login_required
def team_availability(wp):
    # only a yes/no per person; coworkers don't get to see each other's actual hours
    if not is_member(wp):
        return error("Not your workplace", 403)
    start, end = request.args.get("start"), request.args.get("end")
    if not start or not end:
        return error("Need ?start= and ?end=")

    members = query(
        """SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.workplace_id = ? ORDER BY u.name""",
        (wp,),
    )
    return jsonify([
        {"id": m["id"], "name": m["name"], "available": is_available(m["id"], start, end)}
        for m in members
    ])


# --- matching ---

@app.get("/api/shifts/<int:shift_id>/coverage")
@login_required
def coverage_options(shift_id):
    shift = load_shift(shift_id)
    if shift is None:
        return error("Shift not found", 404)
    if shift["assignee_id"] != me():
        return error("You can only find coverage for your own shift", 403)
    return jsonify(find_coverage(shift_id))


@app.get("/api/shifts/<int:shift_id>/swap-options")
@login_required
def swap_options(shift_id):
    shift = load_shift(shift_id)
    if shift is None:
        return error("Shift not found", 404)
    if shift["assignee_id"] != me():
        return error("You can only swap your own shift", 403)

    others = shifts_where(
        "s.workplace_id = ? AND s.assignee_id != ? AND s.start_dt > ?",
        (shift["workplace_id"], me(), now()),
    )

    eligible, ineligible = [], []
    for other in others:
        ok, reasons = can_swap(shift_id, other["id"])  # checks both directions
        if ok:
            eligible.append(other)
        else:
            ineligible.append({**other, "reasons": reasons})
    return jsonify({"eligible": eligible, "ineligible": ineligible})


# --- requests ---

@app.post("/api/requests")
@login_required
def new_request():
    data, missing = body("type", "shift_id")
    if missing:
        return error("Missing: " + ", ".join(missing))

    # validation lives in create_request
    ok, result = create_request(
        me(),
        data["type"],
        data["shift_id"],
        data.get("target_user_id"),    # None = post to the whole team
        data.get("offered_shift_id"),  # swaps only
    )
    if not ok:
        return error(result)
    return jsonify(load_request(result)), 201


@app.get("/api/requests")
@login_required
def list_requests():
    # ?box=sent | received | history
    box = request.args.get("box", "sent")

    if box == "sent":
        return jsonify(requests_where(
            "rq.requester_id = ? AND rq.status IN (?, ?)", (me(), *OPEN_STATUSES)))

    if box == "received":
        direct = requests_where("rq.target_user_id = ? AND rq.status = 'awaiting_coworker'", (me(),))
        team_posts = requests_where(
            """rq.target_user_id IS NULL
               AND rq.status = 'awaiting_coworker'
               AND rq.requester_id != ?
               AND s.workplace_id IN (SELECT workplace_id FROM memberships WHERE user_id = ?)""",
            (me(), me()),
        )
        # filter team posts down to ones I'm actually eligible to cover
        mine = []
        for post in team_posts:
            eligible_ids = {p["id"] for p in find_coverage(post["shift_id"])["eligible"]}
            if me() in eligible_ids:
                mine.append(post)
        return jsonify(direct + mine)

    if box == "history":
        return jsonify(requests_where(
            "(rq.requester_id = ? OR rq.target_user_id = ?) AND rq.status IN (?, ?, ?)",
            (me(), me(), *FINAL_STATUSES)))

    return error("box must be sent, received, or history")


@app.get("/api/requests/<int:request_id>")
@login_required
def request_detail(request_id):
    req = load_request(request_id)
    if req is None:
        return error("Request not found", 404)

    involved = me() in (req["requester_id"], req["target_user_id"])
    if not involved and not is_manager(req["workplace_id"]):
        return error("Not allowed", 403)

    req["events"] = rows(query(
        """SELECT e.from_status, e.to_status, e.note, e.at, u.name AS actor_name
           FROM request_events e JOIN users u ON u.id = e.actor_id
           WHERE e.request_id = ? ORDER BY e.at""",
        (request_id,),
    ))
    return jsonify(req)


@app.post("/api/requests/<int:request_id>/accept")
@login_required
def accept_request(request_id):
    return run_action(accept, request_id)


@app.post("/api/requests/<int:request_id>/decline")
@login_required
def decline_request(request_id):
    return run_action(decline, request_id)


@app.post("/api/requests/<int:request_id>/cancel")
@login_required
def cancel_request(request_id):
    return run_action(cancel, request_id)


# --- manager ---

@app.get("/api/workplaces/<int:wp>/pending")
@login_required
def pending_approvals(wp):
    if not is_manager(wp):
        return error("Managers only", 403)

    pending = requests_where("s.workplace_id = ? AND rq.status = 'awaiting_manager'", (wp,))
    for p in pending:
        p["original_assignee"] = p["requester_name"]
        p["proposed_assignee"] = p["target_name"]
    return jsonify(pending)


@app.post("/api/requests/<int:request_id>/approve")
@login_required
def approve_request(request_id):
    # approve() is the only place the schedule actually changes
    return run_action(approve, request_id)


@app.post("/api/requests/<int:request_id>/reject")
@login_required
def reject_request(request_id):
    data, _ = body()
    return run_action(manager_decline, request_id, data.get("note"))


@app.get("/api/workplaces/<int:wp>/history")
@login_required
def approval_history(wp):
    if not is_manager(wp):
        return error("Managers only", 403)
    return jsonify(rows(query(
        """SELECT e.request_id, e.from_status, e.to_status, e.note, e.at,
                  u.name AS actor_name, rq.type, s.start_dt, s.end_dt
           FROM request_events e
           JOIN users u     ON u.id = e.actor_id
           JOIN requests rq ON rq.id = e.request_id
           JOIN shifts s    ON s.id = rq.shift_id
           WHERE s.workplace_id = ?
           ORDER BY e.at DESC""",
        (wp,),
    )))


# --- notifications ---

@app.get("/api/notifications")
@login_required
def list_notifications():
    items = rows(query(
        "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", (me(),)))
    return jsonify({"unread": unread_count(me()), "items": items})


@app.post("/api/notifications/read")
@login_required
def read_notifications():
    mark_read(me())
    return jsonify({"ok": True})


# --- errors ---

@app.errorhandler(404)
def not_found(e):
    # API callers get JSON; anything else is a frontend route, so hand back the SPA
    if request.path.startswith("/api/"):
        return error("Not found", 404)
    return send_from_directory(app.static_folder, "index.html")


@app.errorhandler(500)
def server_error(e):
    return error("Something went wrong on the server", 500)


if __name__ == "__main__":
    app.run(debug=True)  # dev only
