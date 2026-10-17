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


# TODO ALLOWED
#   dict of (from_status, to_status) -> who may do it. Something like:
#     ("awaiting_coworker", "awaiting_manager"): "target"     (accept)
#     ("awaiting_coworker", "declined"):         "target"     (decline)
#     ("awaiting_coworker", "canceled"):         "requester"  (cancel)
#     ("awaiting_manager",  "canceled"):         "requester"  (cancel)
#     ("awaiting_manager",  "approved"):         "manager"    (approve)
#     ("awaiting_manager",  "declined"):         "manager"    (manager_decline)
#   Anything not in the map is blocked (e.g. approved -> canceled).


# TODO transition(request_id, actor_id, to_status, note=None) -> (ok, message)
#   The one place that changes requests.status:
#     1. Look up the request's current status.
#     2. Reject if (current, to_status) isn't in ALLOWED.
#     3. Reject if actor_id isn't the right person for that move.
#        For team posts (target_user_id IS NULL) "target" means anyone eligible;
#        accept() handles that case before calling this.
#     4. UPDATE requests.status, INSERT into request_events
#        (from_status, to_status, actor_id, note).
#   Everything below should go through this, so the event log is never skipped.


# TODO create_request(requester_id, type, shift_id, target_user_id, offered_shift_id)
#   Reject unless:
#     - type is 'coverage' or 'swap'
#     - requester is the shift's current assignee
#     - shift hasn't started yet (start_dt > now)
#     - no OPEN request already exists for this shift
#     - coverage: offered_shift_id is None. If target is given, matching.can_cover(target, shift) passes
#     - swap: offered_shift_id is given, target = that shift's assignee,
#             and matching.can_swap(shift_id, offered_shift_id) passes
#     - target_user_id None means "post to the whole team" (coverage only)
#   Then INSERT the request and log the first event (from_status NULL -> 'awaiting_coworker').
#   Notify the target, or skip it for team posts (they show up in "received" anyway).
#   Return (True, new_id).


# TODO accept(request_id, actor_id)
#   Direct request: actor must be target_user_id.
#   Team post: actor must pass matching.can_cover right now, then set
#   target_user_id = actor_id (they're claiming it).
#   Re-check eligibility in both cases, because availability may have changed since the request.
#   -> awaiting_manager. Notify the requester and the workplace's managers.


# TODO decline(request_id, actor_id)
#   Target says no -> declined. Notify the requester.
#   Team posts: decide whether one person declining should kill the post.
#   Probably not; just block it ("Team posts can't be declined").


# TODO cancel(request_id, actor_id)
#   Requester takes it back while still open -> canceled. Notify the target if there is one.


# TODO approve(request_id, actor_id)
#   Manager of the shift's workplace only. This is the ONLY function that touches shifts.
#   Do it all in ONE transaction. db.execute() commits after every
#   statement, so use db.get_db() directly and commit once at the end
#   (or rollback on failure):
#     1. Reload the request. Abort if status isn't 'awaiting_manager'.
#     2. Re-validate: coverage -> can_cover(target, shift); swap -> can_swap(...).
#        If it fails now, decline it with a note explaining why (don't just error).
#     3. Coverage: shifts.assignee_id = target.
#        Swap: exchange assignee_id on both shifts.
#     4. Status -> approved (through transition, event logged).
#     5. Cancel every other OPEN request on the shift(s) that just changed hands.
#   Notify the requester and the target.
#
#   Before submitting, grep for "UPDATE shifts". It should only show up in this function.


# TODO manager_decline(request_id, actor_id, note=None)
#   Manager only, awaiting_manager -> declined with the note. Notify both people.
#
#   Tests to write (tests/test_requests_flow.py):
#     - invalid transition blocked (approved -> canceled)
#     - wrong actor blocked (requester can't accept their own request)
#     - duplicate open request on the same shift blocked
#     - schedule unchanged until approve()
#     - approve re-validates (coworker became unavailable -> request declined)
#     - swap approval swaps both assignees
