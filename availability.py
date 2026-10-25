# Availability: "is this person free for this whole block of time?"
# checklist.md section 4 (Oct 18).
#
# Used by:
#   api.py team_availability()  -> is_available(user_id, start, end)
#   matching.py can_cover()     -> same call, to filter coworkers
#
# Saving/deleting availability rows already happens in api.py
# (add_weekly, add_exception, delete_availability), so this file only READS.
#
# Formats (see schema.sql header):
#   start / end args:  'YYYY-MM-DDTHH:MM'
#   weekly + exception rows store 'HH:MM' times and exceptions store 'YYYY-MM-DD' dates
#   weekday: 0 = Mon ... 6 = Sun, same as datetime.date.weekday()
# Zero-padded ISO strings compare correctly as plain strings, so no need
# to parse times into datetime objects just to compare them.
#
# MVP limit: assume a shift starts and ends on the same date. Overnight
# availability is stored as two rows, and supporting overnight shifts here
# is a stretch goal.

from datetime import date

from db import query


def overlaps(a_start, a_end, b_start, b_end):
    # touching ends don't count: 09:00-12:00 and 12:00-15:00 don't overlap
    return a_start < b_end and b_start < a_end


def is_available(user_id, start, end):
    day, shift_start = start.split("T")
    end_day, shift_end = end.split("T")
    if end_day != day:
        return False  # overnight shifts aren't supported yet (see MVP limit above)
    weekday = date.fromisoformat(day).weekday()

    exceptions = query(
        "SELECT start_time, end_time, kind FROM availability_exceptions WHERE user_id = ? AND date = ?",
        (user_id, day),
    )

    # unavailable always wins
    for ex in exceptions:
        if ex["kind"] == "unavailable" and overlaps(ex["start_time"], ex["end_time"], shift_start, shift_end):
            return False

    windows = list(query(
        "SELECT start_time, end_time FROM availability_weekly WHERE user_id = ? AND weekday = ?",
        (user_id, weekday),
    ))
    windows += [ex for ex in exceptions if ex["kind"] == "available"]

    # one window has to cover the whole shift; no stitching windows together
    return any(w["start_time"] <= shift_start and w["end_time"] >= shift_end for w in windows)
