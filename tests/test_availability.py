"""Tests for availability.py: is someone free for a whole shift?

Run with: pytest tests/test_availability.py -v
"""

import db
from availability import is_available, overlaps
from conftest import DAY, add_exception, add_weekly


def new_user():
    return db.execute("INSERT INTO users (name, email, password_hash) VALUES ('Pat', 'pat@example.com', 'x')")


def test_overlaps_ignores_touching_ends():
    assert overlaps("09:00", "12:00", "11:00", "15:00")
    assert not overlaps("09:00", "12:00", "12:00", "15:00")


def test_partial_availability_is_rejected(app):
    user = new_user()
    add_weekly(user, "09:00", "11:00")
    assert not is_available(user, f"{DAY}T09:00", f"{DAY}T12:00")


def test_shift_exactly_matching_window_edges_is_accepted(app):
    user = new_user()
    add_weekly(user, "09:00", "12:00")
    assert is_available(user, f"{DAY}T09:00", f"{DAY}T12:00")


def test_unavailable_exception_overrides_weekly_window(app):
    user = new_user()
    add_weekly(user, "08:00", "20:00")
    add_exception(user, "10:00", "11:00", "unavailable")
    assert not is_available(user, f"{DAY}T09:00", f"{DAY}T12:00")
    # a shift that doesn't touch the exception is still fine
    assert is_available(user, f"{DAY}T12:00", f"{DAY}T16:00")


def test_available_exception_adds_window_on_day_with_no_weekly_rows(app):
    user = new_user()
    assert not is_available(user, f"{DAY}T09:00", f"{DAY}T12:00")
    add_exception(user, "08:00", "13:00", "available")
    assert is_available(user, f"{DAY}T09:00", f"{DAY}T12:00")


def test_adjacent_windows_are_not_stitched(app):
    user = new_user()
    add_weekly(user, "09:00", "11:00")
    add_weekly(user, "11:00", "13:00")
    assert not is_available(user, f"{DAY}T09:00", f"{DAY}T12:00")
