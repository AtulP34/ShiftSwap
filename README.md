# ShiftSwap

ShiftSwap helps hourly workers trade shifts. An employee asks a coworker to cover a shift (or swap one), the coworker accepts, and a manager approves. The schedule only changes when the manager approves.

## Run it locally

You need Python 3.10 or newer.

```bash
pip install -r requirements.txt
flask --app api init-db      # creates instance/shiftlink.sqlite (wipes it if it exists)
flask --app api run --debug  # http://127.0.0.1:5000
```

On Windows, if `pip` or `flask` isn't found, use `python -m pip ...` and `python -m flask ...`.

Set the `SECRET_KEY` environment variable for anything other than local development. Without it, sessions are signed with `dev`.

## Try the whole flow

1. Create an account, then **Create workplace**. You're its manager. The invite code is on the Manager page.
2. On the Manager page, add a role (for example "Cook") and give it to people.
3. In a second browser (or a private window), create another account and **Join** with the invite code. Set availability on the Availability page.
4. As the manager, **Add shift** for people.
5. Employees open **Requests → New request** (or click their own shift) to ask for coverage or a swap. Only coworkers who are trained, available, and not already working are offered.
6. The coworker accepts. The manager approves or rejects under **Manager**.

## Tests

```bash
pytest
```

## Layout

| File | What it does |
| --- | --- |
| `api.py` | Flask routes (JSON under `/api`) and serves `frontend/` |
| `db.py` | SQLite connection helpers and `flask init-db` |
| `schema.sql` | Tables and rules. Read the header first. |
| `availability.py` | Is someone free for a whole shift? |
| `matching.py` | Who can cover a shift, and can two shifts be swapped |
| `requests_flow.py` | Request state machine. `approve()` is the only code that changes `shifts`. |
| `notify.py` | Notification bell |
| `frontend/` | Single-page app (`index.html`, `app.js`, `tailwind.css`) |
| `tests/` | pytest tests |

For the availability and notifications module contracts and integration notes, see [BACKEND_HANDOFF.md](BACKEND_HANDOFF.md).
