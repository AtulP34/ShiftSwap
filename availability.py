"""Availability checks for a user's whole shift window.

A user is free only when one weekly window or one available exception
covers the complete shift. Any overlapping unavailable exception takes
precedence over both.
"""

from datetime import datetime

from db import query


def overlaps(a_start, a_end, b_start, b_end):
    """Return whether two half-open time ranges overlap."""
    return a_start < b_end and b_start < a_end


def is_available(user_id, start, end):
    """Check availability for a same-day ISO shift window."""
    try:
        start_dt = datetime.strptime(start, "%Y-%m-%dT%H:%M")
        end_dt = datetime.strptime(end, "%Y-%m-%dT%H:%M")
    except (TypeError, ValueError):
        return False

    if end_dt <= start_dt or start_dt.date() != end_dt.date():
        return False

    date = start_dt.strftime("%Y-%m-%d")
    start_time = start_dt.strftime("%H:%M")
    end_time = end_dt.strftime("%H:%M")
    weekday = start_dt.weekday()

    exceptions = query(
        """SELECT start_time, end_time, kind
           FROM availability_exceptions
           WHERE user_id = ? AND date = ?""",
        (user_id, date),
    )

    # Unavailable exceptions always override a weekly or available window.
    if any(
        row["kind"] == "unavailable"
        and overlaps(start_time, end_time, row["start_time"], row["end_time"])
        for row in exceptions
    ):
        return False

    windows = query(
        """SELECT start_time, end_time
           FROM availability_weekly
           WHERE user_id = ? AND weekday = ?""",
        (user_id, weekday),
    )
    windows.extend(
        {"start_time": row["start_time"], "end_time": row["end_time"]}
        for row in exceptions
        if row["kind"] == "available"
    )

    return any(
        window["start_time"] <= start_time and window["end_time"] >= end_time
        for window in windows
    )
