-- =====================================================================
-- ShiftLink database schema (SQLite)
-- =====================================================================
--
-- BIG PICTURE
-- ShiftLink helps hourly workers trade shifts. The flow is:
--   1. An employee creates a REQUEST (either "cover my shift" or
--      "swap my shift for yours").
--   2. A coworker accepts it.
--   3. A manager approves it.
--
-- THE MOST IMPORTANT RULE: "the schedule only changes on approval."
-- The real schedule lives in the `shifts` table. Creating a request,
-- accepting a request, or declining a request NEVER touches `shifts`.
-- Those steps only change `requests.status` and add a row to
-- `request_events` (the history log). Only when a manager approves does
-- the app update `shifts.assignee_id`. That way a half-finished trade
-- can never leave the schedule in a weird state, and the manager always
-- has the final say.
--
-- HOW DATES AND TIMES ARE STORED
-- SQLite has no real DATE or TIME column type, so we store them as TEXT
-- in ISO 8601 format:
--   dates:           'YYYY-MM-DD'        e.g. '2026-10-12'
--   times:           'HH:MM'             e.g. '09:30' (24 hour clock)
--   date and time:   'YYYY-MM-DDTHH:MM'  e.g. '2026-10-12T09:30'
-- Why TEXT works: SQLite compares TEXT one character at a time, left to
-- right (like sorting words in a dictionary). Because ISO 8601 puts the
-- biggest unit first (year, then month, then day, then hour, then
-- minute) and always pads with zeros ('09' not '9'), alphabetical order
-- is the same as time order. So '2026-10-12T09:30' < '2026-10-12T17:00'
-- is true, and comparisons like end_dt > start_dt just work.
-- The catch: this ONLY works if every value uses the exact same format.
-- That is why several tables below use GLOB checks to reject badly
-- formatted values. (GLOB is SQLite pattern matching: [0-9] means "one
-- digit".)
--
-- FOREIGN KEYS AND "ON DELETE"
-- A foreign key (REFERENCES) says "this column must point at a row that
-- really exists in another table." ON DELETE says what happens to this
-- row if the row it points at is deleted:
--   CASCADE  = delete this row too (it makes no sense on its own).
--   RESTRICT = refuse to delete the other row while this row points at
--              it (this row is too important to lose silently).
-- NOTE: SQLite ignores foreign keys unless you run
-- `PRAGMA foreign_keys = ON` on every connection. db.py does that.
--
-- Running this file wipes and rebuilds every table, so only use it
-- during development (`flask init-db`).
-- =====================================================================


-- ---------------------------------------------------------------------
-- Start fresh: drop old tables if they exist.
-- Children (tables that point at other tables) are dropped before their
-- parents, so we never drop a table that something still points at.
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS request_events;
DROP TABLE IF EXISTS requests;
DROP TABLE IF EXISTS availability_exceptions;
DROP TABLE IF EXISTS availability_weekly;
DROP TABLE IF EXISTS shifts;
DROP TABLE IF EXISTS member_roles;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS workplaces;
DROP TABLE IF EXISTS users;


-- ---------------------------------------------------------------------
-- users
-- One row per person who has a ShiftLink account.
-- Screens: sign up, log in, profile.
-- Relations: a user joins workplaces through `memberships`, holds roles
-- through `member_roles`, is assigned `shifts`, has availability, makes
-- `requests`, and receives `notifications`.
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id            INTEGER PRIMARY KEY,  -- unique number for each user; SQLite fills it in automatically
    name          TEXT NOT NULL,        -- display name shown on the schedule; NOT NULL so nobody shows up blank
    email         TEXT NOT NULL UNIQUE, -- used to log in; UNIQUE stops two accounts from sharing one email (which would make login ambiguous)
    password_hash TEXT NOT NULL,        -- a scrambled (hashed) version of the password; we never store the real password, so a leaked database does not leak passwords
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP  -- when the account was made; SQLite fills it in as 'YYYY-MM-DD HH:MM:SS' (UTC)
);


-- ---------------------------------------------------------------------
-- workplaces
-- One row per business (for example "Joe's Diner").
-- Screens: create workplace, join workplace (by invite code), workplace
-- dashboard.
-- Relations: a workplace has many members (`memberships`), many `roles`,
-- and many `shifts`.
-- ---------------------------------------------------------------------
CREATE TABLE workplaces (
    id          INTEGER PRIMARY KEY,   -- unique number for each workplace
    name        TEXT NOT NULL,         -- business name shown in the header
    invite_code TEXT NOT NULL UNIQUE,  -- short code a manager shares so employees can join; UNIQUE so one code can never lead to two different workplaces
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP  -- when the workplace was created
);


-- ---------------------------------------------------------------------
-- memberships
-- Connects users to workplaces (a "join table"). One row means "this
-- user works at this workplace." A person can work at more than one
-- place, and a place has many people, so we need this middle table.
-- Screens: join workplace, member list, manager settings.
-- Relations: points at `users` and `workplaces`.
-- ---------------------------------------------------------------------
CREATE TABLE memberships (
    -- which user; CASCADE: if the user account is deleted, their membership means nothing, so remove it
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- which workplace; CASCADE: if the workplace is deleted, nobody is a member of it anymore
    workplace_id INTEGER NOT NULL REFERENCES workplaces(id) ON DELETE CASCADE,
    -- 1 = manager (can approve trades), 0 = regular employee; defaults to 0 so nobody becomes a manager by accident
    is_manager   INTEGER NOT NULL DEFAULT 0
                 CHECK (is_manager IN (0, 1)),  -- SQLite has no true/false type, so we use 0/1; this blocks values like 2 or 'yes'
    -- Composite primary key: the pair (user, workplace) must be unique.
    -- Prevents the same person from joining the same workplace twice.
    PRIMARY KEY (user_id, workplace_id)
);


-- ---------------------------------------------------------------------
-- roles
-- Job positions at a workplace (for example "Cashier", "Cook").
-- Screens: manager role settings, schedule (each shift shows its role).
-- Relations: belongs to one workplace; linked to users through
-- `member_roles`; each shift needs one role.
-- ---------------------------------------------------------------------
CREATE TABLE roles (
    id           INTEGER PRIMARY KEY,  -- unique number for each role
    -- which workplace this role belongs to; CASCADE: roles of a deleted workplace are useless
    workplace_id INTEGER NOT NULL REFERENCES workplaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,        -- the role's name, like 'Cashier'
    -- Two workplaces can both have a 'Cashier' role, but one workplace
    -- cannot have 'Cashier' twice (that would confuse the role picker).
    UNIQUE (workplace_id, name)
);


-- ---------------------------------------------------------------------
-- member_roles
-- Which roles each person is trained for. One row means "this user can
-- work this role." Used so the app only offers a shift to coworkers who
-- can actually do that job.
-- Screens: manager staff settings, request screen (picking coworkers).
-- Relations: join table between `users` and `roles`.
-- Note: the database does not check that the user is a member of the
-- role's workplace. The app checks that when adding a row.
-- ---------------------------------------------------------------------
CREATE TABLE member_roles (
    -- which user; CASCADE: a deleted user no longer holds any roles
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- which role; CASCADE: if a role is removed, nobody holds it anymore
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    -- The pair must be unique, so a user cannot be given the same role twice.
    PRIMARY KEY (user_id, role_id)
);


-- ---------------------------------------------------------------------
-- shifts
-- THE SCHEDULE. One row is one block of work: who, which role, when.
-- This is the "source of truth" that only changes when a manager
-- approves a request (see the header comment).
-- Screens: my schedule, workplace schedule, request screen.
-- Relations: belongs to a workplace and a role; assigned to a user;
-- `requests` point at shifts.
-- ---------------------------------------------------------------------
CREATE TABLE shifts (
    id           INTEGER PRIMARY KEY,  -- unique number for each shift
    -- which workplace; CASCADE: deleting a workplace deletes its whole schedule
    workplace_id INTEGER NOT NULL REFERENCES workplaces(id) ON DELETE CASCADE,
    -- which job this shift is for; CASCADE: if a role is deleted (or its
    -- workplace is), its shifts go too. We use CASCADE instead of RESTRICT
    -- here because deleting a workplace removes roles and shifts in the
    -- same step, and RESTRICT would block that cleanup. Managers should
    -- reassign shifts before deleting a role; the app warns them.
    role_id      INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    -- who is working it; RESTRICT: you cannot delete a user who still has
    -- shifts, because that would silently leave holes in the schedule
    assignee_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    -- when the shift starts, 'YYYY-MM-DDTHH:MM'; GLOB rejects other formats so time comparisons stay correct
    start_dt     TEXT NOT NULL
                 CHECK (start_dt GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'),
    -- when the shift ends, same format as start_dt
    end_dt       TEXT NOT NULL
                 CHECK (end_dt GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'),
    -- A shift must end after it starts. Blocks zero-length or backwards
    -- shifts (a typo like 17:00 to 09:00 on the same day).
    -- Overnight shifts are fine because the end has the next day's date.
    CHECK (end_dt > start_dt)
);


-- ---------------------------------------------------------------------
-- availability_weekly
-- A user's normal repeating availability, like "every Monday 09:00 to
-- 17:00." A user can have several rows (several windows per week).
-- Screens: my availability.
-- Relations: belongs to one user. The app reads this to suggest which
-- coworkers could take a shift.
-- ---------------------------------------------------------------------
CREATE TABLE availability_weekly (
    id         INTEGER PRIMARY KEY,  -- unique number for each availability window
    -- whose availability; CASCADE: a deleted user's availability is useless
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- day of the week: 0 = Monday ... 6 = Sunday (same as Python's date.weekday()); CHECK blocks 7, -1, etc.
    weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    -- start of the window, 'HH:MM'; GLOB rejects formats like '9:30' that would sort wrong
    start_time TEXT NOT NULL CHECK (start_time GLOB '[0-9][0-9]:[0-9][0-9]'),
    -- end of the window, 'HH:MM'
    end_time   TEXT NOT NULL CHECK (end_time GLOB '[0-9][0-9]:[0-9][0-9]'),
    -- The window must end after it starts (blocks backwards windows).
    -- Note: a window that crosses midnight (22:00 to 02:00) must be saved
    -- as two rows, one on each day.
    CHECK (end_time > start_time)
);


-- ---------------------------------------------------------------------
-- availability_exceptions
-- One-off changes to the weekly pattern, for a single date. Examples:
-- "unavailable 2026-11-26 all day (Thanksgiving)" or "available
-- 2026-11-28 08:00 to 12:00 even though I usually am not."
-- Screens: my availability (exceptions section).
-- Relations: belongs to one user. Overrides `availability_weekly` for
-- that date when the app checks who is free.
-- ---------------------------------------------------------------------
CREATE TABLE availability_exceptions (
    id         INTEGER PRIMARY KEY,  -- unique number for each exception
    -- whose exception; CASCADE: a deleted user's exceptions are useless
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- the date it applies to, 'YYYY-MM-DD'; GLOB keeps the format consistent
    date       TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    -- start of the window on that date, 'HH:MM' (use '00:00' for all day)
    start_time TEXT NOT NULL CHECK (start_time GLOB '[0-9][0-9]:[0-9][0-9]'),
    -- end of the window on that date, 'HH:MM' (use '23:59' for all day)
    end_time   TEXT NOT NULL CHECK (end_time GLOB '[0-9][0-9]:[0-9][0-9]'),
    -- whether this window means "I can't work" or "I can work"; CHECK blocks typos like 'unavailble'
    kind       TEXT NOT NULL CHECK (kind IN ('unavailable', 'available')),
    -- The window must end after it starts (blocks backwards windows).
    CHECK (end_time > start_time)
);


-- ---------------------------------------------------------------------
-- requests
-- A request to give away a shift (coverage) or trade it (swap).
-- This is where trades "wait" while they move through the steps. The
-- schedule (`shifts`) is not changed until status becomes 'approved'.
-- Status flow:
--   awaiting_coworker -> awaiting_manager -> approved
--   (any open step can also go to 'declined' or 'canceled')
-- Screens: create request, my requests, coworker inbox, manager
-- approval queue.
-- Relations: points at the shift being given away, the person asking,
-- optionally a specific coworker, and (for swaps) the shift offered in
-- return. Its history lives in `request_events`.
-- ---------------------------------------------------------------------
CREATE TABLE requests (
    id               INTEGER PRIMARY KEY,  -- unique number for each request
    -- 'coverage' = "someone please take my shift", 'swap' = "trade shifts with me"; CHECK blocks any other word
    type             TEXT NOT NULL CHECK (type IN ('coverage', 'swap')),
    -- the shift the requester wants to give away; CASCADE: if the shift is
    -- deleted from the schedule, a request about it is meaningless
    shift_id         INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    -- who made the request; RESTRICT: keep the record of who asked, so a
    -- user with request history cannot be deleted by accident
    requester_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    -- a specific coworker being asked, or NULL meaning "anyone qualified";
    -- RESTRICT for the same history reason as requester_id
    target_user_id   INTEGER NULL REFERENCES users(id) ON DELETE RESTRICT,
    -- for swaps: the coworker's shift the requester would take in return;
    -- NULL for coverage. CASCADE: if that shift is deleted, the swap
    -- cannot happen anymore, so the request goes too
    offered_shift_id INTEGER NULL REFERENCES shifts(id) ON DELETE CASCADE,
    -- where the request is in the approval flow; new requests start waiting for a coworker
    status           TEXT NOT NULL DEFAULT 'awaiting_coworker'
                     CHECK (status IN ('awaiting_coworker', 'awaiting_manager',
                                       'approved', 'declined', 'canceled')),  -- blocks typos like 'aproved' that would make a request vanish from every screen
    created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- when the request was made (used to sort the inbox)

    -- A coverage request must NOT have an offered shift (nothing is
    -- given back), and a swap request MUST have one (otherwise it is not
    -- a swap). Prevents half-filled requests the approval code can't handle.
    CHECK (
        (type = 'coverage' AND offered_shift_id IS NULL) OR
        (type = 'swap'     AND offered_shift_id IS NOT NULL)
    ),
    -- You cannot swap a shift for itself (the approval would do nothing).
    CHECK (offered_shift_id IS NULL OR offered_shift_id <> shift_id),
    -- You cannot ask yourself to cover your own shift.
    CHECK (target_user_id IS NULL OR target_user_id <> requester_id)
);


-- ---------------------------------------------------------------------
-- request_events
-- The change history (audit log) for requests. Every time a request's
-- status changes, the app adds one row here. Rows are only ever added,
-- never edited, so there is always a record of who did what and when.
-- This is how a manager (or a judge) can see exactly how a shift ended
-- up with someone.
-- Screens: request detail page (timeline).
-- Relations: belongs to one request; points at the user who acted.
-- ---------------------------------------------------------------------
CREATE TABLE request_events (
    id          INTEGER PRIMARY KEY,  -- unique number for each event
    -- which request changed; CASCADE: if the request itself is removed, its history goes with it
    request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    -- who made the change; RESTRICT: never lose track of who approved or declined something
    actor_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    -- status before the change; NULL for the very first event (the request did not exist yet)
    from_status TEXT NULL
                CHECK (from_status IS NULL OR from_status IN ('awaiting_coworker', 'awaiting_manager',
                                                              'approved', 'declined', 'canceled')),  -- same allowed list as requests.status, so history can't contain made-up statuses
    -- status after the change
    to_status   TEXT NOT NULL
                CHECK (to_status IN ('awaiting_coworker', 'awaiting_manager',
                                     'approved', 'declined', 'canceled')),  -- same allowed list as requests.status
    note        TEXT NULL,            -- optional message, like a manager's reason for declining
    at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP  -- when the change happened (orders the timeline)
);


-- ---------------------------------------------------------------------
-- notifications
-- Messages shown to a user, like "Sam accepted your swap" or "Your
-- request was approved."
-- Screens: notification bell / inbox.
-- Relations: belongs to one user.
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
    id         INTEGER PRIMARY KEY,  -- unique number for each notification
    -- who should see it; CASCADE: a deleted user's notifications are useless
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message    TEXT NOT NULL,        -- the text shown to the user
    link       TEXT NULL,            -- optional page to open when clicked (e.g. '/requests/12'); NULL if nothing to open
    is_read    INTEGER NOT NULL DEFAULT 0
               CHECK (is_read IN (0, 1)),  -- 0 = unread, 1 = read; CHECK blocks values that would break the unread count
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP  -- when it was sent (newest shown first)
);


-- =====================================================================
-- INDEXES
-- An index is like the index at the back of a textbook: it lets SQLite
-- jump straight to matching rows instead of reading every row in the
-- table. They cost a little extra space and make inserts slightly
-- slower, so we only add them for queries the app runs a lot.
-- An index on (a, b) also helps queries that only filter on a.
-- =====================================================================

-- "My schedule": WHERE assignee_id = ? ORDER BY start_dt.
-- Also used to check if a coworker already has a shift at that time.
CREATE INDEX idx_shifts_assignee_start ON shifts(assignee_id, start_dt);

-- "Workplace schedule": WHERE workplace_id = ? (usually for a date range, sorted by time).
CREATE INDEX idx_shifts_workplace_start ON shifts(workplace_id, start_dt);

-- "Who is free?": WHERE user_id = ? AND weekday = ?.
CREATE INDEX idx_availability_weekly_user ON availability_weekly(user_id, weekday);

-- "Any exceptions on this date?": WHERE user_id = ? AND date = ?.
CREATE INDEX idx_availability_exceptions_user ON availability_exceptions(user_id, date);

-- Manager approval queue and coworker inbox: WHERE status = 'awaiting_manager' (or 'awaiting_coworker').
CREATE INDEX idx_requests_status ON requests(status);

-- "Is there already a request for this shift?": WHERE shift_id = ?.
CREATE INDEX idx_requests_shift ON requests(shift_id);

-- Request detail timeline: WHERE request_id = ? ORDER BY at.
CREATE INDEX idx_request_events_request ON request_events(request_id);

-- Notification bell unread count: WHERE user_id = ? AND is_read = 0.
CREATE INDEX idx_notifications_user_read ON notifications(user_id, is_read);
