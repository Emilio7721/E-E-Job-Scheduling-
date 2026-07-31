# E&E Job Scheduling

A Connecteam-style workforce app for E&E: **job scheduling**, **venues**, **team chat**, and **push notifications that reach your phone** — installable on iPhone and Android as an app (PWA).

## Features

- **📅 Job scheduling** — week-view schedule; admins create jobs with a title, venue, start/end time, notes, and assigned team members. Employees see their jobs and **accept or decline** with one tap (admins are notified of the response).
- **📍 Venues** — manage your venue list (name, address, notes, color). Jobs link to venues, and addresses open directly in Google Maps.
- **💬 Team chat** — a company-wide **General** channel, admin-created group channels, and 1-on-1 direct messages. Messages arrive in real time, with unread badges and last-message previews.
- **⏱️ Time clock** — one-tap clock in/out, optionally linked to the day's job, with **GPS location recorded at punch time** (when the employee allows it). Employees see their weekly hours at a glance.
- **🧾 Timesheets & hours export** — admins review everyone's punches per week, edit or delete entries, approve them, and **export an hours CSV** with per-punch hours, job, venue and mileage plus per-person totals.
- **📄 Documents & e-signatures** — admins upload a PDF (handbook, waiver, policy); the team reads it on their phone and signs with a typed name plus a drawn signature. Admins can **place signature, date and printed-name fields anywhere on the document** — tap the page where each stamp belongs — and every signer's handwriting is burned into those exact spots, with an audit signature page appended as well. Admins get a **Signed Documents** screen showing who has and hasn't signed, with per-person and bulk downloads.
- **📢 Updates feed** — company announcements posted by admins, pushed to every phone, with likes.
- **🔔 Notifications on your phone** — real web push notifications (banner + lock screen) for job assignments, schedule changes, cancellations, chat messages, tasks, time-off decisions, new forms, and announcements — even when the app is closed. Plus an in-app notification feed.
- **🔑 PIN sign-in** — no passwords: new team members sign up with their **name and phone number** and get a unique **5-digit PIN** used to sign in and clock in. The **first account created becomes the admin**.
- **🔢 Kiosk mode** — an admin PIN locks any device into a full-screen punch clock (it stays locked across restarts until an admin PIN is entered again). Members clock in/out **only at the kiosk**, in person; admins can also punch from their own phone.
- **👥 Team** — everyone who signs up appears in the team list; admins manage roles, hourly rates, and PINs.
- **📱 Installable app** — add it to your home screen and it runs full-screen with its own icon, like a native app.

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
