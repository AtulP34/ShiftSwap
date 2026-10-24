"""Small helpers for creating and reading notification records."""

from db import execute, query


def notify(user_id, message, link=None):
    """Create an unread notification for a user."""
    execute(
        "INSERT INTO notifications (user_id, message, link) VALUES (?, ?, ?)",
        (user_id, message, link),
    )


def unread_count(user_id):
    """Return the number of unread notifications for a user."""
    result = query(
        "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0",
        (user_id,),
        one=True,
    )
    return int(result["count"])


def mark_read(user_id):
    """Mark all of a user's notifications as read."""
    execute(
        "UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0",
        (user_id,),
    )
