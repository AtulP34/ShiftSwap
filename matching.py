# Matching engine: who can take a shift, and can two shifts be traded.
# checklist.md section 5 (Oct 19). Needs availability.py done first.
#
# Used by:
#   api.py create_shift()     -> has_role(user_id, role_id), has_conflict(user_id, start, end)
#   api.py coverage_options() -> find_coverage(shift_id)
#   api.py swap_options()     -> can_swap(shift_a_id, shift_b_id)
#   api.py list_requests()    -> find_coverage(shift_id)["eligible"], reads p["id"]
#   requests_flow.py          -> can_cover / can_swap to re-check before accept + approve
#
# Note: api.py passes shift IDs, not shift rows. Load the row yourself
# (SELECT * FROM shifts WHERE id = ?).
#
# "reasons" are short strings shown directly in the UI, so write them for
# a person to read: "Not trained as Cook", "Already working 16:00-20:00",
# "Not available at that time".

from availability import is_available
from db import query


def load_shift(shift_id):
    return query("SELECT * FROM shifts WHERE id = ?", (shift_id,), one=True)


def has_role(user_id, role_id):
    return query("SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = ?", (user_id, role_id), one=True) is not None


def conflicting_shift(user_id, start, end, ignore_shift_id=None):
    # same check as availability.overlaps(), done in SQL
    return query(
        """SELECT * FROM shifts
           WHERE assignee_id = ? AND start_dt < ? AND end_dt > ? AND id IS NOT ?
           ORDER BY start_dt LIMIT 1""",
        (user_id, end, start, ignore_shift_id),
        one=True,
    )


def has_conflict(user_id, start, end, ignore_shift_id=None):
    # ignore_shift_id: the shift they're giving away in a swap shouldn't count
    return conflicting_shift(user_id, start, end, ignore_shift_id) is not None


def can_cover(user_id, shift, ignore_shift_id=None):
    # collect every problem so the UI can list them all
    reasons = []

    member = query(
        "SELECT 1 FROM memberships WHERE user_id = ? AND workplace_id = ?",
        (user_id, shift["workplace_id"]), one=True)
    if member is None:
        reasons.append("Not a member of this workplace")

    if not has_role(user_id, shift["role_id"]):
        role = query("SELECT name FROM roles WHERE id = ?", (shift["role_id"],), one=True)
        reasons.append("Not trained as " + (role["name"] if role else "this role"))

    clash = conflicting_shift(user_id, shift["start_dt"], shift["end_dt"], ignore_shift_id)
    if clash is not None:
        reasons.append("Already working " + clash["start_dt"][11:] + "-" + clash["end_dt"][11:])

    if not is_available(user_id, shift["start_dt"], shift["end_dt"]):
        reasons.append("Not available at that time")

    return reasons == [], reasons


def find_coverage(shift_id):
    shift = load_shift(shift_id)
    members = query(
        """SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.workplace_id = ? AND u.id != ? ORDER BY u.name""",
        (shift["workplace_id"], shift["assignee_id"]),
    )

    eligible, ineligible = [], []
    for m in members:
        ok, reasons = can_cover(m["id"], shift)
        if ok:
            eligible.append({"id": m["id"], "name": m["name"]})
        else:
            ineligible.append({"id": m["id"], "name": m["name"], "reasons": reasons})
    return {"eligible": eligible, "ineligible": ineligible}


def can_swap(shift_a_id, shift_b_id):
    # A's person takes shift B and B's person takes shift A
    a, b = load_shift(shift_a_id), load_shift(shift_b_id)
    if a is None or b is None:
        return False, ["Shift not found"]
    if a["workplace_id"] != b["workplace_id"]:
        return False, ["Shifts are in different workplaces"]
    if a["assignee_id"] == b["assignee_id"]:
        return False, ["Both shifts belong to the same person"]

    reasons = []
    for person_shift, other_shift in ((a, b), (b, a)):
        person = person_shift["assignee_id"]
        name = query("SELECT name FROM users WHERE id = ?", (person,), one=True)["name"]
        # each person gives up their own shift, so don't count it as a conflict
        ok, problems = can_cover(person, other_shift, ignore_shift_id=person_shift["id"])
        reasons += [name + ": " + p for p in problems]
    return reasons == [], reasons
