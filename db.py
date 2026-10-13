"""Database helpers for ShiftLink.

This file is the only place that talks to SQLite directly. Routes call
query() to read and execute() to write, so the rest of the app never has
to open or close connections itself.

How a Flask request uses it:
  1. A route calls query() or execute().
  2. Those call get_db(), which opens ONE connection for this request
     and saves it on Flask's `g` object (a scratchpad that lives for one
     request only).
  3. When the request ends, Flask calls close_db(), which closes it.
"""

import os
import sqlite3

import click
from flask import current_app, g


def get_db():
    """Return the database connection for the current request.

    Opens a new connection the first time it is called during a request,
    then reuses that same connection for the rest of the request.
    """
    # `g` is Flask's per-request storage. If we already opened a
    # connection during this request, it is saved as g.db.
    if "db" not in g:
        # Open (or create) the SQLite file named in the app's config.
        g.db = sqlite3.connect(current_app.config["DATABASE"])

        # Make rows behave like dictionaries, so code (and Jinja
        # templates) can write row["name"] instead of row[1].
        g.db.row_factory = sqlite3.Row

        # SQLite does NOT enforce foreign keys by default (for backward
        # compatibility with very old databases). Without this line, all
        # the REFERENCES and ON DELETE rules in schema.sql would be
        # silently ignored. It must be turned on for every new connection.
        g.db.execute("PRAGMA foreign_keys = ON")

    return g.db


def close_db(e=None):
    """Close the database connection at the end of a request.

    Flask calls this automatically (see init_app). `e` is the error that
    ended the request, if any; we do not need it, but Flask passes it in.
    """
    # Remove the connection from `g`. pop() returns None if there was
    # none, which happens when a request never touched the database.
    db = g.pop("db", None)

    if db is not None:
        db.close()


def init_db():
    """Create all tables by running schema.sql.

    WARNING: schema.sql drops existing tables first, so this erases all data.
    """
    db = get_db()

    # open_resource() finds schema.sql next to the app's code, no matter
    # which folder you ran `flask` from.
    with current_app.open_resource("schema.sql") as f:
        # executescript() runs a file containing many SQL statements.
        # The file is read as bytes, so decode it to text first.
        db.executescript(f.read().decode("utf8"))


def query(sql, args=(), one=False):
    """Run a SELECT and return the results.

    sql:  the SQL text, with ? placeholders for values.
    args: the values for the ? placeholders, in order.
    one:  if True, return just the first row (or None if no rows).

    Always pass values through args, never paste them into the SQL
    string. The ? placeholders stop SQL injection attacks.

    Example:
        user = query("SELECT * FROM users WHERE email = ?", (email,), one=True)
    """
    # Run the query; the cursor holds the results.
    cur = get_db().execute(sql, args)

    # Pull every result row into a Python list.
    rows = cur.fetchall()

    # Done with the cursor.
    cur.close()

    if one:
        # Return the first row, or None if the query found nothing.
        return rows[0] if rows else None
    return rows


def execute(sql, args=()):
    """Run an INSERT, UPDATE, or DELETE and save it.

    Returns the id of the newly inserted row (useful right after an
    INSERT, for example to redirect to the new request's page).

    Example:
        new_id = execute("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
                         (name, email, pw_hash))
    """
    db = get_db()

    # Run the write. If it breaks a rule in schema.sql (a CHECK, UNIQUE,
    # or foreign key), sqlite3 raises IntegrityError here and nothing is saved.
    cur = db.execute(sql, args)

    # commit() makes the change permanent. Without it, the change is
    # thrown away when the connection closes.
    db.commit()

    # lastrowid is the id SQLite gave the row we just inserted.
    return cur.lastrowid


@click.command("init-db")
def init_db_command():
    """Wipe the database and create fresh tables (run: flask init-db)."""
    init_db()
    # click.echo prints to the terminal, like print().
    click.echo("Initialized the database.")


def init_app(app):
    """Hook the database helpers into a Flask app.

    Call this once from the app factory: db.init_app(app)
    """
    # Default database location: instance/shiftlink.sqlite. The
    # "instance" folder is Flask's place for files that are not code and
    # should not be committed to git. setdefault keeps any path the app
    # (or a test) already set.
    app.config.setdefault("DATABASE", os.path.join(app.instance_path, "shiftlink.sqlite"))

    # Make sure the instance folder exists, or sqlite3 cannot create the file.
    os.makedirs(app.instance_path, exist_ok=True)

    # Tell Flask to call close_db after every request, even if it crashed.
    app.teardown_appcontext(close_db)

    # Add `flask init-db` to the command line.
    app.cli.add_command(init_db_command)
