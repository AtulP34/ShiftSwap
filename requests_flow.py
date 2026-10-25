# Request state machine: coverage/swap requests moving toward approval.
# checklist.md section 6 (Oct 20 to 21). Needs matching.py and notify.py done first.
#
# THE rule (schema.sql header): the shifts table is only ever updated
# inside approve(). Every other function here only changes requests.status
# and logs to request_events.
#
#   awaiting_coworker -> awaiting_manager -> approved
#   any open status   -> declined | canceled
#
# Used by api.py. Every function returns a tuple, and api.py relies on it:
#   create_request(...) -> (True, new_request_id)  or (False, "error message")
#   everything else     -> (True, "ok message")    or (False, "error message")
# api.py already 404s if the request doesn't exist, so these functions can
# assume the id is real. They still need to check status and who is acting.
#
# Error messages go straight to the user, so make them readable.

from datetime import datetime

from db import execute, get_db, query
from matching import can_cover, can_swap, load_shift
from notify import notify


# (from_status, to_status) -> who may make that move. Anything else is blocked.
ALLOWED = {
    ("awaiting_coworker", "awaiting_manager"): "target",     # accept
    ("awaiting_coworker", "declined"):         "target",     # decline
    ("awaiting_coworker", "canceled"):         "requester",  # cancel
    ("awaiting_manager",  "canceled"):         "requester",  # cancel
    ("awaiting_manager",  "approved"):         "manager",    # approve
    ("awaiting_manager",  "declined"):         "manager",    # manager_decline
}

OPEN_STATUSES = ("awaiting_coworker", "awaiting_manager")


def now():
    return datetime.now().strftime("%Y-%m-%dT%H:%M")


def load_request(request_id):
    return query("SELECT * FROM requests WHERE id = ?", (request_id,), one=True)


def link(request_id):
    return "/requests/" + str(request_id)


def is_manager_of(user_id, workplace_id):
    row = query("SELECT is_manager FROM memberships WHERE user_id = ? AND workplace_id = ?",
                (user_id, workplace_id), one=True)
    return row is not None and row["is_manager"] == 1


def managers_of(workplace_id):
    return [r["user_id"] for r in query(
        "SELECT user_id FROM memberships WHERE workplace_id = ? AND is_manager = 1", (workplace_id,))]


def name_of(user_id):
    row = query("SELECT name FROM users WHERE id = ?", (user_id,), one=True)
    return row["name"] if row else "Someone"


def check_move(req, actor_id, to_status):
    """Return None if actor_id may move req to to_status, else an error message."""
    who = ALLOWED.get((req["status"], to_status))
    if who is None:
        return "This request is " + req["status"].replace("_", " ") + " and can't be changed to " + to_status
    if who == "target" and actor_id != req["target_user_id"]:
        return "Only the coworker this request was sent to can do that"
    if who == "requester" and actor_id != req["requester_id"]:
        return "Only the person who made this request can do that"
    if who == "manager":
        shift = load_shift(req["shift_id"])
        if not is_manager_of(actor_id, shift["workplace_id"]):
            return "Only a manager of this workplace can do that"
    return None


def write_transition(db, req, actor_id, to_status, note=None):
    # no commit here, so approve() can use it inside its transaction
    db.execute("UPDATE requests SET status = ? WHERE id = ?", (to_status, req["id"]))
    db.execute(
        "INSERT INTO request_events (request_id, actor_id, from_status, to_status, note) VALUES (?, ?, ?, ?, ?)",
        (req["id"], actor_id, req["status"], to_status, note),
    )


def transition(request_id, actor_id, to_status, note=None):
    # the one place that changes requests.status, so the event log is never skipped
    req = load_request(request_id)
    problem = check_move(req, actor_id, to_status)
    if problem:
        return False, problem
    db = get_db()
    write_transition(db, req, actor_id, to_status, note)
    db.commit()
    return True, "Request " + to_status.replace("_", " ")


def create_request(requester_id, type, shift_id, target_user_id, offered_shift_id):
    if type not in ("coverage", "swap"):
        return False, "Request type must be coverage or swap"

    shift = load_shift(shift_id)
    if shift is None:
        return False, "Shift not found"
    if shift["assignee_id"] != requester_id:
        return False, "You can only make requests for your own shifts"
    if shift["start_dt"] <= now():
        return False, "That shift has already started"
    open_req = query(
        "SELECT 1 FROM requests WHERE shift_id = ? AND status IN (?, ?)", (shift["id"], *OPEN_STATUSES), one=True)
    if open_req:
        return False, "There's already an open request for this shift"

    if type == "coverage":
        if offered_shift_id is not None:
            return False, "Coverage requests don't offer a shift in return"
        if target_user_id is not None:
            if target_user_id == requester_id:
                return False, "You can't ask yourself to cover your shift"
            ok, reasons = can_cover(target_user_id, shift)
            if not ok:
                return False, name_of(target_user_id) + " can't cover this shift: " + "; ".join(reasons)
    else:
        if offered_shift_id is None:
            return False, "Pick the shift you want in return"
        offered = load_shift(offered_shift_id)
        if offered is None:
            return False, "The shift you want in return wasn't found"
        if offered["start_dt"] <= now():
            return False, "The shift you want in return has already started"
        if target_user_id is not None and target_user_id != offered["assignee_id"]:
            return False, "A swap goes to the person working the other shift"
        target_user_id = offered["assignee_id"]
        ok, reasons = can_swap(shift["id"], offered["id"])
        if not ok:
            return False, "These shifts can't be swapped: " + "; ".join(reasons)
        offered_shift_id = offered["id"]

    new_id = execute(
        "INSERT INTO requests (type, shift_id, requester_id, target_user_id, offered_shift_id) VALUES (?, ?, ?, ?, ?)",
        (type, shift["id"], requester_id, target_user_id, offered_shift_id),
    )
    execute(
        "INSERT INTO request_events (request_id, actor_id, from_status, to_status) VALUES (?, ?, NULL, 'awaiting_coworker')",
        (new_id, requester_id),
    )
    # team posts show up in everyone's "received" box, so no notification
    if target_user_id is not None:
        notify(target_user_id, name_of(requester_id) + " sent you a " + type + " request", link(new_id))
    return True, new_id


def recheck(req, user_id):
    """Is the request still valid with user_id taking the shift? Returns (ok, reasons)."""
    if req["type"] == "coverage":
        return can_cover(user_id, load_shift(req["shift_id"]))
    return can_swap(req["shift_id"], req["offered_shift_id"])


def accept(request_id, actor_id):
    req = load_request(request_id)
    if req["status"] != "awaiting_coworker":
        return False, "This request isn't waiting for a coworker anymore"
    if actor_id == req["requester_id"]:
        return False, "You can't accept your own request"

    if req["target_user_id"] is None:
        # team post: whoever is eligible right now can claim it
        ok, reasons = can_cover(actor_id, load_shift(req["shift_id"]))
        if not ok:
            return False, "You can't cover this shift: " + "; ".join(reasons)
        execute("UPDATE requests SET target_user_id = ? WHERE id = ?", (actor_id, request_id))
        req = load_request(request_id)
    elif actor_id != req["target_user_id"]:
        return False, "Only the coworker this request was sent to can accept it"
    else:
        # availability may have changed since the request was made
        ok, reasons = recheck(req, actor_id)
        if not ok:
            return False, "You can't take this shift anymore: " + "; ".join(reasons)

    ok, message = transition(request_id, actor_id, "awaiting_manager")
    if not ok:
        return False, message

    notify(req["requester_id"], name_of(actor_id) + " accepted your request", link(request_id))
    for manager_id in managers_of(load_shift(req["shift_id"])["workplace_id"]):
        if manager_id not in (actor_id, req["requester_id"]):
            notify(manager_id, "A " + req["type"] + " request needs your approval", link(request_id))
    return True, "Accepted. Waiting for a manager to approve."


def decline(request_id, actor_id):
    req = load_request(request_id)
    if req["target_user_id"] is None:
        return False, "Team posts can't be declined"
    ok, message = transition(request_id, actor_id, "declined")
    if not ok:
        return False, message
    notify(req["requester_id"], name_of(actor_id) + " declined your request", link(request_id))
    return True, "Request declined"


def cancel(request_id, actor_id):
    req = load_request(request_id)
    ok, message = transition(request_id, actor_id, "canceled")
    if not ok:
        return False, message
    if req["target_user_id"] is not None:
        notify(req["target_user_id"], name_of(actor_id) + " canceled their request", link(request_id))
    return True, "Request canceled"


def approve(request_id, actor_id):
    req = load_request(request_id)
    problem = check_move(req, actor_id, "approved")
    if problem:
        return False, problem

    # re-validate: things may have changed since the coworker accepted
    ok, reasons = recheck(req, req["target_user_id"])
    if not ok:
        note = "No longer valid: " + "; ".join(reasons)
        transition(request_id, actor_id, "declined", note)
        for user_id in (req["requester_id"], req["target_user_id"]):
            notify(user_id, "Your " + req["type"] + " request was declined. " + note, link(request_id))
        return False, note + ". The request was declined."

    # everything below is ONE transaction: the schedule and the request change together or not at all
    db = get_db()
    try:
        if req["type"] == "coverage":
            db.execute("UPDATE shifts SET assignee_id = ? WHERE id = ?", (req["target_user_id"], req["shift_id"]))
            changed = (req["shift_id"],)
        else:
            db.execute("UPDATE shifts SET assignee_id = ? WHERE id = ?", (req["target_user_id"], req["shift_id"]))
            db.execute("UPDATE shifts SET assignee_id = ? WHERE id = ?", (req["requester_id"], req["offered_shift_id"]))
            changed = (req["shift_id"], req["offered_shift_id"])

        write_transition(db, req, actor_id, "approved")

        # any other open request on these shifts is now out of date
        marks = ", ".join("?" * len(changed))
        stale = db.execute(
            "SELECT * FROM requests WHERE id != ? AND status IN (?, ?) AND (shift_id IN (" + marks + ")"
            " OR offered_shift_id IN (" + marks + "))",
            (request_id, *OPEN_STATUSES, *changed, *changed),
        ).fetchall()
        for other in stale:
            write_transition(db, other, actor_id, "canceled", "The shift changed hands in another request")

        db.commit()
    except Exception:
        db.rollback()
        raise

    for user_id in (req["requester_id"], req["target_user_id"]):
        notify(user_id, "Your " + req["type"] + " request was approved", link(request_id))
    for other in stale:
        for user_id in {other["requester_id"], other["target_user_id"]} - {None}:
            notify(user_id, "A request was canceled because the shift changed hands", link(other["id"]))
    return True, "Approved. The schedule has been updated."


def manager_decline(request_id, actor_id, note=None):
    req = load_request(request_id)
    if req["status"] != "awaiting_manager":
        return False, "Only requests waiting for a manager can be rejected"
    ok, message = transition(request_id, actor_id, "declined", note)
    if not ok:
        return False, message
    text = "Your " + req["type"] + " request was declined by a manager"
    if note:
        text += ": " + note
    notify(req["requester_id"], text, link(request_id))
    notify(req["target_user_id"], text.replace("Your", "The"), link(request_id))
    return True, "Request declined"
