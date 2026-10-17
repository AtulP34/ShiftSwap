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


# TODO notify(user_id, message, link=None) -> None
#   Insert one unread row. link is a frontend path like '/requests/12'.


# TODO unread_count(user_id) -> int
#   COUNT(*) where is_read = 0. Return a plain int, not a Row.


# TODO mark_read(user_id) -> None
#   Set is_read = 1 on all of this user's notifications.
