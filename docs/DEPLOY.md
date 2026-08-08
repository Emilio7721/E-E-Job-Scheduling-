# Deploying on Railway

The app is a plain Node server with no build step, so Railway runs it as-is.
The one thing you **must** get right is storage: everything the app remembers
lives on disk, and a Railway container's disk is wiped on every redeploy.

## The one thing that will bite you

`data/` holds all of this:

| File | What breaks if it's lost |
|---|---|
| `app.db` | The team, schedule, punches, timesheets, chat — everything |
| `secret.key` | Every session cookie is invalidated: the whole team is signed out |
| `vapid.json` | Every push subscription dies; each phone must re-enable notifications |
| `documents/` | Uploaded PDFs and the signed copies people have already signed |

Without a volume, all of that is recreated empty on your next deploy. **Attach
the volume before you let anyone sign up**, or you will be handing out PINs
twice.

## Steps

1. **Create the project.** Railway → *New Project* → *Deploy from GitHub repo* →
   pick this repository. `railway.json` in the repo root sets the builder, the
   start command and the health check, so there is nothing to configure there.

2. **Add a volume.** Open the service → *Variables/Settings* → **Volumes** →
   *Add Volume*, mount path **`/data`**. Volumes cannot be declared in
   `railway.json`; this step is done in the dashboard (or `railway volume add`).

3. **Set `DATA_DIR=/data`** in the service's variables, so the app writes to the
   volume instead of the container's temporary disk. This is the variable that
   ties steps 2 and 3 together — the volume does nothing without it.

4. **Set the rest of the variables** (see the table below). `PORT` is provided
   by Railway automatically; don't set it yourself.

5. **Generate a domain.** Settings → *Networking* → *Generate Domain*. Railway
   serves it over HTTPS, which is what web push requires — notifications will
   not work over plain HTTP.

6. **Open the domain and sign up first.** The first account created becomes the
   admin. Then Settings → *Enable* push notifications, and use *Test* to confirm
   the device receives one.

## Variables

| Variable | Required | Value |
|---|---|---|
| `DATA_DIR` | **yes** | `/data` — must match the volume's mount path |
| `APP_TZ` | recommended | e.g. `America/Los_Angeles`; used in notification text |
| `VAPID_CONTACT` | recommended | `mailto:you@yourdomain.com`, for the push services |
| `TWILIO_ACCOUNT_SID` | only for real texts | From your Twilio account |
| `TWILIO_AUTH_TOKEN` | only for real texts | From your Twilio account |
| `TWILIO_FROM_NUMBER` | only for real texts | The number blasts are sent from |
| `PORT` | no | Railway sets this; the app reads it |

Without the Twilio variables, text blasts still reach everyone as an in-app push
notification, and the Text Messages screen says so.

## Checking it worked

`GET /api/health` returns the data directory the app is actually using:

```json
{ "ok": true, "users": 4, "data_dir": "/data", "uptime": 42 }
```

If `data_dir` is not `/data`, the volume is not in play and your data is on
disposable disk — fix `DATA_DIR` before going further. Railway pings this same
endpoint on every deploy and holds the rollout until it answers, so a container
that can't reach its database never takes traffic.

## Keep it to one instance

`railway.json` pins `numReplicas` to 1 deliberately. SQLite is a file on one
volume — a second replica would either be pointed at its own empty copy or
fight the first one for write locks. Scale up only if the database moves to
Postgres first.

## Backups

Railway can snapshot the volume, but the simplest belt-and-braces backup is a
copy of `app.db`:

```bash
railway ssh
sqlite3 /data/app.db ".backup '/data/backup-$(date +%F).db'"
```

Do it before anything risky. The timesheet CSV is *not* a backup — it only
carries approved hours for one pay period.
