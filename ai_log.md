- generated db script:

## 2026-10-12: Database layer

- **Tool:** Claude Code (Claude Opus 5.5)
- **Files generated:** `schema.sql`, `db.py`, `tests/test_schema.py`

**Summary:** Claude Code generated the database layer for ShiftLink. `schema.sql` creates 11 tables (users, workplaces, memberships, roles, member_roles, shifts, availability_weekly, availability_exceptions, requests, request_events, notifications) with foreign keys, CHECK constraints, UNIQUE rules, and indexes. Every table, column, and constraint has a plain-English comment. The design keeps the real schedule (`shifts`) unchanged until a manager approves a request; until then only `requests.status` changes and each change is logged in `request_events`. `db.py` provides `get_db`, `close_db`, `init_db`, `query`, `execute`, the `flask init-db` command, and `init_app`, using plain `sqlite3` with foreign keys turned on. `tests/test_schema.py` has 7 pytest tests that check the constraints reject bad data (backwards shifts, unknown status, swap with no offered shift, missing user, duplicate email), accept a valid full chain, and clean up correctly when a workplace is deleted. All 7 tests passed, and `flask init-db` was confirmed to work. No routes, templates, or matching logic were written.

### Reviewed by me

- [ ] `schema.sql`
- [ ] `db.py`
- [ ] `tests/test_schema.py`

## 2026-10-24: Logic modules, frontend wiring, tests

- **Tool:** Claude Code (Claude Opus 5.5)
- **Files generated:** `availability.py`, `matching.py`, `notify.py`, `requests_flow.py` (implemented from their TODO specs), `frontend/app.js` (rewired from sample data to the API), `tests/conftest.py`, `tests/test_availability.py`, `tests/test_matching.py`, `tests/test_requests_flow.py`, `README.md`, `requirements.txt`, `.gitignore`
- **Files edited:** `api.py`, `frontend/index.html`, `frontend/tailwind.css`

**Summary:** Claude Code filled in the four modules that `api.py` imports, following the TODO comments in each file. Availability checks whether one window covers the whole shift, and unavailable exceptions always win. Matching collects every reason someone can't take a shift. The request state machine uses an ALLOWED transition map and logs every change to `request_events`. `approve()` re-validates, then updates `shifts` in one transaction and cancels other open requests on those shifts. In `api.py` it fixed `is` → `in` in `body()` (required fields were never checked), renamed `shift_where` → `shifts_where` (callers used that name), added a missing space before `ORDER BY`, added a `SECRET_KEY` (sessions crashed without one), and added an `open_requests` count to shift rows. The frontend now signs in or registers, creates or joins workplaces, and loads the schedule, requests, availability, notifications, and the manager queue from the API. The manager page gained roles, role assignment, and the invite code. The request dialog only offers eligible coworkers and swap shifts. 22 new tests cover the cases listed in the TODOs. All 29 tests pass, and the full coverage flow was checked in a browser.

### Reviewed by me

- [ ] `availability.py`
- [ ] `matching.py`
- [ ] `notify.py`
- [ ] `requests_flow.py`
- [ ] `frontend/app.js`
- [ ] new tests
