# Backend half: availability and notifications

This change owns two of the four original logic modules: `availability.py`
and `notify.py`. This is a module split, not a claim of equal lines of code
or equal effort. The companion half is `matching.py` and `requests_flow.py`.

The latest main commit used here is
`3e458dd7637ed1f4ca6024c0305fd43bd77ff423`. It already implements the
companion half and connects the frontend. This branch integrates the
availability and notification implementation from PR #2 with that version.

## Stable interfaces

All database calls require a Flask application context and use the same
per-context connection from `db.py`.

| Function | Result and contract |
| --- | --- |
| `overlaps(a_start, a_end, b_start, b_end)` | Boolean for valid, consistently formatted half-open ranges. Touching ends do not overlap. |
| `is_available(user_id, start, end)` | Boolean for a positive, same-day `YYYY-MM-DDTHH:MM` interval. Invalid input, reversed or empty intervals, overnight intervals, or no covering window return false. |
| `notify(user_id, message, link=None)` | Inserts and commits an unread notification, returns None. The user must exist. SQL values are bound parameters. Database errors propagate. |
| `unread_count(user_id)` | Plain integer; counts only that user's unread rows, including zero. |
| `mark_read(user_id)` | Marks only that user's existing unread rows, commits, returns None. Safe to repeat; new notifications remain unread. |

Availability reads only. One weekly window or one available exception must
cover the entire shift. Adjacent windows are not combined. Any overlapping
unavailable exception takes precedence. Weekdays are Monday = 0 through
Sunday = 6. Availability is global per user, as defined by the existing schema.

Notification links remain frontend paths such as `/requests/123`. Existing
HTTP endpoints remain `GET /api/notifications` (an `unread` count and up to
50 `items`) and `POST /api/notifications/read`. Both use the session user.
The latter marks all unread rows, including rows beyond the 50 displayed.

## Building on this half

- Matching can import `overlaps` and `is_available` directly, adding role,
  workplace, assignment-conflict, and swap checks itself.
- Request processing owns state transitions, actor permissions, event logs,
  revalidation, and schedule mutations. Keep schedule changes in `approve()`.
- Existing `notify()` calls commit through `db.execute()`. Call them after a
  schedule transaction commits. Calling them inside one would commit it early.
  If atomic notification delivery is needed later, introduce a shared
  transaction or outbox contract before changing this behavior.
- Availability validation at HTTP write boundaries, overnight support, and
  cross-request concurrency guarantees are separate follow-up work. Returning
  false from `is_available()` is not a replacement for HTTP input validation.

## Verification

Run from the repository root:

```bash
python -m pip install -r requirements.txt
python -m pytest -q
```

The suite includes availability boundaries, invalid intervals, user/date
isolation, notification persistence, idempotent marking, session ownership,
and the existing matching and request-flow integration tests.
