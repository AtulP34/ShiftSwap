- generated db script:

## 2026-10-12: Database layer

- **Tool:** Claude Code (Claude Opus 5.5)
- **Files generated:** `schema.sql`, `db.py`, `tests/test_schema.py`

**Summary:** Claude Code generated the database layer for ShiftLink. `schema.sql` creates 11 tables (users, workplaces, memberships, roles, member_roles, shifts, availability_weekly, availability_exceptions, requests, request_events, notifications) with foreign keys, CHECK constraints, UNIQUE rules, and indexes. Every table, column, and constraint has a plain-English comment. The design keeps the real schedule (`shifts`) unchanged until a manager approves a request; until then only `requests.status` changes and each change is logged in `request_events`. `db.py` provides `get_db`, `close_db`, `init_db`, `query`, `execute`, the `flask init-db` command, and `init_app`, using plain `sqlite3` with foreign keys turned on. `tests/test_schema.py` has 7 pytest tests that check the constraints reject bad data (backwards shifts, unknown status, swap with no offered shift, missing user, duplicate email), accept a valid full chain, and clean up correctly when a workplace is deleted. All 7 tests passed, and `flask init-db` was confirmed to work. No routes, templates, or matching logic were written.

### Reviewed by me

- [ ] `schema.sql`
- [ ] `db.py`
- [ ] `tests/test_schema.py`
