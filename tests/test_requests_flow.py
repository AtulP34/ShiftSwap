"""Tests for requests_flow.py: the coverage/swap state machine.

Run with: pytest tests/test_requests_flow.py -v
"""

import db
from conftest import add_exception, add_shift, assignee, status
from requests_flow import accept, approve, cancel, create_request, decline, manager_decline


def coverage(world, shift, target=None):
    ok, request_id = create_request(world["sam"], "coverage", shift, target, None)
    assert ok, request_id
    return request_id


def test_full_coverage_flow_changes_schedule_only_on_approve(world):
    shift = add_shift(world, world["sam"], "09:00", "12:00")
    rq = coverage(world, shift, world["ali"])
    assert accept(rq, world["ali"])[0]
    assert status(rq) == "awaiting_manager"
    assert assignee(shift) == world["sam"]  # unchanged until approve()
    assert approve(rq, world["manager"])[0]
    assert status(rq) == "approved"
    assert assignee(shift) == world["ali"]
    events = db.query("SELECT to_status FROM request_events WHERE request_id = ? ORDER BY id", (rq,))
    assert [e["to_status"] for e in events] == ["awaiting_coworker", "awaiting_manager", "approved"]


def test_invalid_transition_is_blocked(world):
    shift = add_shift(world, world["sam"], "09:00", "12:00")
    rq = coverage(world, shift, world["ali"])
    accept(rq, world["ali"])
    approve(rq, world["manager"])
    ok, message = cancel(rq, world["sam"])
    assert not ok
    assert status(rq) == "approved"


def test_wrong_actor_is_blocked(world):
    shift = add_shift(world, world["sam"], "09:00", "12:00")
    rq = coverage(world, shift, world["ali"])
    assert not accept(rq, world["sam"])[0]       # requester can't accept their own request
    assert not approve(rq, world["manager"])[0]  # not waiting for a manager yet
    accept(rq, world["ali"])
    assert not approve(rq, world["ali"])[0]      # only managers approve
    assert not manager_decline(rq, world["sam"])[0]


def test_duplicate_open_request_is_blocked(world):
    shift = add_shift(world, world["sam"], "09:00", "12:00")
    coverage(world, shift)
    ok, message = create_request(world["sam"], "coverage", shift, None, None)
    assert not ok
    assert "already an open request" in message


def test_only_assignee_can_request(world):
    shift = add_shift(world, world["sam"], "09:00", "12:00")
    ok, _ = create_request(world["ali"], "coverage", shift, None, None)
    assert not ok


def test_team_post_can_be_claimed_but_not_declined(world):
    shift = add_shift(world, world["sam"], "09:00", "12:00")
    rq = coverage(world, shift)
    assert not decline(rq, world["ali"])[0]
    assert not accept(rq, world["manager"])[0]  # not trained as Cook
    assert accept(rq, world["ali"])[0]
    target = db.query("SELECT target_user_id FROM requests WHERE id = ?", (rq,), one=True)["target_user_id"]
    assert target == world["ali"]


def test_approve_revalidates_and_declines_if_no_longer_valid(world):
    shift = add_shift(world, world["sam"], "09:00", "12:00")
    rq = coverage(world, shift, world["ali"])
    accept(rq, world["ali"])
    add_exception(world["ali"], "00:00", "23:59", "unavailable")  # Ali becomes unavailable
    ok, message = approve(rq, world["manager"])
    assert not ok
    assert status(rq) == "declined"
    assert assignee(shift) == world["sam"]
    note = db.query("SELECT note FROM request_events WHERE request_id = ? AND to_status = 'declined'", (rq,), one=True)
    assert "Not available" in note["note"]


def test_swap_approval_swaps_both_assignees(world):
    a = add_shift(world, world["sam"], "09:00", "12:00")
    b = add_shift(world, world["ali"], "15:00", "18:00")
    ok, rq = create_request(world["sam"], "swap", a, None, b)
    assert ok, rq
    assert accept(rq, world["ali"])[0]
    assert approve(rq, world["manager"])[0]
    assert assignee(a) == world["ali"] and assignee(b) == world["sam"]


def test_approve_cancels_other_open_requests_on_the_same_shift(world):
    a = add_shift(world, world["sam"], "09:00", "12:00")
    b = add_shift(world, world["ali"], "15:00", "18:00")
    rq = coverage(world, a, world["ali"])
    # a second open request that also involves shift a (Ali wants to swap b for it)
    ok, other = create_request(world["ali"], "swap", b, None, a)
    assert ok, other
    accept(rq, world["ali"])
    approve(rq, world["manager"])
    assert status(other) == "canceled"


def test_manager_decline_keeps_note(world):
    shift = add_shift(world, world["sam"], "09:00", "12:00")
    rq = coverage(world, shift, world["ali"])
    accept(rq, world["ali"])
    assert manager_decline(rq, world["manager"], "Need Sam that day")[0]
    assert status(rq) == "declined"
    note = db.query("SELECT note FROM request_events WHERE request_id = ? ORDER BY id DESC", (rq,), one=True)["note"]
    assert note == "Need Sam that day"


def test_notifications_are_sent(world):
    shift = add_shift(world, world["sam"], "09:00", "12:00")
    rq = coverage(world, shift, world["ali"])
    accept(rq, world["ali"])
    from notify import unread_count, mark_read
    assert unread_count(world["ali"]) == 1      # got the request
    assert unread_count(world["sam"]) == 1      # Ali accepted
    assert unread_count(world["manager"]) == 1  # needs approval
    mark_read(world["sam"])
    assert unread_count(world["sam"]) == 0
