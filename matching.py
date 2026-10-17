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


# TODO has_role(user_id, role_id) -> bool
#   Is there a member_roles row for this pair? One query.


# TODO has_conflict(user_id, start, end, ignore_shift_id=None) -> bool
#   True if the user already has a shift that overlaps start..end.
#   Use availability.overlaps() (or put the same check in SQL:
#   start_dt < end AND end_dt > start).
#   ignore_shift_id: skip that one shift when checking. Without it, a swap
#   always "conflicts" with the shift the person is about to give away.


# TODO can_cover(user_id, shift, ignore_shift_id=None) -> (ok, reasons)
#   Collect ALL failures instead of stopping at the first one, so the UI can list them:
#     - not a member of the shift's workplace
#     - not trained for the shift's role       (has_role)
#     - already working at that time           (has_conflict, pass ignore_shift_id through)
#     - not available at that time             (availability.is_available)
#   ok = (reasons == [])


# TODO find_coverage(shift_id) -> {"eligible": [...], "ineligible": [...]}
#   For every member of the shift's workplace EXCEPT the current assignee:
#     run can_cover(member_id, shift)
#     eligible entry:   {"id": user_id, "name": name}
#     ineligible entry: {"id": user_id, "name": name, "reasons": [...]}
#   Keep the "id" key; api.py list_requests() relies on it.
#   Sort each list by name so the UI is stable.


# TODO can_swap(shift_a_id, shift_b_id) -> (ok, reasons)
#   A's person takes shift B and B's person takes shift A. Check both sides:
#     can_cover(a.assignee_id, shift_b, ignore_shift_id=shift_a.id)
#     can_cover(b.assignee_id, shift_a, ignore_shift_id=shift_b.id)
#   ignore_shift_id matters here: each person is giving up their own
#   shift, so it shouldn't count as a conflict.
#   Also fail if the shifts are in different workplaces.
#   Prefix the reasons with whose problem they are, e.g. "Sam: Not trained as Cook".
#
#   Tests to write (tests/test_matching.py):
#     - missing role is rejected
#     - a conflicting shift is detected
#     - swap ignores each person's own shift (two people on overlapping shifts can still swap)
#     - swap fails if EITHER side is ineligible
