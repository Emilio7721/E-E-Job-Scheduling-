# E&E Job Scheduling

A Connecteam-style workforce app for E&E: **job scheduling**, **venues**, **team chat**, and **push notifications that reach your phone** — installable on iPhone and Android as an app (PWA).

## Features

- **📅 Job scheduling** — a **week calendar** (days across, **all 24 hours** down, current-time line) showing every job in its real time slot with venue and crew; members see teammates' names only for venues they work that day. It opens on the working part of the day, and **on a phone it opens on today**. **Tap a date to schedule on it** — the day stays picked and every new job starts there — or **tap an empty slot to open a new job already set to that day and hour** (eight hours long by default, rolling past midnight when that's what the job does). Admin edits are recorded, so staff can open a job and see exactly what changed. Admins create jobs with a title, venue, start/end time, notes, and assigned team members. Employees see their jobs and **accept or decline** with one tap (admins are notified of the response), and anyone **added to a job that already exists gets their own alert** saying so and asking for a reply.
- **📗 Availability** — staff mark the times they *can't* work (all day or a time range, with a note), optionally repeating weekly for a chosen number of weeks. The schedule refuses to book anyone during their unavailability.
- **🚫 Conflict protection** — nobody can be scheduled at two venues at once, or into a time they marked unavailable; the clash is spelled out before the job can be saved.
- **📍 Venues** — manage your venue list (name, address, notes, color). Jobs link to venues, and addresses open directly in Google Maps.
- **💬 Team chat** — a company-wide **General** channel, admin-created group channels, and 1-on-1 direct messages. Messages arrive in real time, with unread badges and last-message previews.
- **⏱️ Time clock** — one-tap clock in/out, optionally linked to the day's job, with **GPS location recorded at punch time** (when the employee allows it). Employees see their weekly hours at a glance.
- **🧾 Timesheets & meal periods** — **bi-weekly pay periods**; admins open each person to review their punches day by day, edit times, venue, job, mileage and read shift notes, then approve individually or all at once. **California meal periods are applied automatically and are not editable**: a workday over 5 hours loses one unpaid 30-minute meal period, a workday over 10 hours loses a second, counted per day no matter how many punches it contains. Overtime follows the same law — over 8 hours a day or 40 straight-time hours a week at 1.5×, over 12 hours a day at 2×, and the seventh consecutive day of a workweek at 1.5× then 2×. A single **timesheet CSV** download produces the full overview in the standard 27-column layout (per-shift rows, daily unpaid break and total, weekly total, and per-person work/break/paid/regular/overtime totals). It carries **approved hours only**, and stays locked until every punch in the period has been approved and no punch is still running.
- **📄 Documents & e-signatures** — admins upload a PDF (handbook, waiver, policy); the team reads it on their phone and signs with a typed name plus a drawn signature. Admins can **place signature, date and printed-name fields anywhere on the document** — tap the page where each stamp belongs — and every signer's handwriting is burned into those exact spots, with an audit signature page appended as well. Admins get a **Signed Documents** screen showing who has and hasn't signed, with per-person and bulk downloads.
- **👔 Attire** — admins define what to wear (name, description, photo, colour); each scheduled job can specify the attire, and the Attire tab shows everyone the outfit for their next job.
- **📢 Updates feed** — company announcements posted by admins, pushed to every phone, with likes.
- **✉️ Text messages** — one message from the company number out to **every phone on the team** (everyone signed up in the app), or to a hand-picked few. **Send it now or schedule it for a date and time** — it goes out on its own, whether or not anyone is online. The screen keeps the full record in one table: when it went, who sent it, the message, how many it reached, the delivery rate and the cost, and opening a message shows every recipient's number and delivery status. Texts leave through a Twilio-compatible carrier account when one is configured (see below); with no account connected they still reach everyone as an app push notification, and each recipient is recorded as such.
- **🔔 Notifications on your phone** — real web push notifications (banner + lock screen) for job assignments, schedule changes, cancellations, chat messages, tasks, time-off decisions, new forms, and announcements — even when the app is closed. Plus an in-app notification feed.
- **🔑 PIN sign-in** — no passwords: new team members sign up with their **name and phone number** and get a unique **5-digit PIN** used to sign in and clock in. The **first account created becomes the admin**.
- **🔢 Kiosk mode** — an admin PIN locks any device into a full-screen punch clock (it stays locked across restarts until an admin PIN is entered again). Members clock in/out **only at the kiosk**, in person; admins can also punch from their own phone.
- **👥 Team** — everyone who signs up appears in the team list; admins manage roles, hourly rates, and PINs.
- **💾 Forms that keep your place** — every answer in a checklist, and the name, tick and signature on a document, are saved to the device the moment they're made. Close the app mid-checklist, take a call, come back tomorrow: it reopens exactly where it was left, with a **Start over** button if you'd rather begin again. Drafts clear themselves once the form is sent.
- **📱 Installable app** — add it to your home screen and it runs full-screen with its own icon, like a native app. On desktop it becomes a full workspace: a grouped sidebar (Communication, Operations, Setup), a search box that jumps to any screen, teammate or venue, and each screen laid out as a titled panel. Editors that carry a **mobile preview** show the phone beside the form, so an admin sees the member's screen while writing it.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

No database server or configuration needed — it uses SQLite (built into Node 22+) and stores everything in `data/`. VAPID keys for push notifications are generated automatically on first boot.

**Requires Node.js 22 or newer.**

1. Open the app and **sign up first (name + phone) — the first account becomes the admin** and receives its PIN.
2. Add your venues (Venues tab → ＋).
3. Create jobs (Schedule tab → ＋), assign team members — they get notified instantly.
4. Share the app's URL with your team; they sign up with name + number, get a PIN, and appear in Team, Chat, and the scheduler.
5. On a venue tablet/phone: More → Kiosk Mode → enter an admin PIN to lock it into the punch clock.

## Getting notifications on phones

Push notifications require the app to be served over **HTTPS** (any host or reverse proxy works — Caddy, nginx + Let's Encrypt, Railway, Render, Fly.io, etc.). Then:

- **Android (Chrome):** open the app → Settings tab → **Enable** push notifications. Optionally use the browser menu → *Install app*.
- **iPhone (iOS 16.4+):** open the app in Safari → Share → **Add to Home Screen** → open the app **from the home screen icon** → Settings tab → **Enable**. (Apple only allows web push for installed home-screen apps.)

Use the **Test** button in Settings to confirm the device receives notifications.

## Configuration (optional)

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `APP_TZ` | `America/New_York` | Time zone used in notification text |
| `VAPID_CONTACT` | `mailto:admin@example.com` | Contact for push service |
| `TWILIO_ACCOUNT_SID` | — | Carrier account for real text messages |
| `TWILIO_AUTH_TOKEN` | — | Carrier auth token (kept in the server's environment, never in the database) |
| `TWILIO_FROM_NUMBER` | — | Number texts are sent from; can be overridden in Settings → Text messaging |

## Sending real text messages

Text blasts work out of the box **as app notifications**. To send them as actual
SMS, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER` (any
Twilio-compatible API works — point `TWILIO_API_BASE` at another provider if
needed), then restart. The Text Messages screen says which mode is active, and
what each send cost. The per-segment price used for the estimate lives in
**Settings → Text messaging**.

## Tech

- **Backend:** Node.js + Express, SQLite (`node:sqlite`), Server-Sent Events for realtime, `web-push` (VAPID) for phone notifications, `pdf-lib` for embedding signatures into uploaded PDFs.
- **Frontend:** dependency-free vanilla JS single-page app, mobile-first, PWA (service worker + manifest, offline shell caching).
- **Auth:** PIN-based sign-in with per-IP rate limiting, HMAC-signed session cookies. Admin/member roles; members can only punch at an admin-armed kiosk.

## Project layout

```
server.js          # Express app + all API routes
src/db.js          # SQLite schema & connection
src/auth.js        # sessions, password hashing, auth middleware
src/push.js        # web-push / VAPID key management
src/events.js      # SSE realtime hub
public/            # the PWA (index.html, app.js, styles.css, sw.js, manifest, icons)
data/              # created at runtime: SQLite db, secrets, VAPID keys, uploaded and signed documents (git-ignored)
```
