"""Tests for matching.py: who can cover a shift, and can two shifts be swapped.

Run with: pytest tests/test_matching.py -v
"""

import db
from conftest import add_shift
from matching import can_cover, can_swap, find_coverage, has_conflict, load_shift


def test_missing_role_is_rejected(world):
    shift = load_shift(add_shift(world, world["sam"], "09:00", "12:00"))
    ok, reasons = can_cover(world["manager"], shift)
    assert not ok
    assert "Not trained as Cook" in reasons


def test_conflicting_shift_is_detected(world):
    add_shift(world, world["ali"], "10:00", "14:00")
    shift = load_shift(add_shift(world, world["sam"], "09:00", "12:00"))
    assert has_conflict(world["ali"], shift["start_dt"], shift["end_dt"])
    ok, reasons = can_cover(world["ali"], shift)
    assert not ok
    assert reasons == ["Already working 10:00-14:00"]


def test_find_coverage_splits_eligible_and_ineligible(world):
    shift = add_shift(world, world["sam"], "09:00", "12:00")
    result = find_coverage(shift)
    assert [p["id"] for p in result["eligible"]] == [world["ali"]]
    assert [p["id"] for p in result["ineligible"]] == [world["manager"]]
    # the assignee is never listed
    assert world["sam"] not in [p["id"] for p in result["eligible"] + result["ineligible"]]


def test_swap_ignores_each_persons_own_shift(world):
    # overlapping shifts: each person only conflicts with the shift they're giving away
    a = add_shift(world, world["sam"], "09:00", "13:00")
    b = add_shift(world, world["ali"], "10:00", "14:00")
    ok, reasons = can_swap(a, b)
    assert ok, reasons


def test_swap_fails_if_either_side_is_ineligible(world):
    a = add_shift(world, world["sam"], "09:00", "12:00")
    b = add_shift(world, world["ali"], "15:00", "18:00")
    # Ali becomes unable to work mornings
    db.execute("DELETE FROM availability_weekly WHERE user_id = ?", (world["ali"],))
    db.execute("INSERT INTO availability_weekly (user_id, weekday, start_time, end_time) "
               "SELECT ?, weekday, '14:00', '22:00' FROM availability_weekly WHERE user_id = ?",
               (world["ali"], world["sam"]))
    ok, reasons = can_swap(a, b)
    assert not ok
    assert reasons == ["Ali: Not available at that time"]
