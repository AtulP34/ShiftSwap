"""Notifications persist correctly and API callers can access only their own."""

import db
from notify import mark_read, notify, unread_count


def test_new_notification_is_unread_and_preserves_message_and_link(world):
    message = "Sam's request: <coverage>?"
    assert notify(world["ali"], message, "/requests/123") is None
    row = db.query(
        "SELECT * FROM notifications WHERE user_id = ?", (world["ali"],), one=True
    )
    assert row["message"] == message
    assert row["link"] == "/requests/123"
    assert row["is_read"] == 0
    assert row["created_at"]
    assert unread_count(world["ali"]) == 1

    # A new connection must see the notification after the helper returns.
    db.close_db()
    assert unread_count(world["ali"]) == 1


def test_notifications_can_omit_link(world):
    notify(world["sam"], "Schedule updated")
    row = db.query(
        "SELECT link FROM notifications WHERE user_id = ?", (world["sam"],), one=True
    )
    assert row["link"] is None


def test_unread_count_excludes_read_rows_and_other_users(world):
    assert unread_count(world["sam"]) == 0
    assert type(unread_count(world["sam"])) is int
    notify(world["sam"], "Already read")
    mark_read(world["sam"])
    notify(world["sam"], "Unread")
    notify(world["ali"], "Someone else's notification")
    assert unread_count(world["sam"]) == 1
    assert unread_count(world["ali"]) == 1


def test_mark_read_is_idempotent_and_scoped_to_user(world):
    notify(world["sam"], "First")
    notify(world["sam"], "Second")
    notify(world["ali"], "Keep unread")
    assert mark_read(world["sam"]) is None
    mark_read(world["sam"])
    assert unread_count(world["sam"]) == 0
    assert unread_count(world["ali"]) == 1
    assert db.query(
        "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?",
        (world["sam"],), one=True,
    )["n"] == 2

    notify(world["sam"], "New after reading")
    assert unread_count(world["sam"]) == 1


def test_notification_api_requires_login(world, app):
    client = app.test_client()
    assert client.get("/api/notifications").status_code == 401
    assert client.post("/api/notifications/read").status_code == 401


def test_notification_api_lists_and_marks_only_session_users_rows(world, app):
    notify(world["sam"], "For Sam", "/requests/123")
    notify(world["ali"], "Private to Ali", "/requests/456")
    client = app.test_client()
    with client.session_transaction() as session:
        session["user_id"] = world["sam"]

    response = client.get("/api/notifications")
    assert response.status_code == 200
    data = response.get_json()
    assert data["unread"] == 1
    assert [item["message"] for item in data["items"]] == ["For Sam"]
    assert data["items"][0]["link"] == "/requests/123"

    # Supplying another user's id must not change whose notifications are read.
    response = client.post(
        "/api/notifications/read", json={"user_id": world["ali"]}
    )
    assert response.status_code == 200
    assert response.get_json() == {"ok": True}
    assert unread_count(world["ali"]) == 1
    data = client.get("/api/notifications").get_json()
    assert data["unread"] == 0
    assert data["items"][0]["is_read"] == 1
