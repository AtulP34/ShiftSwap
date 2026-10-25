# Notifications: the bell icon in the navbar.
# checklist.md section 3 (Oct 18). Build this first; requests_flow.py depends on it.
#
# Used by:
#   api.py list_notifications() -> unread_count(user_id)
#   api.py read_notifications() -> mark_read(user_id)
#   requests_flow.py            -> notify(...) on every status change
#
# Table: notifications (user_id, message, link, is_read 0/1, created_at).
# Small file, each function is one query.

from db import execute, query


def notify(user_id, message, link=None):
    # link is a frontend path like '/requests/12'
    execute("INSERT INTO notifications (user_id, message, link) VALUES (?, ?, ?)", (user_id, message, link))


def unread_count(user_id):
    row = query("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0", (user_id,), one=True)
    return row["n"]


def mark_read(user_id):
    execute("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0", (user_id,))
