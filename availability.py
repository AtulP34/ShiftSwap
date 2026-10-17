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
#
# Use query() from db for reads.


# TODO overlaps(a_start, a_end, b_start, b_end) -> bool
#   True if the two ranges share any time.
#   Touching ends do NOT count: 09:00-12:00 and 12:00-15:00 don't overlap.
#   One line: a_start < b_end and b_start < a_end
#   matching.has_conflict() needs this too, so import it there.


# TODO is_available(user_id, start, end) -> bool
#   1. Split start/end into date + 'HH:MM', and get the weekday from the date.
#   2. Load that user's 'unavailable' exceptions for that date.
#      If ANY of them overlaps the shift -> False. Unavailable always wins.
#   3. Build the list of "free" windows:
#        weekly rows for that weekday
#      + 'available' exceptions for that date
#   4. Return True only if ONE window covers the WHOLE shift:
#        window.start_time <= shift_start and window.end_time >= shift_end
#      Partial coverage (free 09:00-11:00 for a 09:00-12:00 shift) -> False.
#      Don't stitch adjacent windows together; keep it simple.
#
#   Tests to write (tests/test_availability.py):
#     - partial availability is rejected
#     - an unavailable exception overrides a weekly window
#     - an available exception adds a window on a day with no weekly rows
#     - a shift exactly matching a window's edges is accepted
