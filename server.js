const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { db, UPLOAD_DIR, newPin } = require('./src/db');
const {
  hashPassword, verifyPassword, issueToken, verifyToken, tokenFromReq,
  requireAuth, requireAdmin,
} = require('./src/auth');
const push = require('./src/push');
const events = require('./src/events');

const app = express();
app.use(express.json({ limit: '20mb' })); // uploaded documents and signature PNGs arrive as base64

const PORT = process.env.PORT || 3000;
const COOKIE_OPTS = 'Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000';

// Basic brute-force protection for PIN endpoints: 15 attempts / 5 min / IP.
const pinAttempts = new Map();
function tooManyAttempts(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
  const now = Date.now();
  const a = pinAttempts.get(ip) || { n: 0, ts: now };
  if (now - a.ts > 5 * 60 * 1000) { a.n = 0; a.ts = now; }
  a.n++;
  pinAttempts.set(ip, a);
  return a.n > 15;
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, color: u.color };
}

function setAuthCookie(res, userId) {
  res.setHeader('Set-Cookie', `ee_token=${issueToken(userId)}; ${COOKIE_OPTS}`);
}

// What each person can choose to receive on their phone. The in-app activity
// feed always keeps the record; these only gate the push.
const NOTIF_CATEGORIES = {
  jobs: 'Job assignments and schedule changes',
  reminders: 'Reminder an hour before a job starts',
  chat: 'Chat messages',
  announcements: 'Company updates',
  documents: 'Documents to read and sign',
  texts: 'Text messages sent to the whole team',
  hours: 'Hours and time-off decisions',
  admin: 'Admin alerts (responses, requests, signatures)',
};

function notifPrefs(userId) {
  const row = db.prepare('SELECT notif_prefs FROM users WHERE id = ?').get(userId);
  const prefs = Object.fromEntries(Object.keys(NOTIF_CATEGORIES).map((k) => [k, true]));
  if (row?.notif_prefs) {
    try { Object.assign(prefs, JSON.parse(row.notif_prefs)); } catch { /* fall back to defaults */ }
  }
  return prefs;
}

function wantsPush(userId, category) {
  if (!category) return true;
  return notifPrefs(userId)[category] !== false;
}

function notify(userIds, { title, body = '', url = '/', category = 'jobs' }) {
  const insert = db.prepare('INSERT INTO notifications (user_id, title, body, url) VALUES (?, ?, ?, ?)');
  for (const userId of new Set(userIds)) {
    const info = insert.run(userId, title, body, url);
    events.sendTo(userId, 'notification', { id: Number(info.lastInsertRowid), title, body, url });
    if (wantsPush(userId, category)) push.pushToUser(userId, { title, body, url }).catch(() => {});
  }
}

/* ---------------------------------- auth ---------------------------------- */

app.post('/api/auth/register', (req, res) => {
  const { name, phone } = req.body || {};
  const digits = String(phone || '').replace(/\D/g, '');
  if (!name?.trim() || digits.length < 7 || digits.length > 15) {
    return res.status(400).json({ error: 'Your name and a valid phone number are required' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(digits)) {
    return res.status(409).json({ error: 'That number is already registered — sign in with your PIN' });
  }

  // First account becomes the admin/owner of the workspace.
  const isFirst = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  const colors = ['#a8862c', '#0ea5e9', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const pin = newPin();
  const info = db.prepare('INSERT INTO users (name, email, pass_hash, role, color, pin, phone) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name.trim(), `p${digits}@ee.local`, hashPassword(String(Math.random())), isFirst ? 'admin' : 'member', color, pin, digits);
  const userId = Number(info.lastInsertRowid);

  const general = db.prepare(`SELECT id FROM channels WHERE kind = 'group' AND name = 'General'`).get();
  db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(general.id, userId);
  const match = payrollMatchFor(userId, name.trim());

  setAuthCookie(res, userId);
  res.json({
    user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)),
    pin,
    payroll_match: match ? { display_name: match.display_name } : null,
  });
});

// Sign in with a 5-digit PIN.
app.post('/api/auth/login', (req, res) => {
  if (tooManyAttempts(req)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes' });
  const pin = String(req.body?.pin || '');
  const user = /^\d{5}$/.test(pin) ? db.prepare('SELECT * FROM users WHERE pin = ?').get(pin) : null;
  if (!user) return res.status(401).json({ error: 'PIN not recognized' });
  setAuthCookie(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'ee_token=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me/notification-prefs', requireAuth, (req, res) => {
  res.json({ categories: NOTIF_CATEGORIES, prefs: notifPrefs(req.user.id) });
});

app.put('/api/me/notification-prefs', requireAuth, (req, res) => {
  const incoming = req.body?.prefs || {};
  const prefs = notifPrefs(req.user.id);
  for (const key of Object.keys(NOTIF_CATEGORIES)) {
    if (key in incoming) prefs[key] = !!incoming[key];
  }
  db.prepare('UPDATE users SET notif_prefs = ? WHERE id = ?').run(JSON.stringify(prefs), req.user.id);
  res.json({ prefs });
});

app.get('/api/me', requireAuth, (req, res) => {
  const { pin } = db.prepare('SELECT pin FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: { ...req.user, pin }, vapidPublicKey: push.publicKey });
});

/* ----------------------- payroll worker id matching ------------------------ */

// Paychex lists people as "Last, First Middle" while the app knows them as
// "First Last". Reduce both to the same key: first and last significant word,
// accent- and punctuation-free, so middle names and initials do not matter.
function nameKey(raw) {
  let text = String(raw || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (text.includes(',')) {
    const [last, rest] = text.split(',');
    text = `${rest || ''} ${last}`;
  }
  const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return '';
  return [words[0], words[words.length - 1]].sort().join('|');
}

// Called after a new signup: if payroll already listed this person, give them
// their Worker ID automatically.
// Looks up the payroll roster for a name without assigning anything — the new
// account confirms it is really them before the Worker ID is attached.
function payrollMatchFor(userId, name) {
  const key = nameKey(name);
  if (!key) return null;
  const row = db.prepare('SELECT display_name, worker_id FROM worker_id_roster WHERE name_key = ?').get(key);
  if (!row) return null;
  const taken = db.prepare('SELECT id FROM users WHERE worker_id = ? AND id != ?').get(row.worker_id, userId);
  if (taken) return null;
  return row;
}

// The signed-in user accepts (or rejects) the payroll record we matched them to.
app.post('/api/me/payroll-match', requireAuth, (req, res) => {
  const me = db.prepare('SELECT id, name, worker_id FROM users WHERE id = ?').get(req.user.id);
  if (me.worker_id) return res.json({ ok: true, worker_id: me.worker_id });
  if (!req.body?.confirm) return res.json({ ok: true, worker_id: null });
  const match = payrollMatchFor(me.id, me.name);
  if (!match) return res.status(404).json({ error: 'No payroll record matches your name' });
  db.prepare('UPDATE users SET worker_id = ? WHERE id = ?').run(match.worker_id, me.id);
  events.broadcast('users', {});
  res.json({ ok: true, worker_id: match.worker_id });
});

// Bulk import of a payroll roster: assigns Worker IDs to matching team members
// and remembers the rest for whoever signs up later.
app.post('/api/users/worker-ids/import', requireAuth, requireAdmin, (req, res) => {
  const rows = Array.isArray(req.body?.entries) ? req.body.entries : null;
  if (!rows) return res.status(400).json({ error: 'Nothing to import' });
  if (rows.length > 2000) return res.status(400).json({ error: 'That list is too long' });

  const users = db.prepare('SELECT id, name, worker_id FROM users').all();
  const byKey = new Map();
  for (const u of users) {
    const key = nameKey(u.name);
    if (!key) continue;
    if (byKey.has(key)) byKey.get(key).push(u); else byKey.set(key, [u]);
  }

  const remember = db.prepare(`
    INSERT INTO worker_id_roster (name_key, display_name, worker_id) VALUES (?, ?, ?)
    ON CONFLICT(name_key) DO UPDATE SET display_name = excluded.display_name, worker_id = excluded.worker_id
  `);
  const assign = db.prepare('UPDATE users SET worker_id = ? WHERE id = ?');

  const assigned = [];
  const pending = [];
  const ambiguous = [];
  const skipped = [];
  const seenIds = new Set(users.filter((u) => u.worker_id).map((u) => u.worker_id));

  for (const row of rows) {
    const name = String(row?.name || '').trim();
    const workerId = String(row?.worker_id || '').trim();
    if (!name || !/^[a-z0-9]{1,10}$/i.test(workerId)) {
      skipped.push({ name, worker_id: workerId, reason: 'invalid' });
      continue;
    }
    const key = nameKey(name);
    if (!key) { skipped.push({ name, worker_id: workerId, reason: 'invalid' }); continue; }
    remember.run(key, name, workerId);

    const matches = byKey.get(key) || [];
    if (matches.length > 1) { ambiguous.push({ name, worker_id: workerId }); continue; }
    if (!matches.length) { pending.push({ name, worker_id: workerId }); continue; }

    const user = matches[0];
    if (user.worker_id === workerId) { assigned.push({ name: user.name, worker_id: workerId }); continue; }
    if (seenIds.has(workerId) && user.worker_id !== workerId) {
      skipped.push({ name, worker_id: workerId, reason: 'already used by someone else' });
      continue;
    }
    assign.run(workerId, user.id);
    seenIds.add(workerId);
    assigned.push({ name: user.name, worker_id: workerId });
  }

  events.broadcast('users', {});
  res.json({
    assigned, pending, ambiguous, skipped,
    counts: {
      assigned: assigned.length, pending: pending.length,
      ambiguous: ambiguous.length, skipped: skipped.length,
    },
  });
});

/* -------------------------------- settings --------------------------------- */

const SETTING_DEFAULTS = {
  // Monday of the first pay period; every period runs 14 days from here.
  period_anchor: '2026-01-05',
  // The number text blasts are sent from. Blank falls back to TWILIO_FROM_NUMBER.
  sms_from_number: '',
  // What the carrier charges per 160-character segment, used for the estimate.
  sms_price: '0.0079',
};

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...SETTING_DEFAULTS };
  for (const r of rows) if (r.key in out) out[r.key] = r.value;
  return out;
}

app.get('/api/settings', requireAuth, (req, res) => {
  res.json({ settings: getSettings() });
});

app.put('/api/settings', requireAuth, requireAdmin, (req, res) => {
  const body = req.body || {};
  const save = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    if (!(key in body)) continue;
    let value = String(body[key] ?? '').trim();
    if (key === 'period_anchor' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return res.status(400).json({ error: 'Pay period start must be a date' });
    }
    if (key === 'sms_from_number' && value && !/^\+?[\d\s()\-.]{7,20}$/.test(value)) {
      return res.status(400).json({ error: 'That sending number does not look like a phone number' });
    }
    if (key === 'sms_price' && value && !(Number(value) >= 0)) {
      return res.status(400).json({ error: 'Price per message must be a number' });
    }
    save.run(key, value);
  }
  events.broadcast('settings', {});
  res.json({ settings: getSettings() });
});

/* ---------------------------------- team ---------------------------------- */

app.get('/api/users', requireAuth, (req, res) => {
  const cols = req.user.role === 'admin'
    ? 'id, name, email, phone, role, position_id, color, pin, worker_id'
    : 'id, name, email, phone, role, position_id, color';
  const users = db.prepare(`SELECT ${cols} FROM users ORDER BY name`).all();
  if (req.user.role === 'admin') {
    const countSubs = db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?');
    for (const u of users) u.devices = countSubs.get(u.id).n;
  }
  res.json({ users });
});

app.patch('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found' });
  const { role = target.role, position_id, worker_id } = req.body || {};
  if (worker_id !== undefined) {
    const wid = String(worker_id || '').trim();
    if (wid && !/^[a-z0-9]{1,10}$/i.test(wid)) {
      return res.status(400).json({ error: 'Worker ID must be up to 10 letters or numbers' });
    }
    const clash = wid ? db.prepare('SELECT id FROM users WHERE worker_id = ? AND id != ?').get(wid, target.id) : null;
    if (clash) return res.status(409).json({ error: 'Another team member already has that Worker ID' });
    db.prepare('UPDATE users SET worker_id = ? WHERE id = ?').run(wid || null, target.id);
  }
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

  // A position with admin permission makes the person an admin.
  const newPositionId = position_id === undefined ? target.position_id : (Number(position_id) || null);
  let newRole = role;
  if (newPositionId) {
    const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(newPositionId);
    if (!position) return res.status(400).json({ error: 'Unknown position' });
    newRole = position.is_admin ? 'admin' : 'member';
  }
  if (newRole !== target.role && target.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot change your own admin access' });
  }
  if (target.role === 'admin' && newRole === 'member') {
    const admins = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?`).get(target.id).n;
    if (!admins) return res.status(400).json({ error: 'There must be at least one admin' });
  }
  db.prepare('UPDATE users SET role = ?, position_id = ? WHERE id = ?')
    .run(newRole, newPositionId, target.id);
  let pin;
  if (req.body?.new_pin) {
    pin = newPin();
    db.prepare('UPDATE users SET pin = ? WHERE id = ?').run(pin, target.id);
  }
  res.json({ ok: true, pin });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot remove yourself' });
  if (target.role === 'admin') {
    const admins = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?`).get(target.id).n;
    if (!admins) return res.status(400).json({ error: 'There must be at least one admin' });
  }
  // Time entries and hour requests cascade with the user; the timesheet history
  // for a removed person goes with them.
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  events.broadcast('users', {});
  events.broadcast('shifts', {});
  res.json({ ok: true });
});

/* --------------------------------- venues --------------------------------- */

app.get('/api/venues', requireAuth, (req, res) => {
  res.json({ venues: db.prepare('SELECT * FROM venues WHERE archived = 0 ORDER BY name').all() });
});

app.post('/api/venues', requireAuth, requireAdmin, (req, res) => {
  const { name, address = '', notes = '', color = '#0ea5e9' } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Venue name is required' });
  const info = db.prepare('INSERT INTO venues (name, address, notes, color) VALUES (?, ?, ?, ?)')
    .run(name.trim(), address.trim(), notes.trim(), color);
  events.broadcast('venues', {});
  res.json({ venue: db.prepare('SELECT * FROM venues WHERE id = ?').get(Number(info.lastInsertRowid)) });
});

app.patch('/api/venues/:id', requireAuth, requireAdmin, (req, res) => {
  const venue = db.prepare('SELECT * FROM venues WHERE id = ?').get(Number(req.params.id));
  if (!venue) return res.status(404).json({ error: 'Venue not found' });
  const { name = venue.name, address = venue.address, notes = venue.notes, color = venue.color } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Venue name is required' });
  db.prepare('UPDATE venues SET name = ?, address = ?, notes = ?, color = ? WHERE id = ?')
    .run(name.trim(), address.trim(), notes.trim(), color, venue.id);
  events.broadcast('venues', {});
  res.json({ ok: true });
});

app.delete('/api/venues/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE venues SET archived = 1 WHERE id = ?').run(Number(req.params.id));
  events.broadcast('venues', {});
  res.json({ ok: true });
});

/* ------------------------------- availability ------------------------------- */

const TZ = process.env.APP_TZ || 'America/New_York';

// A shift is stored in UTC but unavailability is a local wall-clock thing, so
// convert to the company's timezone before comparing.
function localParts(iso) {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-CA', { timeZone: TZ });
  const [h, m] = d.toLocaleTimeString('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).split(':').map(Number);
  return { date, min: h * 60 + m };
}

// Every local day a shift touches, with the minute range it occupies that day.
function shiftDaySlices(startsAt, endsAt) {
  const start = localParts(startsAt);
  const end = localParts(endsAt);
  if (start.date === end.date) return [{ date: start.date, from: start.min, to: Math.max(end.min, start.min + 1) }];
  const slices = [{ date: start.date, from: start.min, to: 1440 }];
  const cursor = new Date(`${start.date}T12:00:00`);
  for (;;) {
    cursor.setDate(cursor.getDate() + 1);
    const date = cursor.toLocaleDateString('en-CA');
    if (date >= end.date) break;
    slices.push({ date, from: 0, to: 1440 });
    if (slices.length > 14) break;
  }
  slices.push({ date: end.date, from: 0, to: Math.max(end.min, 1) });
  return slices;
}

// Returns a list of human-readable clashes for the given people.
function conflictsFor(userIds, startsAt, endsAt, ignoreShiftId = null) {
  const out = [];
  const slices = shiftDaySlices(startsAt, endsAt);

  for (const userId of userIds) {
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    if (!user) continue;

    // Already working somewhere else at the same time?
    const clash = db.prepare(`
      SELECT s.title, s.starts_at, v.name AS venue_name
      FROM shifts s
      JOIN shift_assignees a ON a.shift_id = s.id
      LEFT JOIN venues v ON v.id = s.venue_id
      WHERE a.user_id = ? AND a.status != 'declined'
        AND s.id != COALESCE(?, -1)
        AND s.starts_at < ? AND s.ends_at > ?
      LIMIT 1
    `).get(userId, ignoreShiftId, endsAt, startsAt);
    if (clash) {
      out.push({
        user_id: userId, kind: 'shift',
        message: `${user.name} is already on "${clash.title}"${clash.venue_name ? ` at ${clash.venue_name}` : ''} at that time`,
      });
      continue;
    }

    // Marked unavailable for any part of it?
    for (const slice of slices) {
      const block = db.prepare(`
        SELECT all_day, start_min, end_min FROM unavailability
        WHERE user_id = ? AND date = ?
          AND (all_day = 1 OR (start_min < ? AND end_min > ?))
        LIMIT 1
      `).get(userId, slice.date, slice.to, slice.from);
      if (block) {
        out.push({
          user_id: userId, kind: 'unavailable',
          message: `${user.name} marked themselves unavailable on ${slice.date}${block.all_day ? ' (all day)' : ''}`,
        });
        break;
      }
    }
  }
  return out;
}

app.get('/api/availability', requireAuth, (req, res) => {
  const { from, to, user_id } = req.query;
  let sql = `
    SELECT u.*, usr.name AS user_name, usr.color AS user_color
    FROM unavailability u JOIN users usr ON usr.id = u.user_id
    WHERE 1=1`;
  const params = [];
  if (req.user.role === 'admin' && user_id) { sql += ' AND u.user_id = ?'; params.push(Number(user_id)); }
  else if (req.user.role !== 'admin') { sql += ' AND u.user_id = ?'; params.push(req.user.id); }
  if (from) { sql += ' AND u.date >= ?'; params.push(from); }
  if (to) { sql += ' AND u.date <= ?'; params.push(to); }
  sql += ' ORDER BY u.date, u.start_min LIMIT 500';
  res.json({ unavailability: db.prepare(sql).all(...params) });
});

app.post('/api/availability', requireAuth, (req, res) => {
  const {
    date, all_day = false, start_min = 540, end_min = 1020,
    note = '', repeat_weeks = 0,
  } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'Pick a date' });
  const from = all_day ? 0 : Math.max(0, Math.min(1439, Number(start_min) || 0));
  const to = all_day ? 1440 : Math.max(1, Math.min(1440, Number(end_min) || 0));
  if (!all_day && to <= from) return res.status(400).json({ error: 'End time must be after the start time' });

  const weeks = Math.max(1, Math.min(52, Number(repeat_weeks) || 1));
  const seriesId = weeks > 1 ? crypto.randomUUID() : null;
  const insert = db.prepare(
    'INSERT INTO unavailability (user_id, date, all_day, start_min, end_min, note, series_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  const created = [];
  const cursor = new Date(`${date}T12:00:00`);
  for (let i = 0; i < weeks; i++) {
    const day = cursor.toLocaleDateString('en-CA');
    const info = insert.run(req.user.id, day, all_day ? 1 : 0, from, to, String(note).slice(0, 300), seriesId);
    created.push(Number(info.lastInsertRowid));
    cursor.setDate(cursor.getDate() + 7);
  }

  events.broadcast('availability', {});
  res.json({ ok: true, created: created.length });
});

app.delete('/api/availability/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM unavailability WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
  if (req.query.series === '1' && row.series_id) {
    db.prepare('DELETE FROM unavailability WHERE series_id = ? AND date >= ?').run(row.series_id, row.date);
  } else {
    db.prepare('DELETE FROM unavailability WHERE id = ?').run(row.id);
  }
  events.broadcast('availability', {});
  res.json({ ok: true });
});

/* --------------------------------- shifts --------------------------------- */

const SHIFT_QUERY = `
  SELECT s.*, v.name AS venue_name, v.address AS venue_address, v.color AS venue_color,
         r.name AS role_name, a.name AS attire_name, a.color AS attire_color,
         a.description AS attire_description
  FROM shifts s
  LEFT JOIN venues v ON v.id = s.venue_id
  LEFT JOIN roles r ON r.id = s.role_id
  LEFT JOIN attire a ON a.id = s.attire_id
`;

function shiftWithAssignees(shift) {
  const assignees = db.prepare(`
    SELECT u.id, u.name, u.color, a.status
    FROM shift_assignees a JOIN users u ON u.id = a.user_id
    WHERE a.shift_id = ? ORDER BY u.name
  `).all(shift.id);
  return { ...shift, assignees };
}

app.get('/api/shifts', requireAuth, (req, res) => {
  const { from, to, mine } = req.query;
  let sql = SHIFT_QUERY + ' WHERE 1=1';
  const params = [];
  if (from) { sql += ' AND s.ends_at >= ?'; params.push(from); }
  if (to) { sql += ' AND s.starts_at < ?'; params.push(to); }
  if (mine === '1') {
    sql += ' AND s.id IN (SELECT shift_id FROM shift_assignees WHERE user_id = ?)';
    params.push(req.user.id);
  }
  sql += ' ORDER BY s.starts_at';
  const shifts = db.prepare(sql).all(...params).map(shiftWithAssignees);
  res.json({ shifts });
});

app.get('/api/shifts/:id/changes', requireAuth, (req, res) => {
  const changes = db.prepare(`
    SELECT c.summary, c.created_at, u.name AS user_name
    FROM shift_changes c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.shift_id = ? ORDER BY c.id DESC LIMIT 50
  `).all(Number(req.params.id));
  res.json({ changes });
});

// Lets the schedule form warn before anyone tries to save a clashing job.
app.post('/api/shifts/check-conflicts', requireAuth, requireAdmin, (req, res) => {
  const { assignee_ids = [], starts_at, ends_at, shift_id = null } = req.body || {};
  if (!starts_at || !ends_at) return res.json({ conflicts: [] });
  res.json({ conflicts: conflictsFor(assignee_ids, starts_at, ends_at, shift_id) });
});

function fmtShiftTime(iso) {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: process.env.APP_TZ || 'America/New_York',
  });
}

app.post('/api/shifts', requireAuth, requireAdmin, (req, res) => {
  const { title, venue_id = null, role_id = null, attire_id = null, starts_at, ends_at, notes = '', assignee_ids = [] } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Job title is required' });
  if (!starts_at || !ends_at || new Date(ends_at) <= new Date(starts_at)) {
    return res.status(400).json({ error: 'Valid start and end times are required' });
  }
  const clashes = conflictsFor(assignee_ids, starts_at, ends_at);
  if (clashes.length) return res.status(409).json({ error: 'Scheduling conflict', conflicts: clashes });

  const info = db.prepare('INSERT INTO shifts (title, venue_id, role_id, attire_id, starts_at, ends_at, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(title.trim(), venue_id, role_id, attire_id, starts_at, ends_at, notes.trim(), req.user.id);
  const shiftId = Number(info.lastInsertRowid);
  const addAssignee = db.prepare('INSERT OR IGNORE INTO shift_assignees (shift_id, user_id) VALUES (?, ?)');
  for (const uid of assignee_ids) addAssignee.run(shiftId, uid);

  const shift = shiftWithAssignees(db.prepare(SHIFT_QUERY + ' WHERE s.id = ?').get(shiftId));
  events.broadcast('shifts', {});
  notify(assignee_ids.filter((id) => id !== req.user.id), {
    title: `New job: ${shift.title}`,
    body: `${fmtShiftTime(shift.starts_at)}${shift.venue_name ? ' @ ' + shift.venue_name : ''}`,
    url: '/#/schedule',
    category: 'jobs',
  });
  res.json({ shift });
});

app.patch('/api/shifts/:id', requireAuth, requireAdmin, (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(req.params.id));
  if (!shift) return res.status(404).json({ error: 'Job not found' });
  const {
    title = shift.title, venue_id = shift.venue_id, role_id = shift.role_id,
    attire_id = shift.attire_id,
    starts_at = shift.starts_at, ends_at = shift.ends_at, notes = shift.notes, assignee_ids,
  } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Job title is required' });
  if (new Date(ends_at) <= new Date(starts_at)) return res.status(400).json({ error: 'End time must be after start time' });

  // Only re-check people who are newly added, or everyone if the time moved.
  const beforeRows = db.prepare('SELECT user_id, status FROM shift_assignees WHERE shift_id = ?').all(shift.id);
  const before = beforeRows.map((r) => r.user_id);
  const timeMoved = starts_at !== shift.starts_at || ends_at !== shift.ends_at;
  const nextAssignees = Array.isArray(assignee_ids) ? assignee_ids : before;
  const toCheck = timeMoved ? nextAssignees : nextAssignees.filter((id) => !before.includes(id));
  const clashes = conflictsFor(toCheck, starts_at, ends_at, shift.id);
  if (clashes.length) return res.status(409).json({ error: 'Scheduling conflict', conflicts: clashes });

  db.prepare(`UPDATE shifts SET title = ?, venue_id = ?, role_id = ?, attire_id = ?, starts_at = ?, ends_at = ?, notes = ?,
      reminded_at = CASE WHEN starts_at != ? THEN NULL ELSE reminded_at END,
      updated_at = datetime('now') WHERE id = ?`)
    .run(title.trim(), venue_id, role_id, attire_id, starts_at, ends_at, notes.trim(), starts_at, shift.id);

  let added = [];
  let removed = [];
  if (Array.isArray(assignee_ids)) {
    added = assignee_ids.filter((id) => !before.includes(id));
    removed = before.filter((id) => !assignee_ids.includes(id));
    // Touch only the rows that actually changed, so everyone who stays on the
    // job keeps the answer they already gave.
    const dropAssignee = db.prepare('DELETE FROM shift_assignees WHERE shift_id = ? AND user_id = ?');
    for (const uid of removed) dropAssignee.run(shift.id, uid);
    const addAssignee = db.prepare('INSERT OR IGNORE INTO shift_assignees (shift_id, user_id) VALUES (?, ?)');
    for (const uid of added) addAssignee.run(shift.id, uid);
  }

  const after = db.prepare(SHIFT_QUERY + ' WHERE s.id = ?').get(shift.id);

  // Editing the notes, title, job or attire is just extra detail on a job people
  // already said yes to — only moving when or where it happens is a different
  // commitment, so that is the one case where we ask them to confirm again.
  const needsReconfirm = timeMoved || shift.venue_id !== after.venue_id;
  const reconfirming = needsReconfirm
    ? beforeRows.filter((r) => r.status === 'accepted' && !removed.includes(r.user_id)).map((r) => r.user_id)
    : [];
  if (reconfirming.length) {
    const reset = db.prepare(`UPDATE shift_assignees SET status = 'pending' WHERE shift_id = ? AND user_id = ?`);
    for (const uid of reconfirming) reset.run(shift.id, uid);
  }

  const updated = shiftWithAssignees(after);

  // Keep a plain-language history so staff can see what an admin changed.
  const history = [];
  if (shift.title !== updated.title) history.push(`Title changed to "${updated.title}"`);
  if (timeMoved) history.push(`Time changed to ${fmtShiftTime(updated.starts_at)} – ${fmtShiftTime(updated.ends_at)}`);
  if (shift.venue_id !== updated.venue_id) history.push(`Venue changed to ${updated.venue_name || 'none'}`);
  if (shift.role_id !== updated.role_id) history.push(`Job changed to ${updated.role_name || 'none'}`);
  if (shift.attire_id !== updated.attire_id) history.push(`Attire changed to ${updated.attire_name || 'none'}`);
  if (shift.notes !== updated.notes) history.push('Notes updated');
  const nameOf = (id) => db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name || 'someone';
  for (const id of added) history.push(`${nameOf(id)} added to the job`);
  for (const id of removed) history.push(`${nameOf(id)} removed from the job`);
  if (reconfirming.length) {
    history.push(reconfirming.length === 1
      ? `${nameOf(reconfirming[0])} was asked to confirm the new time or venue`
      : `${reconfirming.length} people were asked to confirm the new time or venue`);
  }
  const logChange = db.prepare('INSERT INTO shift_changes (shift_id, user_id, summary) VALUES (?, ?, ?)');
  for (const line of history) logChange.run(shift.id, req.user.id, line);

  events.broadcast('shifts', {});
  const kept = Array.isArray(assignee_ids) ? assignee_ids.filter((id) => before.includes(id)) : before;

  // People already on the job only hear about it when something really changed.
  const changes = [];
  if (shift.title !== updated.title) changes.push('title');
  if (shift.starts_at !== updated.starts_at || shift.ends_at !== updated.ends_at) changes.push('time');
  if (shift.venue_id !== updated.venue_id) changes.push('venue');
  if (shift.role_id !== updated.role_id) changes.push('job');
  if (shift.attire_id !== updated.attire_id) changes.push('attire');
  if (shift.notes !== updated.notes) changes.push('notes');

  notify(added.filter((id) => id !== req.user.id), {
    title: `New job: ${updated.title}`,
    body: `${fmtShiftTime(updated.starts_at)}${updated.venue_name ? ' @ ' + updated.venue_name : ''}`,
    url: '/#/schedule',
    category: 'jobs',
  });
  if (changes.length) {
    // People who have to answer again get told why; everyone else just gets the news.
    const reask = kept.filter((id) => reconfirming.includes(id) && id !== req.user.id);
    const fyi = kept.filter((id) => !reconfirming.includes(id) && id !== req.user.id);
    const when = `${fmtShiftTime(updated.starts_at)}${updated.venue_name ? ' @ ' + updated.venue_name : ''}`;
    notify(reask, {
      title: `Please confirm again: ${updated.title}`,
      body: `The ${changes.includes('time') ? 'time' : 'venue'} changed — ${when}`,
      url: '/#/schedule',
      category: 'jobs',
    });
    notify(fyi, {
      title: `Job updated (${changes.join(', ')}): ${updated.title}`,
      body: `${when} — you are still on this job`,
      url: '/#/schedule',
      category: 'jobs',
    });
  }
  notify(removed.filter((id) => id !== req.user.id), {
    title: `You were taken off: ${updated.title}`,
    body: fmtShiftTime(updated.starts_at),
    url: '/#/schedule',
    category: 'jobs',
  });
  res.json({ shift: updated });
});

app.delete('/api/shifts/:id', requireAuth, requireAdmin, (req, res) => {
  const shift = db.prepare(SHIFT_QUERY + ' WHERE s.id = ?').get(Number(req.params.id));
  if (!shift) return res.status(404).json({ error: 'Job not found' });
  const assignees = db.prepare('SELECT user_id FROM shift_assignees WHERE shift_id = ?').all(shift.id).map((r) => r.user_id);
  db.prepare('DELETE FROM shifts WHERE id = ?').run(shift.id);
  events.broadcast('shifts', {});
  notify(assignees.filter((id) => id !== req.user.id), {
    title: `Job cancelled: ${shift.title}`,
    body: fmtShiftTime(shift.starts_at),
    url: '/#/schedule',
    category: 'jobs',
  });
  res.json({ ok: true });
});

app.post('/api/shifts/:id/respond', requireAuth, (req, res) => {
  const { status } = req.body || {};
  if (!['accepted', 'declined'].includes(status)) return res.status(400).json({ error: 'Invalid response' });
  const shiftId = Number(req.params.id);
  const row = db.prepare('SELECT 1 FROM shift_assignees WHERE shift_id = ? AND user_id = ?').get(shiftId, req.user.id);
  if (!row) return res.status(404).json({ error: 'You are not assigned to this job' });
  db.prepare('UPDATE shift_assignees SET status = ? WHERE shift_id = ? AND user_id = ?').run(status, shiftId, req.user.id);

  const shift = db.prepare(SHIFT_QUERY + ' WHERE s.id = ?').get(shiftId);
  events.broadcast('shifts', {});
  const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all().map((r) => r.id);
  notify(admins.filter((id) => id !== req.user.id), {
    title: `${req.user.name} ${status} a job`,
    body: `${shift.title} — ${fmtShiftTime(shift.starts_at)}`,
    url: '/#/schedule',
    category: 'admin',
  });
  res.json({ ok: true });
});

/* ---------------------------------- chat ----------------------------------- */

function channelSummary(channel, userId) {
  const lastMsg = db.prepare(`
    SELECT m.body, m.created_at, u.name AS user_name
    FROM messages m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT 1
  `).get(channel.id);
  const member = db.prepare('SELECT last_read_at FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, userId);
  const unread = member ? db.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND created_at > ? AND user_id != ?'
  ).get(channel.id, member.last_read_at, userId).n : 0;

  let name = channel.name;
  if (channel.kind === 'dm') {
    const other = db.prepare(`
      SELECT u.name FROM channel_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.channel_id = ? AND cm.user_id != ?
    `).get(channel.id, userId);
    name = other ? other.name : 'Direct message';
  }
  return { id: channel.id, name, kind: channel.kind, last_message: lastMsg || null, unread };
}

app.get('/api/channels', requireAuth, (req, res) => {
  const channels = db.prepare(`
    SELECT c.* FROM channels c JOIN channel_members cm ON cm.channel_id = c.id
    WHERE cm.user_id = ?
  `).all(req.user.id).map((c) => channelSummary(c, req.user.id));
  channels.sort((a, b) => {
    const ta = a.last_message?.created_at || '';
    const tb = b.last_message?.created_at || '';
    return tb.localeCompare(ta);
  });
  res.json({ channels });
});

app.post('/api/channels', requireAuth, requireAdmin, (req, res) => {
  const { name, member_ids = [] } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Channel name is required' });
  const info = db.prepare(`INSERT INTO channels (name, kind) VALUES (?, 'group')`).run(name.trim());
  const channelId = Number(info.lastInsertRowid);
  const addMember = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
  addMember.run(channelId, req.user.id);
  for (const uid of member_ids) addMember.run(channelId, uid);
  events.sendToMany([req.user.id, ...member_ids], 'channels', {});
  res.json({ channel: channelSummary(db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId), req.user.id) });
});

// Open (or create) a DM with another user.
app.post('/api/channels/dm', requireAuth, (req, res) => {
  const otherId = Number(req.body?.user_id);
  const other = db.prepare('SELECT id, name FROM users WHERE id = ?').get(otherId);
  if (!other || other.id === req.user.id) return res.status(400).json({ error: 'Invalid user' });
  const dmKey = [req.user.id, other.id].sort((a, b) => a - b).join(':');
  let channel = db.prepare('SELECT * FROM channels WHERE dm_key = ?').get(dmKey);
  if (!channel) {
    const info = db.prepare(`INSERT INTO channels (name, kind, dm_key) VALUES ('', 'dm', ?)`).run(dmKey);
    channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(info.lastInsertRowid));
    const addMember = db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)');
    addMember.run(channel.id, req.user.id);
    addMember.run(channel.id, other.id);
  }
  res.json({ channel: channelSummary(channel, req.user.id) });
});

function requireMembership(req, res, next) {
  const channelId = Number(req.params.id);
  const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, req.user.id);
  if (!member) return res.status(403).json({ error: 'Not a member of this channel' });
  req.channelId = channelId;
  next();
}

app.get('/api/channels/:id/messages', requireAuth, requireMembership, (req, res) => {
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const messages = db.prepare(`
    SELECT m.id, m.body, m.created_at, m.user_id, u.name AS user_name, u.color AS user_color
    FROM messages m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT 50
  `).all(req.channelId, before).reverse();
  db.prepare(`UPDATE channel_members SET last_read_at = datetime('now') WHERE channel_id = ? AND user_id = ?`)
    .run(req.channelId, req.user.id);
  res.json({ messages });
});

app.post('/api/channels/:id/messages', requireAuth, requireMembership, (req, res) => {
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message cannot be empty' });
  if (body.length > 4000) return res.status(400).json({ error: 'Message too long' });
  const info = db.prepare('INSERT INTO messages (channel_id, user_id, body) VALUES (?, ?, ?)')
    .run(req.channelId, req.user.id, body);
  db.prepare(`UPDATE channel_members SET last_read_at = datetime('now') WHERE channel_id = ? AND user_id = ?`)
    .run(req.channelId, req.user.id);

  const message = db.prepare(`
    SELECT m.id, m.body, m.created_at, m.user_id, u.name AS user_name, u.color AS user_color
    FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?
  `).get(Number(info.lastInsertRowid));

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.channelId);
  const members = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(req.channelId).map((r) => r.user_id);
  events.sendToMany(members, 'message', { channel_id: req.channelId, message });

  // Push-notify everyone except the sender; people with the app open also get
  // the SSE event, but the phone banner is the point when the app is closed.
  const pushTitle = channel.kind === 'dm' ? req.user.name : `${req.user.name} in ${channel.name}`;
  for (const uid of members) {
    if (uid === req.user.id) continue;
    if (!wantsPush(uid, 'chat')) continue;
    push.pushToUser(uid, {
      title: pushTitle,
      body: body.length > 120 ? body.slice(0, 117) + '…' : body,
      url: `/#/chat/${req.channelId}`,
      tag: `chat-${req.channelId}`,
    }).catch(() => {});
  }
  res.json({ message });
});

/* ------------------------------ notifications ------------------------------ */

app.get('/api/notifications', requireAuth, (req, res) => {
  const notifications = db.prepare(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50'
  ).all(req.user.id);
  res.json({ notifications });
});

app.post('/api/notifications/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

app.delete('/api/notifications/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

app.delete('/api/notifications', requireAuth, (req, res) => {
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

/* ---------------------------------- push ----------------------------------- */

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'Invalid subscription' });
  db.prepare(`
    INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
  `).run(req.user.id, endpoint, keys.p256dh, keys.auth);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
  res.json({ ok: true });
});

app.post('/api/push/test/:userId', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT id, name FROM users WHERE id = ?').get(Number(req.params.userId));
  if (!target) return res.status(404).json({ error: 'User not found' });
  const devices = db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get(target.id).n;
  if (!devices) return res.status(400).json({ error: `${target.name} has no device signed up for notifications yet` });
  notify([target.id], {
    title: 'Test notification',
    body: `Sent by ${req.user.name} — notifications are working on this device 🎉`,
    url: '/#/notifications',
  });
  res.json({ ok: true, devices });
});

app.post('/api/push/test', requireAuth, (req, res) => {
  push.pushToUser(req.user.id, {
    title: 'E&E Scheduling',
    body: 'Push notifications are working on this device 🎉',
    url: '/#/settings',
  }).catch(() => {});
  res.json({ ok: true });
});

/* ------------------------------ shift reminders ----------------------------- */

// Everyone still on a job hears about it an hour before it starts. The sweep
// runs every minute and stamps reminded_at so a job is only ever announced once
// (moving the start time clears the stamp and re-arms it).
const REMINDER_LEAD_MS = 60 * 60 * 1000;

function sendShiftReminders() {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const horizon = new Date(now + REMINDER_LEAD_MS).toISOString();
  const due = db.prepare(
    SHIFT_QUERY + ' WHERE s.reminded_at IS NULL AND s.starts_at > ? AND s.starts_at <= ?'
  ).all(nowIso, horizon);

  for (const shift of due) {
    const assignees = db.prepare(
      `SELECT user_id FROM shift_assignees WHERE shift_id = ? AND status != 'declined'`
    ).all(shift.id).map((r) => r.user_id);
    if (assignees.length) {
      const mins = Math.max(1, Math.round((new Date(shift.starts_at) - now) / 60000));
      notify(assignees, {
        title: `Starts ${mins >= 55 ? 'in 1 hour' : `in ${mins} min`}: ${shift.title}`,
        body: `${fmtShiftTime(shift.starts_at)}${shift.venue_name ? ' @ ' + shift.venue_name : ''}${shift.role_name ? ' · ' + shift.role_name : ''}`,
        url: '/#/schedule',
        category: 'reminders',
      });
    }
    db.prepare('UPDATE shifts SET reminded_at = ? WHERE id = ?').run(nowIso, shift.id);
  }
}

setInterval(sendShiftReminders, 60 * 1000);
sendShiftReminders();

/* --------------------------------- realtime -------------------------------- */

app.get('/api/events', (req, res) => {
  const userId = verifyToken(tokenFromReq(req));
  if (!userId) return res.status(401).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('event: hello\ndata: {}\n\n');
  events.addClient(userId, res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => clearInterval(heartbeat));
});

/* -------------------------------- time clock -------------------------------- */

/* California meal periods and overtime — fixed by law, deliberately not
   configurable. Labor Code §512: a workday of more than five hours owes one
   unpaid 30-minute meal period, and a workday of more than ten hours owes a
   second. Meal periods are unpaid and are not hours worked, so overtime is
   figured on the paid time that remains. §510: over 8 hours in a workday pays
   1.5x and over 12 pays 2x; over 40 straight-time hours in a workweek pays
   1.5x; the seventh consecutive day of a workweek pays 1.5x for the first
   eight hours and 2x beyond that. */
const HOUR_MS = 3600000;
const CA_MEAL_MS = 30 * 60000;
const CA_RULE = {
  firstMealAfterMs: 5 * HOUR_MS,
  secondMealAfterMs: 10 * HOUR_MS,
  mealMs: CA_MEAL_MS,
  dailyOtAfterMs: 8 * HOUR_MS,
  dailyDoubleAfterMs: 12 * HOUR_MS,
  weeklyOtAfterMs: 40 * HOUR_MS,
};

function caMealMs(workedMs) {
  if (workedMs > CA_RULE.secondMealAfterMs) return 2 * CA_MEAL_MS;
  if (workedMs > CA_RULE.firstMealAfterMs) return CA_MEAL_MS;
  return 0;
}

// Buckets finished entries by { user, local day } with worked/break/paid time.
function summariseDays(entries) {
  const days = new Map();
  for (const e of entries) {
    if (!e.clock_out) continue;
    const date = localParts(e.clock_in).date;
    const key = `${e.user_id}|${date}`;
    const day = days.get(key) || { user_id: e.user_id, user_name: e.user_name, date, workedMs: 0, entries: [] };
    day.workedMs += new Date(e.clock_out) - new Date(e.clock_in);
    day.entries.push(e);
    days.set(key, day);
  }
  for (const day of days.values()) {
    day.breakMs = caMealMs(day.workedMs);
    day.paidMs = Math.max(0, day.workedMs - day.breakMs);
  }
  return days;
}

// The Monday that starts the workweek a local date falls in.
function weekStart(date) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toLocaleDateString('en-CA');
}

// Splits a person's days into regular / 1.5x / 2x under the California rules
// above. Days must be for one person; order does not matter.
function caOvertime(days) {
  const byWeek = new Map();
  for (const day of days) {
    const week = weekStart(day.date);
    if (!byWeek.has(week)) byWeek.set(week, []);
    byWeek.get(week).push(day);
  }
  const total = { regularMs: 0, ot15Ms: 0, ot20Ms: 0 };
  for (const week of byWeek.values()) {
    week.sort((a, b) => a.date.localeCompare(b.date));
    // A seventh consecutive worked day only exists if all seven were worked.
    const seventh = week.length === 7 ? week[6].date : null;
    let regularMs = 0;
    for (const day of week) {
      const paid = day.paidMs;
      if (day.date === seventh) {
        total.ot15Ms += Math.min(paid, CA_RULE.dailyOtAfterMs);
        total.ot20Ms += Math.max(0, paid - CA_RULE.dailyOtAfterMs);
        continue;
      }
      total.ot20Ms += Math.max(0, paid - CA_RULE.dailyDoubleAfterMs);
      total.ot15Ms += Math.max(0, Math.min(paid, CA_RULE.dailyDoubleAfterMs) - CA_RULE.dailyOtAfterMs);
      regularMs += Math.min(paid, CA_RULE.dailyOtAfterMs);
    }
    // Straight-time hours past 40 in the week move to 1.5x.
    const overWeek = Math.max(0, regularMs - CA_RULE.weeklyOtAfterMs);
    total.ot15Ms += overWeek;
    total.regularMs += regularMs - overWeek;
  }
  return total;
}

const TIME_ENTRY_QUERY = `
  SELECT t.*, u.name AS user_name, u.color AS user_color,
         s.title AS shift_title, v.name AS venue_name, r.name AS role_name
  FROM time_entries t
  JOIN users u ON u.id = t.user_id
  LEFT JOIN shifts s ON s.id = t.shift_id
  LEFT JOIN venues v ON v.id = t.venue_id
  LEFT JOIN roles r ON r.id = t.role_id
`;

app.get('/api/time/status', requireAuth, (req, res) => {
  const entry = db.prepare(TIME_ENTRY_QUERY + ' WHERE t.user_id = ? AND t.clock_out IS NULL').get(req.user.id);
  res.json({ entry: entry || null });
});

function checkPin(req, res) {
  const { pin } = db.prepare('SELECT pin FROM users WHERE id = ?').get(req.user.id);
  if (String(req.body?.pin || '') !== pin) {
    res.status(403).json({ error: 'Incorrect PIN' });
    return false;
  }
  return true;
}

app.post('/api/time/clock-in', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Please clock in at the kiosk' });
  if (!checkPin(req, res)) return;
  const open = db.prepare('SELECT id FROM time_entries WHERE user_id = ? AND clock_out IS NULL').get(req.user.id);
  if (open) return res.status(400).json({ error: 'You are already clocked in' });
  const { lat = null, lng = null, shift_id = null, venue_id = null, role_id = null, note = '' } = req.body || {};
  const info = db.prepare(
    'INSERT INTO time_entries (user_id, shift_id, venue_id, role_id, clock_in, in_lat, in_lng, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, shift_id || null, venue_id || null, role_id || null, new Date().toISOString(), lat, lng, String(note).slice(0, 500));
  events.broadcast('time', {});
  res.json({ entry: db.prepare(TIME_ENTRY_QUERY + ' WHERE t.id = ?').get(Number(info.lastInsertRowid)) });
});

app.post('/api/time/clock-out', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Please clock out at the kiosk' });
  if (!checkPin(req, res)) return;
  const open = db.prepare('SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NULL').get(req.user.id);
  if (!open) return res.status(400).json({ error: 'You are not clocked in' });
  const { lat = null, lng = null, venue_id, role_id, mileage, note } = req.body || {};
  db.prepare(`UPDATE time_entries SET clock_out = ?, out_lat = ?, out_lng = ?,
      venue_id = COALESCE(?, venue_id), role_id = COALESCE(?, role_id),
      mileage = COALESCE(?, mileage),
      note = CASE WHEN ? != '' THEN ? ELSE note END
    WHERE id = ?`)
    .run(new Date().toISOString(), lat, lng, venue_id || null, role_id || null,
      mileage != null ? Math.max(0, Number(mileage) || 0) : null,
      String(note || '').slice(0, 500), String(note || '').slice(0, 500), open.id);
  events.broadcast('time', {});
  res.json({ entry: db.prepare(TIME_ENTRY_QUERY + ' WHERE t.id = ?').get(open.id) });
});

// Members see their own entries; admins see everyone's (optionally one user).
app.get('/api/time/entries', requireAuth, (req, res) => {
  const { from, to, user_id } = req.query;
  let sql = TIME_ENTRY_QUERY + ' WHERE 1=1';
  const params = [];
  if (req.user.role !== 'admin') { sql += ' AND t.user_id = ?'; params.push(req.user.id); }
  else if (user_id) { sql += ' AND t.user_id = ?'; params.push(Number(user_id)); }
  if (from) { sql += ' AND t.clock_in >= ?'; params.push(from); }
  if (to) { sql += ' AND t.clock_in < ?'; params.push(to); }
  sql += ' ORDER BY t.clock_in DESC LIMIT 500';
  const entries = db.prepare(sql).all(...params);
  const days = [...summariseDays(entries).values()].map(({ entries: _drop, ...rest }) => rest);
  res.json({ entries, days, breaks: CA_RULE });
});

app.patch('/api/time/entries/:id', requireAuth, requireAdmin, (req, res) => {
  const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(Number(req.params.id));
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  const {
    clock_in = entry.clock_in, clock_out = entry.clock_out, approved = entry.approved,
    venue_id = entry.venue_id, role_id = entry.role_id,
    mileage = entry.mileage, note = entry.note,
  } = req.body || {};
  if (clock_out && new Date(clock_out) <= new Date(clock_in)) {
    return res.status(400).json({ error: 'Clock-out must be after clock-in' });
  }
  if (approved && !clock_out) {
    return res.status(400).json({ error: 'Add a clock-out time before approving' });
  }
  db.prepare(`UPDATE time_entries SET clock_in = ?, clock_out = ?, approved = ?,
      venue_id = ?, role_id = ?, mileage = ?, note = ? WHERE id = ?`)
    .run(clock_in, clock_out, approved ? 1 : 0, venue_id || null, role_id || null,
      Math.max(0, Number(mileage) || 0), String(note || '').slice(0, 500), entry.id);
  events.broadcast('time', {});
  res.json({ ok: true });
});

// Approve (or un-approve) every finished punch a person has in a period.
app.post('/api/time/approve', requireAuth, requireAdmin, (req, res) => {
  const { user_id, from, to, approved = true } = req.body || {};
  if (!user_id || !from || !to) return res.status(400).json({ error: 'user_id, from and to are required' });
  const info = db.prepare(`
    UPDATE time_entries SET approved = ?
    WHERE user_id = ? AND clock_in >= ? AND clock_in < ? AND clock_out IS NOT NULL
  `).run(approved ? 1 : 0, Number(user_id), from, to);
  events.broadcast('time', {});
  res.json({ ok: true, changed: info.changes });
});

app.delete('/api/time/entries/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM time_entries WHERE id = ?').run(Number(req.params.id));
  events.broadcast('time', {});
  res.json({ ok: true });
});

/* The timesheet overview, column for column as Connecteam exports it: every
   employee in first-name order, their punches newest first, with the day's
   automatic unpaid break and total on the first row of each day, the week's
   total on the first row of each workweek, and the period totals on the
   person's first row. Employees with no punches still get a name row. */
const TIMESHEET_COLUMNS = [
  'First name', 'Last name', 'Type', 'Sub-job', 'Start Date', 'In', 'Start - location',
  'End Date', 'Out', 'End - location', 'Employee notes', 'Manager notes', 'Shift hours',
  'Daily Automatic Unpaid Break Hours', 'Daily total hours', 'Daily total pay (USD)',
  'Weekly total hours', 'Total work hours', 'Total paid time off hours',
  'Total Unpaid Break Hours', 'Total Paid Hours', 'Total Regular', 'Total Overtime x1.5',
  'Total Overtime x2.0', 'Total overtime', 'Total pay', 'Total unpaid time off hours',
];

app.get('/api/time/timesheet.csv', requireAuth, requireAdmin, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'A pay period is required' });

  // The timesheet is a payroll record, so it is only ever produced once every
  // punch in the period has been reviewed — an unapproved or still-running
  // punch blocks the whole file rather than quietly dropping out of it.
  const open = db.prepare(
    'SELECT COUNT(*) AS n FROM time_entries WHERE clock_out IS NULL AND clock_in >= ? AND clock_in < ?'
  ).get(from, to).n;
  if (open) {
    return res.status(400).json({
      error: `${open} punch${open === 1 ? ' is' : 'es are'} still running in this pay period. Close ${open === 1 ? 'it' : 'them'} before downloading.`,
    });
  }
  const pending = db.prepare(
    'SELECT COUNT(*) AS n FROM time_entries WHERE approved = 0 AND clock_out IS NOT NULL AND clock_in >= ? AND clock_in < ?'
  ).get(from, to).n;
  if (pending) {
    return res.status(400).json({
      error: `${pending} punch${pending === 1 ? '' : 'es'} in this pay period ${pending === 1 ? 'has' : 'have'} not been approved yet. Approve everything first.`,
    });
  }

  const entries = db.prepare(
    TIME_ENTRY_QUERY + ' WHERE t.approved = 1 AND t.clock_out IS NOT NULL AND t.clock_in >= ? AND t.clock_in < ? ORDER BY t.clock_in DESC'
  ).all(from, to);
  const days = summariseDays(entries);
  const people = db.prepare('SELECT id, name FROM users').all();

  // "07/15/2026 Wed" and "05:30 PM", matching how the cells display in Excel.
  const dayCell = (iso) => {
    const d = new Date(iso);
    const md = d.toLocaleDateString('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    return `${md} ${d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' })}`;
  };
  const timeCell = (iso) => new Date(iso).toLocaleTimeString('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true,
  });
  const hrs = (ms) => (ms / HOUR_MS).toFixed(2);
  const hrsOrBlank = (ms) => (ms ? hrs(ms) : '');
  const place = (lat, lng) => (lat == null || lng == null ? '' : `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  const csvEsc = (v) => {
    const str = String(v ?? '');
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  // First name is the first word; everything after it is the last name.
  const splitName = (name) => {
    const [first, ...rest] = String(name || '').trim().split(/\s+/);
    return [first || '', rest.join(' ')];
  };

  const rows = [TIMESHEET_COLUMNS];
  const sorted = people
    .map((u) => ({ ...u, parts: splitName(u.name) }))
    .sort((a, b) => a.parts[0].localeCompare(b.parts[0]) || a.parts[1].localeCompare(b.parts[1]));

  for (const person of sorted) {
    const mine = entries.filter((e) => e.user_id === person.id);
    const myDays = [...days.values()].filter((d) => d.user_id === person.id);
    const [firstName, lastName] = person.parts;

    if (!mine.length) {
      rows.push([firstName, lastName, ...Array(TIMESHEET_COLUMNS.length - 2).fill('')]);
      continue;
    }

    const ot = caOvertime(myDays);
    const workedMs = myDays.reduce((n, d) => n + d.workedMs, 0);
    const breakMs = myDays.reduce((n, d) => n + d.breakMs, 0);
    const paidMs = myDays.reduce((n, d) => n + d.paidMs, 0);
    const weekMs = new Map();
    for (const d of myDays) weekMs.set(weekStart(d.date), (weekMs.get(weekStart(d.date)) || 0) + d.paidMs);

    const seenDay = new Set();
    const seenWeek = new Set();
    mine.forEach((e, i) => {
      const date = localParts(e.clock_in).date;
      const week = weekStart(date);
      const day = days.get(`${person.id}|${date}`);
      const firstOfDay = !seenDay.has(date);
      const firstOfWeek = !seenWeek.has(week);
      seenDay.add(date);
      seenWeek.add(week);
      const top = i === 0;
      rows.push([
        top ? firstName : '', top ? lastName : '',
        e.venue_name || '', e.role_name || '',
        dayCell(e.clock_in), timeCell(e.clock_in), place(e.in_lat, e.in_lng),
        dayCell(e.clock_out), timeCell(e.clock_out), place(e.out_lat, e.out_lng),
        e.note || '', '',
        hrs(new Date(e.clock_out) - new Date(e.clock_in)),
        firstOfDay ? hrsOrBlank(day.breakMs) : '',
        firstOfDay ? hrs(day.paidMs) : '',
        '', // Daily total pay — the app does not hold hourly rates
        firstOfWeek ? hrs(weekMs.get(week) || 0) : '',
        top ? hrs(workedMs) : '',
        '', // Total paid time off hours
        top ? hrsOrBlank(breakMs) : '',
        top ? hrs(paidMs) : '',
        top ? hrs(ot.regularMs) : '',
        top ? hrsOrBlank(ot.ot15Ms) : '',
        top ? hrsOrBlank(ot.ot20Ms) : '',
        top ? hrsOrBlank(ot.ot15Ms + ot.ot20Ms) : '',
        '', // Total pay — the app does not hold hourly rates
        '', // Total unpaid time off hours
      ]);
    });
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="timesheet-${from.slice(0, 10)}-${to.slice(0, 10)}.csv"`);
  res.send(rows.map((r) => r.map(csvEsc).join(',')).join('\r\n') + '\r\n');
});

/* ---------------------------------- forms ----------------------------------- */

const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'checkbox', 'select'];

function sanitizeFields(fields) {
  if (!Array.isArray(fields)) return null;
  const out = [];
  for (const f of fields.slice(0, 30)) {
    if (!f || typeof f.label !== 'string' || !f.label.trim()) return null;
    if (!FIELD_TYPES.includes(f.type)) return null;
    out.push({
      id: out.length + 1,
      label: f.label.trim().slice(0, 200),
      type: f.type,
      required: !!f.required,
      options: f.type === 'select' ? (Array.isArray(f.options) ? f.options.map(String).filter(Boolean).slice(0, 30) : []) : undefined,
    });
  }
  return out.length ? out : null;
}

app.get('/api/forms', requireAuth, (req, res) => {
  const headcount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const forms = db.prepare('SELECT * FROM forms WHERE archived = 0 ORDER BY id DESC').all()
    .map((f) => ({
      ...f,
      fields: JSON.parse(f.fields),
      my_submissions: db.prepare('SELECT COUNT(*) AS n FROM form_submissions WHERE form_id = ? AND user_id = ?').get(f.id, req.user.id).n,
      signed_count: db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM form_submissions WHERE form_id = ?').get(f.id).n,
      field_count: db.prepare('SELECT COUNT(*) AS n FROM signature_fields WHERE form_id = ?').get(f.id).n,
      headcount,
    }));
  res.json({ forms });
});

// Admins upload a PDF; the team signs that document as-is.
app.post('/api/forms', requireAuth, requireAdmin, async (req, res) => {
  const { title, description = '', file } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Document title is required' });
  if (!file?.data || typeof file.data !== 'string') return res.status(400).json({ error: 'Choose a PDF to upload' });

  const base64 = file.data.includes(',') ? file.data.split(',').pop() : file.data;
  let bytes;
  try { bytes = Buffer.from(base64, 'base64'); } catch { return res.status(400).json({ error: 'That file could not be read' }); }
  if (!bytes.length) return res.status(400).json({ error: 'That file is empty' });
  if (bytes.length > 12 * 1024 * 1024) return res.status(400).json({ error: 'PDFs must be under 12 MB' });
  if (bytes.subarray(0, 5).toString() !== '%PDF-') return res.status(400).json({ error: 'Only PDF documents can be uploaded' });

  let pages;
  try { pages = (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount(); }
  catch { return res.status(400).json({ error: 'That PDF could not be opened — try re-saving it' }); }

  const docPath = path.join(UPLOAD_DIR, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`);
  fs.writeFileSync(docPath, bytes);

  const info = db.prepare(
    'INSERT INTO forms (title, description, fields, require_signature, doc_name, doc_path, doc_pages, created_by) VALUES (?, ?, ?, 1, ?, ?, ?, ?)'
  ).run(title.trim(), String(description).trim(), '[]',
    String(file.name || 'document.pdf').slice(0, 200), docPath, pages, req.user.id);

  events.broadcast('forms', {});
  const members = db.prepare('SELECT id FROM users WHERE id != ?').all(req.user.id).map((r) => r.id);
  notify(members, {
    title: `New document to sign: ${title.trim()}`,
    body: 'Tap to read and sign it',
    url: '/#/forms',
    category: 'documents',
  });
  res.json({ form: db.prepare('SELECT * FROM forms WHERE id = ?').get(Number(info.lastInsertRowid)) });
});

const FIELD_KINDS = ['signature', 'date', 'name'];

// Where each stamp goes on the uploaded PDF. Coordinates arrive already
// converted to PDF points by the placement screen, so no rotation math here.
app.get('/api/forms/:id/fields', requireAuth, (req, res) => {
  const fields = db.prepare('SELECT id, page, kind, x, y, w, h FROM signature_fields WHERE form_id = ? ORDER BY id')
    .all(Number(req.params.id));
  res.json({ fields });
});

app.put('/api/forms/:id/fields', requireAuth, requireAdmin, (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ?').get(Number(req.params.id));
  if (!form) return res.status(404).json({ error: 'Document not found' });
  const incoming = Array.isArray(req.body?.fields) ? req.body.fields : null;
  if (!incoming) return res.status(400).json({ error: 'No fields supplied' });
  if (incoming.length > 60) return res.status(400).json({ error: 'That is too many fields for one document' });

  const clean = [];
  for (const f of incoming) {
    const page = Number(f.page);
    const [x, y, w, h] = [Number(f.x), Number(f.y), Number(f.w), Number(f.h)];
    if (!Number.isInteger(page) || page < 0 || page >= (form.doc_pages || 1)) {
      return res.status(400).json({ error: 'A field points at a page that does not exist' });
    }
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
      return res.status(400).json({ error: 'A field has an invalid position' });
    }
    if (!FIELD_KINDS.includes(f.kind)) return res.status(400).json({ error: 'Unknown field type' });
    clean.push({ page, kind: f.kind, x, y, w, h });
  }

  db.prepare('DELETE FROM signature_fields WHERE form_id = ?').run(form.id);
  const insert = db.prepare('INSERT INTO signature_fields (form_id, page, kind, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const f of clean) insert.run(form.id, f.page, f.kind, f.x, f.y, f.w, f.h);
  events.broadcast('forms', {});
  res.json({ ok: true, count: clean.length });
});

// The original document, for reading before signing.
app.get('/api/forms/:id/document', requireAuth, (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ?').get(Number(req.params.id));
  if (!form?.doc_path || !fs.existsSync(form.doc_path)) return res.status(404).json({ error: 'Document not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${(form.doc_name || 'document.pdf').replace(/[^\w.-]+/g, '_')}"`);
  fs.createReadStream(form.doc_path).pipe(res);
});

app.delete('/api/forms/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE forms SET archived = 1 WHERE id = ?').run(Number(req.params.id));
  events.broadcast('forms', {});
  res.json({ ok: true });
});

// Builds the signed copy: the original document with a signature page appended.
async function buildSignedPdf(form, { signerName, typedName, signature, signedAt, shortDate, docId, contact }) {
  const original = fs.readFileSync(form.doc_path);
  const pdf = await PDFDocument.load(original, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Stamp wherever the admin placed fields on the document itself.
  const placed = db.prepare('SELECT page, kind, x, y, w, h FROM signature_fields WHERE form_id = ? ORDER BY id').all(form.id);
  let sigImage = null;
  if (placed.some((f) => f.kind === 'signature') && signature) {
    try { sigImage = await pdf.embedPng(Buffer.from(signature.split(',').pop(), 'base64')); }
    catch { sigImage = null; }
  }
  for (const f of placed) {
    if (f.page >= pdf.getPageCount()) continue;
    const target = pdf.getPage(f.page);
    if (f.kind === 'signature') {
      if (!sigImage) continue;
      // Fit inside the box without distorting the handwriting.
      const scale = Math.min(f.w / sigImage.width, f.h / sigImage.height);
      const dw = sigImage.width * scale;
      const dh = sigImage.height * scale;
      target.drawImage(sigImage, { x: f.x + (f.w - dw) / 2, y: f.y + (f.h - dh) / 2, width: dw, height: dh });
    } else {
      const text = f.kind === 'date' ? shortDate : (typedName || signerName);
      const size = Math.min(12, Math.max(7, f.h * 0.62));
      target.drawText(text, { x: f.x + 2, y: f.y + (f.h - size) / 2 + 1, size, font, color: rgb(0, 0, 0) });
    }
  }

  const last = pdf.getPage(pdf.getPageCount() - 1);
  const { width, height } = last.getSize();
  const page = pdf.addPage([width, height]);
  const margin = 54;
  let y = height - margin;

  const line = (text, { size = 11, f = font, color = rgb(0, 0, 0), gap = 16 } = {}) => {
    page.drawText(text, { x: margin, y, size, font: f, color });
    y -= gap;
  };

  line('E&E Management', { size: 18, f: bold, gap: 14 });
  line('Event Services and More', { size: 9, color: rgb(0.4, 0.4, 0.4), gap: 26 });
  line('Signature Page', { size: 15, f: bold, gap: 20 });
  line(form.title, { size: 12, f: bold, gap: 14 });
  line(`Document: ${form.doc_name || 'document.pdf'}`, { size: 9, color: rgb(0.35, 0.35, 0.35), gap: 26 });

  page.drawLine({
    start: { x: margin, y }, end: { x: width - margin, y },
    thickness: 0.8, color: rgb(0.8, 0.8, 0.8),
  });
  y -= 30;

  line('Signed by', { size: 9, color: rgb(0.35, 0.35, 0.35), gap: 15 });
  line(signerName, { size: 13, f: bold, gap: 30 });

  if (signature) {
    try {
      const png = await pdf.embedPng(Buffer.from(signature.split(',').pop(), 'base64'));
      const w = 220;
      const h = (png.height / png.width) * w;
      page.drawImage(png, { x: margin, y: y - h + 10, width: w, height: h });
      y -= h + 6;
    } catch { /* a corrupt signature image must not block the document */ }
  }

  page.drawLine({
    start: { x: margin, y }, end: { x: margin + 240, y },
    thickness: 1, color: rgb(0.2, 0.2, 0.2),
  });
  y -= 16;
  line(typedName || signerName, { size: 11, gap: 18 });
  line(`Signed electronically on ${signedAt}`, { size: 9, color: rgb(0.35, 0.35, 0.35), gap: 13 });
  line(`Signer: ${signerName}${contact ? ' · ' + contact : ''}`, { size: 9, color: rgb(0.35, 0.35, 0.35), gap: 13 });
  line(`Document ID ${docId}`, { size: 9, color: rgb(0.35, 0.35, 0.35), gap: 13 });
  line('This electronic signature is the legal equivalent of a handwritten signature.', {
    size: 8, color: rgb(0.5, 0.5, 0.5), gap: 13,
  });

  return Buffer.from(await pdf.save());
}

app.post('/api/forms/:id/submit', requireAuth, async (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ? AND archived = 0').get(Number(req.params.id));
  if (!form) return res.status(404).json({ error: 'Document not found' });

  let { signature = null, signed_name = '' } = req.body || {};
  signed_name = String(signed_name).trim().slice(0, 120);
  if (!signed_name) return res.status(400).json({ error: 'Type your full name to sign' });
  if (typeof signature !== 'string' || !signature.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'Draw your signature to sign' });
  }
  if (signature.length > 400000) return res.status(400).json({ error: 'Signature image is too large' });

  const signedAtIso = new Date().toISOString();
  const info = db.prepare(
    'INSERT INTO form_submissions (form_id, user_id, answers, signature, signed_name, signed_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(form.id, req.user.id, '{}', signature, signed_name, signedAtIso);
  const submissionId = Number(info.lastInsertRowid);

  // Stamp the signature into a copy of the uploaded document and keep that
  // file — it is the artifact admins download later.
  if (form.doc_path && fs.existsSync(form.doc_path)) {
    try {
      const signedAt = new Date(signedAtIso).toLocaleString('en-US', {
        dateStyle: 'long', timeStyle: 'short', timeZone: process.env.APP_TZ || 'America/New_York',
      });
      const pdfBytes = await buildSignedPdf(form, {
        signerName: req.user.name,
        typedName: signed_name,
        signature,
        signedAt,
        shortDate: new Date(signedAtIso).toLocaleDateString('en-US', {
          month: 'numeric', day: 'numeric', year: 'numeric', timeZone: process.env.APP_TZ || 'America/New_York',
        }),
        docId: `${form.id}-${submissionId}`,
        contact: req.user.phone || '',
      });
      const outPath = path.join(UPLOAD_DIR, `signed-${form.id}-${submissionId}.pdf`);
      fs.writeFileSync(outPath, pdfBytes);
      db.prepare('UPDATE form_submissions SET signed_path = ? WHERE id = ?').run(outPath, submissionId);
    } catch (err) {
      console.error('signed pdf generation failed:', err.message);
    }
  }

  events.broadcast('forms', {});
  const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all().map((r) => r.id);
  notify(admins.filter((id) => id !== req.user.id), {
    title: `${req.user.name} signed "${form.title}"`,
    body: 'Tap to review or download the signed copy',
    url: '/#/signed',
  });
  res.json({ ok: true });
});

// Who has completed a form and who still owes it.
app.get('/api/forms/:id/status', requireAuth, requireAdmin, (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ?').get(Number(req.params.id));
  if (!form) return res.status(404).json({ error: 'Form not found' });
  const people = db.prepare(`
    SELECT u.id, u.name, u.color,
           s.id AS submission_id, s.signed_at, s.created_at
    FROM users u
    LEFT JOIN form_submissions s
      ON s.user_id = u.id
     AND s.id = (SELECT MAX(id) FROM form_submissions WHERE form_id = ? AND user_id = u.id)
    ORDER BY u.name
  `).all(form.id);
  res.json({ form: { ...form, fields: JSON.parse(form.fields) }, people });
});

app.get('/api/forms/:id/submissions', requireAuth, (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ?').get(Number(req.params.id));
  if (!form) return res.status(404).json({ error: 'Form not found' });
  let sql = `
    SELECT s.*, u.name AS user_name, u.color AS user_color
    FROM form_submissions s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.form_id = ?`;
  const params = [form.id];
  if (req.user.role !== 'admin') { sql += ' AND s.user_id = ?'; params.push(req.user.id); }
  sql += ' ORDER BY s.id DESC LIMIT 200';
  const submissions = db.prepare(sql).all(...params).map((s) => ({ ...s, answers: JSON.parse(s.answers) }));
  res.json({ form: { ...form, fields: JSON.parse(form.fields) }, submissions });
});

/* ---------------------------------- kiosk ----------------------------------- */

// Arm (or verify to disarm) kiosk mode: only an admin PIN unlocks it.
// On success the device's session becomes that admin's, so punches authorize.
app.post('/api/kiosk/arm', (req, res) => {
  if (tooManyAttempts(req)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes' });
  const pin = String(req.body?.pin || '');
  const user = /^\d{5}$/.test(pin)
    ? db.prepare(`SELECT * FROM users WHERE pin = ? AND role = 'admin'`).get(pin)
    : null;
  if (!user) return res.status(403).json({ error: 'Admin PIN required' });
  setAuthCookie(res, user.id);
  res.json({ ok: true, name: user.name });
});

// Look up a PIN at the kiosk: who it is, whether they're clocked in, and
// their scheduled job right now (used to prefill venue and sub-job).
app.post('/api/kiosk/status', requireAuth, requireAdmin, (req, res) => {
  const pin = String(req.body?.pin || '');
  if (!/^\d{5}$/.test(pin)) return res.status(400).json({ error: 'Enter a 5-digit PIN' });
  const user = db.prepare('SELECT id, name, role FROM users WHERE pin = ?').get(pin);
  if (!user) return res.status(404).json({ error: 'PIN not recognized' });
  const entry = db.prepare(TIME_ENTRY_QUERY + ' WHERE t.user_id = ? AND t.clock_out IS NULL').get(user.id) || null;
  const now = Date.now();
  const shift = db.prepare(`
    SELECT s.id, s.venue_id, s.role_id, v.name AS venue_name, r.name AS role_name
    FROM shifts s
    JOIN shift_assignees a ON a.shift_id = s.id
    LEFT JOIN venues v ON v.id = s.venue_id
    LEFT JOIN roles r ON r.id = s.role_id
    WHERE a.user_id = ? AND s.starts_at < ? AND s.ends_at > ?
    ORDER BY s.starts_at LIMIT 1
  `).get(user.id, new Date(now + 12 * 3600000).toISOString(), new Date(now - 12 * 3600000).toISOString()) || null;
  res.json({ user, entry, shift });
});

// A shared device (armed by an admin) where workers punch in/out by PIN.
app.post('/api/kiosk/punch', requireAuth, requireAdmin, (req, res) => {
  const pin = String(req.body?.pin || '');
  if (!/^\d{5}$/.test(pin)) return res.status(400).json({ error: 'Enter a 5-digit PIN' });
  const user = db.prepare('SELECT id, name FROM users WHERE pin = ?').get(pin);
  if (!user) return res.status(404).json({ error: 'PIN not recognized' });
  const { lat = null, lng = null, venue_id = null, role_id = null, shift_id = null, mileage = null, note = '' } = req.body || {};

  const open = db.prepare('SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NULL').get(user.id);
  const now = new Date().toISOString();
  let action;
  if (open) {
    db.prepare(`UPDATE time_entries SET clock_out = ?, out_lat = ?, out_lng = ?,
        venue_id = COALESCE(?, venue_id), role_id = COALESCE(?, role_id),
        mileage = COALESCE(?, mileage),
        note = CASE WHEN ? != '' THEN ? ELSE note END
      WHERE id = ?`)
      .run(now, lat, lng, venue_id || null, role_id || null,
        mileage != null ? Math.max(0, Number(mileage) || 0) : null,
        String(note || '').slice(0, 500), String(note || '').slice(0, 500), open.id);
    action = 'out';
  } else {
    db.prepare(`INSERT INTO time_entries (user_id, shift_id, venue_id, role_id, clock_in, in_lat, in_lng, note) VALUES (?, ?, ?, ?, ?, ?, ?, 'kiosk')`)
      .run(user.id, shift_id || null, venue_id || null, role_id || null, now, lat, lng);
    action = 'in';
  }
  events.broadcast('time', {});
  res.json({ name: user.name, action, at: now });
});

/* ---------------------------------- attire ---------------------------------- */

app.get('/api/attire', requireAuth, (req, res) => {
  const attire = db.prepare('SELECT id, name, description, color, photo_path IS NOT NULL AS has_photo FROM attire WHERE archived = 0 ORDER BY name').all();
  res.json({ attire });
});

app.post('/api/attire', requireAuth, requireAdmin, (req, res) => {
  const { name, description = '', color = '#a8862c', photo = null } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Attire name is required' });
  const photoPath = savedAttirePhoto(photo, res);
  if (photoPath === false) return;
  const info = db.prepare('INSERT INTO attire (name, description, color, photo_path) VALUES (?, ?, ?, ?)')
    .run(name.trim(), String(description).trim().slice(0, 500), color, photoPath);
  events.broadcast('attire', {});
  res.json({ attire: db.prepare('SELECT * FROM attire WHERE id = ?').get(Number(info.lastInsertRowid)) });
});

app.patch('/api/attire/:id', requireAuth, requireAdmin, (req, res) => {
  const item = db.prepare('SELECT * FROM attire WHERE id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Attire not found' });
  const { name = item.name, description = item.description, color = item.color, photo } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Attire name is required' });
  let photoPath = item.photo_path;
  if (photo !== undefined) {
    const saved = savedAttirePhoto(photo, res);
    if (saved === false) return;
    photoPath = saved;
  }
  db.prepare('UPDATE attire SET name = ?, description = ?, color = ?, photo_path = ? WHERE id = ?')
    .run(name.trim(), String(description).trim().slice(0, 500), color, photoPath, item.id);
  events.broadcast('attire', {});
  res.json({ ok: true });
});

app.delete('/api/attire/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE attire SET archived = 1 WHERE id = ?').run(Number(req.params.id));
  events.broadcast('attire', {});
  res.json({ ok: true });
});

app.get('/api/attire/:id/photo', requireAuth, (req, res) => {
  const item = db.prepare('SELECT photo_path FROM attire WHERE id = ?').get(Number(req.params.id));
  if (!item?.photo_path || !fs.existsSync(item.photo_path)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  fs.createReadStream(item.photo_path).pipe(res);
});

// Accepts a data-URL photo, returns the stored path, null to clear, or false
// after already sending an error response.
function savedAttirePhoto(photo, res) {
  if (!photo) return null;
  const base64 = String(photo).includes(',') ? String(photo).split(',').pop() : String(photo);
  let bytes;
  try { bytes = Buffer.from(base64, 'base64'); } catch { res.status(400).json({ error: 'That photo could not be read' }); return false; }
  if (bytes.length > 4 * 1024 * 1024) { res.status(400).json({ error: 'Photos must be under 4 MB' }); return false; }
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (!isJpeg && !isPng) { res.status(400).json({ error: 'Photos must be JPG or PNG' }); return false; }
  const out = path.join(UPLOAD_DIR, `attire-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  fs.writeFileSync(out, bytes);
  return out;
}

/* ---------------------------------- roles ----------------------------------- */

app.get('/api/roles', requireAuth, (req, res) => {
  res.json({ roles: db.prepare('SELECT * FROM roles WHERE archived = 0 ORDER BY name').all() });
});

app.post('/api/roles', requireAuth, requireAdmin, (req, res) => {
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Job name is required' });
  const info = db.prepare('INSERT INTO roles (name) VALUES (?)').run(name.trim());
  events.broadcast('roles', {});
  res.json({ role: db.prepare('SELECT * FROM roles WHERE id = ?').get(Number(info.lastInsertRowid)) });
});

app.patch('/api/roles/:id', requireAuth, requireAdmin, (req, res) => {
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Job name is required' });
  db.prepare('UPDATE roles SET name = ? WHERE id = ?').run(name.trim(), Number(req.params.id));
  events.broadcast('roles', {});
  res.json({ ok: true });
});

app.delete('/api/roles/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE roles SET archived = 1 WHERE id = ?').run(Number(req.params.id));
  events.broadcast('roles', {});
  res.json({ ok: true });
});

/* -------------------------------- positions --------------------------------- */
/* Team positions are separate from clock-out jobs; a position can grant admin. */

app.get('/api/positions', requireAuth, (req, res) => {
  res.json({ positions: db.prepare('SELECT * FROM positions WHERE archived = 0 ORDER BY name').all() });
});

app.post('/api/positions', requireAuth, requireAdmin, (req, res) => {
  const { name, is_admin = false } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Position name is required' });
  const info = db.prepare('INSERT INTO positions (name, is_admin) VALUES (?, ?)').run(name.trim(), is_admin ? 1 : 0);
  events.broadcast('positions', {});
  res.json({ position: db.prepare('SELECT * FROM positions WHERE id = ?').get(Number(info.lastInsertRowid)) });
});

// Copies the job list into positions so every job can be someone's main
// position. Idempotent and case-insensitive — jobs already covered are skipped,
// and imported positions land at member level like any hand-added one.
app.post('/api/positions/import-jobs', requireAuth, requireAdmin, (req, res) => {
  const jobs = db.prepare('SELECT name FROM roles WHERE archived = 0 ORDER BY name').all();
  const taken = new Set(
    db.prepare('SELECT name FROM positions WHERE archived = 0').all().map((p) => p.name.trim().toLowerCase())
  );
  const insert = db.prepare('INSERT INTO positions (name, is_admin) VALUES (?, 0)');
  let added = 0;
  for (const job of jobs) {
    const name = job.name.trim();
    if (!name || taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    insert.run(name);
    added += 1;
  }
  if (added) events.broadcast('positions', {});
  res.json({ added, positions: db.prepare('SELECT * FROM positions WHERE archived = 0 ORDER BY name').all() });
});

app.patch('/api/positions/:id', requireAuth, requireAdmin, (req, res) => {
  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(Number(req.params.id));
  if (!position) return res.status(404).json({ error: 'Position not found' });
  const { name = position.name, is_admin = position.is_admin } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Position name is required' });
  const adminFlag = is_admin ? 1 : 0;
  if (position.is_admin && !adminFlag) {
    // Removing admin permission demotes every holder — keep at least one admin.
    const remaining = db.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND (position_id IS NULL OR position_id != ?)`
    ).get(position.id).n;
    if (!remaining) return res.status(400).json({ error: 'This would leave no admins' });
  }
  db.prepare('UPDATE positions SET name = ?, is_admin = ? WHERE id = ?').run(name.trim(), adminFlag, position.id);
  db.prepare('UPDATE users SET role = ? WHERE position_id = ?').run(adminFlag ? 'admin' : 'member', position.id);
  events.broadcast('positions', {});
  res.json({ ok: true });
});

app.delete('/api/positions/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE positions SET archived = 1 WHERE id = ?').run(Number(req.params.id));
  db.prepare('UPDATE users SET position_id = NULL WHERE position_id = ?').run(Number(req.params.id));
  events.broadcast('positions', {});
  res.json({ ok: true });
});

/* -------------------------------- checklists -------------------------------- */
/* A checklist hangs off a venue, so every job there carries it, and the leads
   holding one of its positions fill it fresh each shift. */

const CHECK_FIELD_TYPES = new Set(['section', 'note', 'check', 'datetime', 'photo', 'scale', 'signature']);

// Field specs are authored client-side; keep only what we understand so a bad
// payload can't smuggle extra keys into the stored JSON.
function cleanFields(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const f of raw.slice(0, 200)) {
    const type = String(f?.type || '');
    if (!CHECK_FIELD_TYPES.has(type)) continue;
    const label = String(f?.label ?? '').trim().slice(0, 300);
    if (!label && type !== 'note') continue;
    out.push({
      id: String(f.id || `f${out.length + 1}-${crypto.randomBytes(3).toString('hex')}`).slice(0, 40),
      type,
      label,
      description: String(f?.description ?? '').trim().slice(0, 2000),
      // Section headers and notes have nothing to answer, so they are never required.
      required: type === 'section' || type === 'note' ? false : f?.required !== false,
    });
  }
  return out;
}

function cleanPositionIds(raw) {
  if (!Array.isArray(raw)) return [];
  const known = new Set(db.prepare('SELECT id FROM positions WHERE archived = 0').all().map((p) => p.id));
  return [...new Set(raw.map(Number).filter((n) => known.has(n)))];
}

function shapeChecklist(row) {
  return {
    ...row,
    fields: JSON.parse(row.fields || '[]'),
    positions: JSON.parse(row.positions || '[]'),
  };
}

// A member sees a checklist when their position is on its list; admins see all.
function canFillChecklist(user, list) {
  if (user.role === 'admin') return true;
  return !!user.position_id && list.positions.includes(user.position_id);
}

/* Checklists come back around every week, so submissions are read a workweek at
   a time — Monday to Sunday in company time, the same week the timesheet uses. */

// created_at comes from SQLite's datetime('now'): naive UTC, no zone marker.
// Pin the zone on before any date maths or it reads as local time.
function utcIso(stamp) {
  const s = String(stamp || '').trim();
  if (!s || s.includes('T')) return s;
  return `${s.replace(' ', 'T')}Z`;
}

function submissionWeek(stamp) {
  return weekStart(localParts(utcIso(stamp)).date);
}

function todayLocal() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

// The Sunday that closes a week that starts on `monday`.
function weekEnd(monday) {
  const d = new Date(`${monday}T12:00:00`);
  d.setDate(d.getDate() + 6);
  return d.toLocaleDateString('en-CA');
}

// Anything unparseable falls back to the week we are in now, so a hand-edited
// URL lands somewhere sensible rather than erroring.
function askedWeek(raw) {
  const s = String(raw || '');
  return weekStart(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : todayLocal());
}

// The seven local dates of a week, for the day-by-day breakdown.
function weekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${monday}T12:00:00`);
    d.setDate(d.getDate() + i);
    return d.toLocaleDateString('en-CA');
  });
}

function shapeSubmission(row) {
  return {
    ...row,
    week: submissionWeek(row.created_at),
    day: localParts(utcIso(row.created_at)).date,
    answers: JSON.parse(row.answers || '{}'),
    photos: Object.keys(JSON.parse(row.photos || '{}')), // paths stay server-side
  };
}

// A UTC window that certainly contains the local week, give or take a day at
// each end. SQL narrows the rows; the exact local-week test happens in JS.
function weekWindow(week) {
  const stamp = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const from = new Date(`${week}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${weekEnd(week)}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() + 2);
  return [stamp(from), stamp(to)];
}

const SUBMISSION_QUERY = `
  SELECT s.*, u.name AS user_name, u.color AS user_color,
         sh.title AS shift_title, sh.starts_at AS shift_starts_at
  FROM checklist_submissions s
  LEFT JOIN users u ON u.id = s.user_id
  LEFT JOIN shifts sh ON sh.id = s.shift_id
  WHERE s.checklist_id = ?
    AND datetime(s.created_at) >= ? AND datetime(s.created_at) < ?
  ORDER BY s.created_at DESC`;

// Rows for one checklist's local week, newest first.
function weekSubmissions(checklistId, week) {
  return db.prepare(SUBMISSION_QUERY).all(checklistId, ...weekWindow(week))
    .map(shapeSubmission).filter((s) => s.week === week);
}

const CHECKLIST_QUERY = `
  SELECT c.*, v.name AS venue_name,
         (SELECT COUNT(*) FROM checklist_submissions s WHERE s.checklist_id = c.id) AS submission_count
  FROM checklists c
  LEFT JOIN venues v ON v.id = c.venue_id
  WHERE c.archived = 0
  ORDER BY v.name, c.title`;

app.get('/api/checklists', requireAuth, (req, res) => {
  const all = db.prepare(CHECKLIST_QUERY).all().map(shapeChecklist);
  const visible = req.user.role === 'admin'
    ? all
    : all.filter((c) => c.published && canFillChecklist(req.user, c));
  res.json({ checklists: visible });
});

app.post('/api/checklists', requireAuth, requireAdmin, (req, res) => {
  const { title, venue_id = null, fields = [], positions = [], published = true } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Checklist title is required' });
  const venue = venue_id ? db.prepare('SELECT id FROM venues WHERE id = ?').get(Number(venue_id)) : null;
  if (venue_id && !venue) return res.status(400).json({ error: 'Unknown venue' });
  const info = db.prepare(
    'INSERT INTO checklists (title, venue_id, fields, positions, published, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    title.trim(), venue?.id ?? null,
    JSON.stringify(cleanFields(fields)), JSON.stringify(cleanPositionIds(positions)),
    published ? 1 : 0, req.user.id
  );
  events.broadcast('checklists', {});
  res.json({ checklist: shapeChecklist(db.prepare('SELECT * FROM checklists WHERE id = ?').get(Number(info.lastInsertRowid))) });
});

app.patch('/api/checklists/:id', requireAuth, requireAdmin, (req, res) => {
  const list = db.prepare('SELECT * FROM checklists WHERE id = ? AND archived = 0').get(Number(req.params.id));
  if (!list) return res.status(404).json({ error: 'Checklist not found' });
  const { title = list.title, venue_id, fields, positions, published } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Checklist title is required' });
  let venueId = list.venue_id;
  if (venue_id !== undefined) {
    venueId = venue_id ? Number(venue_id) : null;
    if (venueId && !db.prepare('SELECT 1 FROM venues WHERE id = ?').get(venueId)) {
      return res.status(400).json({ error: 'Unknown venue' });
    }
  }
  db.prepare('UPDATE checklists SET title = ?, venue_id = ?, fields = ?, positions = ?, published = ? WHERE id = ?').run(
    title.trim(),
    venueId,
    fields === undefined ? list.fields : JSON.stringify(cleanFields(fields)),
    positions === undefined ? list.positions : JSON.stringify(cleanPositionIds(positions)),
    published === undefined ? list.published : (published ? 1 : 0),
    list.id
  );
  events.broadcast('checklists', {});
  res.json({ checklist: shapeChecklist(db.prepare('SELECT * FROM checklists WHERE id = ?').get(list.id)) });
});

app.delete('/api/checklists/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE checklists SET archived = 1 WHERE id = ?').run(Number(req.params.id));
  events.broadcast('checklists', {});
  res.json({ ok: true });
});

// Everything due on one shift: the venue's published checklists, plus whether
// this person has already turned each one in for that shift.
app.get('/api/shifts/:id/checklists', requireAuth, (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(req.params.id));
  if (!shift) return res.status(404).json({ error: 'Job not found' });
  const lists = db.prepare(CHECKLIST_QUERY).all().map(shapeChecklist)
    .filter((c) => c.published && c.venue_id && c.venue_id === shift.venue_id)
    .filter((c) => canFillChecklist(req.user, c));
  const done = db.prepare(`
    SELECT s.checklist_id, s.id, s.created_at, u.name AS user_name
    FROM checklist_submissions s
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.shift_id = ?`).all(shift.id);
  res.json({
    checklists: lists.map((c) => ({
      ...c,
      submissions: done.filter((d) => d.checklist_id === c.id),
    })),
  });
});

// Every checklist alongside what came in during one week — the admin's Monday
// morning view of who filled what.
app.get('/api/checklists/weekly', requireAuth, requireAdmin, (req, res) => {
  const week = askedWeek(req.query.week);
  const lists = db.prepare(CHECKLIST_QUERY).all().map(shapeChecklist);
  res.json({
    week,
    week_end: weekEnd(week),
    days: weekDays(week),
    checklists: lists.map((c) => ({
      ...c,
      // The list view only counts them, so the answers stay behind.
      submissions: weekSubmissions(c.id, week).map(({ answers, photos, ...rest }) => rest),
    })),
  });
});

app.get('/api/checklists/:id/submissions', requireAuth, requireAdmin, (req, res) => {
  const list = db.prepare(
    'SELECT c.*, v.name AS venue_name FROM checklists c LEFT JOIN venues v ON v.id = c.venue_id WHERE c.id = ?'
  ).get(Number(req.params.id));
  if (!list) return res.status(404).json({ error: 'Checklist not found' });

  // Weeks that actually hold something — one cheap column over the whole
  // history — plus the current one, so the pager always has somewhere to land.
  const counts = new Map([[weekStart(todayLocal()), 0]]);
  for (const row of db.prepare('SELECT created_at FROM checklist_submissions WHERE checklist_id = ?').all(list.id)) {
    const wk = submissionWeek(row.created_at);
    counts.set(wk, (counts.get(wk) || 0) + 1);
  }
  const weeks = [...counts]
    .map(([wk, count]) => ({ week: wk, count }))
    .sort((a, b) => b.week.localeCompare(a.week));

  const week = req.query.week === undefined ? weeks[0].week : askedWeek(req.query.week);
  res.json({
    checklist: shapeChecklist(list),
    week,
    week_end: weekEnd(week),
    days: weekDays(week),
    weeks,
    submissions: weekSubmissions(list.id, week),
  });
});

app.post('/api/checklists/:id/submit', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM checklists WHERE id = ? AND archived = 0').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Checklist not found' });
  const list = shapeChecklist(row);
  if (!list.published) return res.status(400).json({ error: 'This checklist is not published yet' });
  if (!canFillChecklist(req.user, list)) return res.status(403).json({ error: 'This checklist is not assigned to your position' });

  const { shift_id = null, answers = {} } = req.body || {};
  let shiftId = null;
  if (shift_id) {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(shift_id));
    if (!shift) return res.status(400).json({ error: 'Unknown job' });
    if (shift.venue_id !== list.venue_id) return res.status(400).json({ error: 'That job is at a different venue' });
    shiftId = shift.id;
  }

  const clean = {};
  const photos = {};
  for (const field of list.fields) {
    if (field.type === 'section' || field.type === 'note') continue;
    const value = answers[field.id];
    const missing = value === undefined || value === null || value === '';
    if (missing) {
      if (field.required) return res.status(400).json({ error: `"${field.label}" still needs an answer` });
      continue;
    }
    if (field.type === 'check') {
      if (value !== 'yes' && value !== 'na') return res.status(400).json({ error: `"${field.label}" has an invalid answer` });
      clean[field.id] = value;
    } else if (field.type === 'scale') {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n) || n < 1 || n > 10) return res.status(400).json({ error: `"${field.label}" must be between 1 and 10` });
      clean[field.id] = n;
    } else if (field.type === 'datetime') {
      const when = new Date(value);
      if (Number.isNaN(when.getTime())) return res.status(400).json({ error: `"${field.label}" needs a valid date and time` });
      clean[field.id] = when.toISOString();
    } else if (field.type === 'signature') {
      clean[field.id] = String(value).slice(0, 400_000);
    } else if (field.type === 'photo') {
      const saved = savedChecklistPhoto(value, res);
      if (saved === false) return;
      if (saved) photos[field.id] = saved;
    }
  }

  const info = db.prepare(
    'INSERT INTO checklist_submissions (checklist_id, shift_id, user_id, answers, photos) VALUES (?, ?, ?, ?, ?)'
  ).run(list.id, shiftId, req.user.id, JSON.stringify(clean), JSON.stringify(photos));

  events.broadcast('checklists', {});
  res.json({ ok: true, submission_id: Number(info.lastInsertRowid) });
});

app.get('/api/checklists/submissions/:sid/photo/:fieldId', requireAuth, (req, res) => {
  const sub = db.prepare('SELECT * FROM checklist_submissions WHERE id = ?').get(Number(req.params.sid));
  if (!sub) return res.status(404).end();
  if (req.user.role !== 'admin' && sub.user_id !== req.user.id) return res.status(403).end();
  const stored = JSON.parse(sub.photos || '{}')[req.params.fieldId];
  if (!stored || !fs.existsSync(stored)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  fs.createReadStream(stored).pipe(res);
});

// Same data-URL handling as attire photos: returns a path, null when empty, or
// false once an error response has already gone out.
function savedChecklistPhoto(photo, res) {
  if (!photo) return null;
  const base64 = String(photo).includes(',') ? String(photo).split(',').pop() : String(photo);
  let bytes;
  try { bytes = Buffer.from(base64, 'base64'); } catch { res.status(400).json({ error: 'That photo could not be read' }); return false; }
  if (bytes.length > 4 * 1024 * 1024) { res.status(400).json({ error: 'Photos must be under 4 MB' }); return false; }
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (!isJpeg && !isPng) { res.status(400).json({ error: 'Photos must be JPG or PNG' }); return false; }
  const out = path.join(UPLOAD_DIR, `checklist-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  fs.writeFileSync(out, bytes);
  return out;
}

/* ---------------------------- the weekly PDF -------------------------------- */
/* One week of filled-in checklists as a paper record: every submission, every
   answer, with the photos and signatures that came with it. */

// The standard fonts are WinAnsi, so a stray emoji in a label would throw
// mid-render. Fold the punctuation people actually paste, drop the rest.
const PDF_SUBS = [
  [/[‘’‚‛]/g, "'"],  // curly single quotes
  [/[“”„]/g, '"'],   // curly double quotes
  [/[–—]/g, '-'],    // en and em dashes
  [/…/g, '...'],     // ellipsis
  [/[   ]/g, ' '],   // non-breaking and figure spaces
  [/[•·]/g, '-'],    // bullets
];
function pdfSafe(text) {
  let s = String(text ?? '');
  for (const [re, to] of PDF_SUBS) s = s.replace(re, to);
  return s.replace(/[^\x20-\x7E\xA1-\xFF]/g, '').trimEnd();
}

// pdf-lib draws a string as one line, so wrapping is ours to do.
function wrapText(text, font, size, width) {
  const lines = [];
  for (const para of pdfSafe(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
      // A single word wider than the column still has to break somewhere.
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

function fmtStamp(iso, opts) {
  return new Date(iso).toLocaleString('en-US', { timeZone: TZ, ...opts });
}

function fmtWeekRange(week) {
  const day = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  return `${day(week)} - ${day(weekEnd(week))}`;
}

async function buildChecklistWeekPdf(sections, { week, title }) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const [W, H] = [612, 792];
  const margin = 54;
  const colWidth = W - margin * 2;
  const grey = rgb(0.35, 0.35, 0.35);
  let page = null;
  let y = 0;

  const newPage = () => { page = pdf.addPage([W, H]); y = H - margin; };
  // Start a fresh page when what comes next would not fit above the footer.
  const room = (height) => { if (!page || y - height < margin + 22) newPage(); };

  const text = (body, { size = 11, f = font, color = rgb(0, 0, 0), gap = 15, indent = 0 } = {}) => {
    for (const line of wrapText(body, f, size, colWidth - indent)) {
      room(gap);
      page.drawText(line, { x: margin + indent, y: y - size, size, font: f, color });
      y -= gap;
    }
  };
  const rule = (color = rgb(0.85, 0.85, 0.85)) => {
    room(12);
    page.drawLine({ start: { x: margin, y }, end: { x: W - margin, y }, thickness: 0.8, color });
    y -= 12;
  };
  const gap = (h) => { y -= h; };

  newPage();
  text('E&E Management', { size: 18, f: bold, gap: 15 });
  text('Event Services and More', { size: 9, color: grey, gap: 24 });
  text(title, { size: 15, f: bold, gap: 19 });
  text(`Week of ${fmtWeekRange(week)}`, { size: 11, f: bold, gap: 15 });
  text(`Generated ${fmtStamp(new Date().toISOString(), { dateStyle: 'long', timeStyle: 'short' })}`,
    { size: 9, color: grey, gap: 20 });
  rule(rgb(0.7, 0.7, 0.7));

  const dayName = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });

  for (const section of sections) {
    gap(8);
    room(60);
    text(section.title, { size: 13, f: bold, gap: 16 });
    text(`Venue: ${section.venue || 'No venue'}  -  ${section.submissions.length} submitted this week`,
      { size: 9.5, color: grey, gap: 14 });

    // Day-by-day, so an empty Wednesday is as visible as a busy Friday.
    const byDay = weekDays(week).map((d) => {
      const n = section.submissions.filter((s) => s.day === d).length;
      return `${dayName(d)}: ${n || '-'}`;
    });
    text(byDay.join('   '), { size: 9, color: grey, gap: 16 });

    if (!section.submissions.length) {
      text('Nothing was submitted for this checklist during the week.', { size: 10, color: grey, gap: 16 });
      rule();
      continue;
    }

    const answerable = section.fields.filter((f) => f.type !== 'section' && f.type !== 'note');
    for (const sub of [...section.submissions].reverse()) {
      gap(6);
      room(70);
      text(`${sub.user_name || 'Someone'}  -  ${fmtStamp(utcIso(sub.created_at), { dateStyle: 'medium', timeStyle: 'short' })}`,
        { size: 11, f: bold, gap: 14 });
      if (sub.shift_title) text(`Job: ${sub.shift_title}`, { size: 9, color: grey, gap: 14 });

      for (const field of answerable) {
        const value = sub.answers[field.id];
        text(field.label, { size: 10, f: bold, gap: 13, indent: 12 });

        if (field.type === 'photo') {
          const image = await embedStoredImage(pdf, sub.photoPaths?.[field.id]);
          if (!image) { text('-- no photo --', { size: 10, color: grey, gap: 14, indent: 24 }); continue; }
          const w = Math.min(190, image.width);
          const h = (image.height / image.width) * w;
          room(h + 10);
          page.drawImage(image, { x: margin + 24, y: y - h, width: w, height: h });
          y -= h + 10;
          continue;
        }
        if (field.type === 'signature' && typeof value === 'string' && value.startsWith('data:image')) {
          const image = await embedDataUrl(pdf, value);
          if (image) {
            const w = Math.min(170, image.width);
            const h = (image.height / image.width) * w;
            room(h + 10);
            page.drawImage(image, { x: margin + 24, y: y - h, width: w, height: h });
            y -= h + 10;
            continue;
          }
        }
        text(answerText(field, value), { size: 10, gap: 14, indent: 24 });
      }
      rule();
    }
  }

  // Numbered once everything is laid out, so the total is known.
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawText(`Page ${i + 1} of ${pages.length}`, {
      x: margin, y: margin - 20, size: 8, font, color: rgb(0.55, 0.55, 0.55),
    });
  });

  return Buffer.from(await pdf.save());
}

function answerText(field, value) {
  if (value === undefined || value === null || value === '') return '-- not answered --';
  if (field.type === 'check') return value === 'yes' ? 'Yes' : 'Not Applicable';
  if (field.type === 'scale') return `${value} / 10`;
  if (field.type === 'datetime') return fmtStamp(value, { dateStyle: 'medium', timeStyle: 'short' });
  if (field.type === 'signature') return 'Signed';
  return String(value);
}

async function embedStoredImage(pdf, filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const bytes = fs.readFileSync(filePath);
    const isPng = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    return isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  } catch { return null; }
}

async function embedDataUrl(pdf, dataUrl) {
  try { return await pdf.embedPng(Buffer.from(String(dataUrl).split(',').pop(), 'base64')); }
  catch { return null; }
}

// One checklist's week, or every checklist's week when no id is given.
app.get('/api/checklists/weekly/pdf', requireAuth, requireAdmin, async (req, res) => {
  const week = askedWeek(req.query.week);
  const only = req.query.checklist ? Number(req.query.checklist) : null;
  const lists = db.prepare(CHECKLIST_QUERY).all().map(shapeChecklist)
    .filter((c) => !only || c.id === only);
  if (!lists.length) return res.status(404).json({ error: 'Checklist not found' });

  const sections = lists.map((list) => ({
    title: list.title,
    venue: list.venue_name,
    fields: list.fields,
    // The PDF embeds the photos, so it needs the paths shapeSubmission drops.
    submissions: db.prepare(SUBMISSION_QUERY).all(list.id, ...weekWindow(week))
      .map((row) => ({ ...shapeSubmission(row), photoPaths: JSON.parse(row.photos || '{}') }))
      .filter((s) => s.week === week),
  }));

  const title = only ? lists[0].title : 'Checklists - Weekly Record';
  try {
    const bytes = await buildChecklistWeekPdf(sections, { week, title });
    const slug = `${only ? lists[0].title : 'all-checklists'}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${slug || 'checklists'}-week-of-${week}.pdf"`);
    res.send(bytes);
  } catch (err) {
    console.error('checklist week pdf', err);
    res.status(500).json({ error: 'That PDF could not be built' });
  }
});

/* ------------------------------ knowledge base ------------------------------ */
/* The standing rules. An article with no positions is readable by everyone;
   otherwise only the positions listed — admins always see everything. */

function shapeArticle(row) {
  return { ...row, positions: JSON.parse(row.positions || '[]') };
}

function canReadArticle(user, article) {
  if (user.role === 'admin') return true;
  if (!article.published) return false;
  if (!article.positions.length) return true;
  return !!user.position_id && article.positions.includes(user.position_id);
}

const ARTICLE_QUERY = `
  SELECT a.*, u.name AS updated_by_name
  FROM knowledge_articles a
  LEFT JOIN users u ON u.id = a.updated_by
  WHERE a.archived = 0
  ORDER BY a.folder, a.title`;

app.get('/api/knowledge', requireAuth, (req, res) => {
  const articles = db.prepare(ARTICLE_QUERY).all().map(shapeArticle).filter((a) => canReadArticle(req.user, a));
  res.json({ articles });
});

app.post('/api/knowledge', requireAuth, requireAdmin, (req, res) => {
  const { title, folder = '', body = '', positions = [], published = true } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Give the article a title' });
  const info = db.prepare(
    'INSERT INTO knowledge_articles (folder, title, body, positions, published, updated_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    String(folder).trim().slice(0, 80), title.trim(), String(body).slice(0, 60_000),
    JSON.stringify(cleanPositionIds(positions)), published ? 1 : 0, req.user.id
  );
  events.broadcast('knowledge', {});
  res.json({ article: shapeArticle(db.prepare('SELECT * FROM knowledge_articles WHERE id = ?').get(Number(info.lastInsertRowid))) });
});

app.patch('/api/knowledge/:id', requireAuth, requireAdmin, (req, res) => {
  const article = db.prepare('SELECT * FROM knowledge_articles WHERE id = ? AND archived = 0').get(Number(req.params.id));
  if (!article) return res.status(404).json({ error: 'Article not found' });
  const { title = article.title, folder, body, positions, published } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Give the article a title' });
  db.prepare(`
    UPDATE knowledge_articles
    SET folder = ?, title = ?, body = ?, positions = ?, published = ?, updated_by = ?, updated_at = datetime('now')
    WHERE id = ?`).run(
    folder === undefined ? article.folder : String(folder).trim().slice(0, 80),
    title.trim(),
    body === undefined ? article.body : String(body).slice(0, 60_000),
    positions === undefined ? article.positions : JSON.stringify(cleanPositionIds(positions)),
    published === undefined ? article.published : (published ? 1 : 0),
    req.user.id,
    article.id
  );
  events.broadcast('knowledge', {});
  res.json({ article: shapeArticle(db.prepare('SELECT * FROM knowledge_articles WHERE id = ?').get(article.id)) });
});

app.delete('/api/knowledge/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE knowledge_articles SET archived = 1 WHERE id = ?').run(Number(req.params.id));
  events.broadcast('knowledge', {});
  res.json({ ok: true });
});

/* ------------------------------ hours requests ------------------------------ */

const HOUR_REQ_QUERY = `
  SELECT h.*, u.name AS user_name, u.color AS user_color,
         v.name AS venue_name, r.name AS role_name
  FROM hour_requests h
  JOIN users u ON u.id = h.user_id
  LEFT JOIN venues v ON v.id = h.venue_id
  LEFT JOIN roles r ON r.id = h.role_id
`;

app.get('/api/hour-requests', requireAuth, (req, res) => {
  const requests = req.user.role === 'admin'
    ? db.prepare(HOUR_REQ_QUERY + ' ORDER BY h.id DESC LIMIT 200').all()
    : db.prepare(HOUR_REQ_QUERY + ' WHERE h.user_id = ? ORDER BY h.id DESC LIMIT 200').all(req.user.id);
  res.json({ requests });
});

app.post('/api/hour-requests', requireAuth, (req, res) => {
  const { venue_id = null, role_id = null, starts_at, ends_at, note = '' } = req.body || {};
  if (!starts_at || !ends_at || new Date(ends_at) <= new Date(starts_at)) {
    return res.status(400).json({ error: 'Valid start and end times are required' });
  }
  const info = db.prepare(
    'INSERT INTO hour_requests (user_id, venue_id, role_id, starts_at, ends_at, note) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, venue_id || null, role_id || null, starts_at, ends_at, String(note).slice(0, 500));
  events.broadcast('hours', {});
  const request = db.prepare(HOUR_REQ_QUERY + ' WHERE h.id = ?').get(Number(info.lastInsertRowid));
  const hours = ((new Date(ends_at) - new Date(starts_at)) / 3600000).toFixed(1);
  const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all().map((r) => r.id);
  notify(admins.filter((id) => id !== req.user.id), {
    title: `Hours request from ${req.user.name}`,
    body: `${hours}h · ${fmtShiftTime(starts_at)}${request.venue_name ? ' @ ' + request.venue_name : ''}${request.role_name ? ' · ' + request.role_name : ''}`,
    url: '/#/hours',
    category: 'admin',
  });
  res.json({ request });
});

app.post('/api/hour-requests/:id/decide', requireAuth, requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!['approved', 'denied'].includes(status)) return res.status(400).json({ error: 'Invalid decision' });
  const request = db.prepare(HOUR_REQ_QUERY + ' WHERE h.id = ?').get(Number(req.params.id));
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request already decided' });
  db.prepare('UPDATE hour_requests SET status = ?, decided_by = ? WHERE id = ?').run(status, req.user.id, request.id);

  // Approval writes the hours straight into the timesheet, pre-approved.
  if (status === 'approved') {
    const label = [request.role_name, request.venue_name].filter(Boolean).join(' @ ');
    db.prepare('INSERT INTO time_entries (user_id, clock_in, clock_out, note, approved) VALUES (?, ?, ?, ?, 1)')
      .run(request.user_id, request.starts_at, request.ends_at, label || 'requested hours');
    events.broadcast('time', {});
  }
  events.broadcast('hours', {});
  notify([request.user_id].filter((id) => id !== req.user.id), {
    title: `Hours ${status}`,
    body: `${fmtShiftTime(request.starts_at)}${request.venue_name ? ' @ ' + request.venue_name : ''}`,
    url: '/#/hours',
    category: 'hours',
  });
  res.json({ ok: true });
});

app.delete('/api/hour-requests/:id', requireAuth, (req, res) => {
  const request = db.prepare('SELECT * FROM hour_requests WHERE id = ?').get(Number(req.params.id));
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Only pending requests can be withdrawn' });
  db.prepare('DELETE FROM hour_requests WHERE id = ?').run(request.id);
  events.broadcast('hours', {});
  res.json({ ok: true });
});

// Download the signed copy of a document.
app.get('/api/forms/:id/submissions/:sid/pdf', requireAuth, (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ?').get(Number(req.params.id));
  if (!form) return res.status(404).json({ error: 'Document not found' });
  const sub = db.prepare(`
    SELECT s.*, u.name AS user_name FROM form_submissions s
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.form_id = ?
  `).get(Number(req.params.sid), form.id);
  if (!sub) return res.status(404).json({ error: 'Signature not found' });
  // Members may download their own copy; admins may download anyone's.
  if (req.user.role !== 'admin' && sub.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  if (!sub.signed_path || !fs.existsSync(sub.signed_path)) {
    return res.status(404).json({ error: 'Signed file is not available' });
  }
  const safe = `${form.title}-${sub.user_name || 'signed'}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.pdf"`);
  fs.createReadStream(sub.signed_path).pipe(res);
});

// Every document with who has signed it — the admin overview.
app.get('/api/forms/signed-overview', requireAuth, requireAdmin, (req, res) => {
  const people = db.prepare('SELECT id, name, color FROM users ORDER BY name').all();
  const forms = db.prepare('SELECT * FROM forms WHERE archived = 0 ORDER BY id DESC').all().map((f) => {
    const signers = db.prepare(`
      SELECT s.id AS submission_id, s.signed_at, s.created_at, s.user_id, u.name AS user_name, u.color AS user_color
      FROM form_submissions s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.form_id = ? AND s.id = (SELECT MAX(id) FROM form_submissions WHERE form_id = s.form_id AND user_id = s.user_id)
      ORDER BY s.id DESC
    `).all(f.id);
    const signedIds = new Set(signers.map((x) => x.user_id));
    return {
      id: f.id, title: f.title, doc_name: f.doc_name, created_at: f.created_at,
      signers,
      pending: people.filter((p) => !signedIds.has(p.id)),
      headcount: people.length,
    };
  });
  res.json({ forms });
});

/* ------------------------------- updates feed ------------------------------- */

app.get('/api/posts', requireAuth, (req, res) => {
  const posts = db.prepare(`
    SELECT p.*, u.name AS user_name, u.color AS user_color,
           (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) AS likes,
           EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = ?) AS liked
    FROM posts p LEFT JOIN users u ON u.id = p.user_id
    ORDER BY p.id DESC LIMIT 100
  `).all(req.user.id);
  res.json({ posts });
});

app.post('/api/posts', requireAuth, requireAdmin, (req, res) => {
  const { title = '', body } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: 'Post text is required' });
  const info = db.prepare('INSERT INTO posts (user_id, title, body) VALUES (?, ?, ?)')
    .run(req.user.id, String(title).trim().slice(0, 200), body.trim().slice(0, 5000));
  events.broadcast('posts', {});
  const members = db.prepare('SELECT id FROM users WHERE id != ?').all(req.user.id).map((r) => r.id);
  notify(members, {
    title: title.trim() ? `📢 ${title.trim()}` : '📢 Company update',
    body: body.trim().length > 120 ? body.trim().slice(0, 117) + '…' : body.trim(),
    url: '/#/updates',
    category: 'announcements',
  });
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

app.delete('/api/posts/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM posts WHERE id = ?').run(Number(req.params.id));
  events.broadcast('posts', {});
  res.json({ ok: true });
});

app.post('/api/posts/:id/like', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const liked = db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?').get(postId, req.user.id);
  if (liked) db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(postId, req.user.id);
  else db.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)').run(postId, req.user.id);
  events.broadcast('posts', {});
  res.json({ liked: !liked });
});

/* ------------------------------- text messages ------------------------------ */

/* One message, typed once, sent to every phone in the team.
   The SMS leg goes out through a Twilio-compatible HTTP API when the account
   details are in the environment (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
   TWILIO_FROM_NUMBER). With no account configured the message still reaches
   everyone who has the app — as a push notification — and each recipient is
   recorded as 'app' so nobody is told a text went out when it did not. */

const SMS_ENDPOINT = process.env.TWILIO_API_BASE || 'https://api.twilio.com';

function smsConfig() {
  const settings = getSettings();
  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  const from = (settings.sms_from_number || process.env.TWILIO_FROM_NUMBER || '').trim();
  return {
    sid, token, from,
    price: Number(settings.sms_price) || 0,
    configured: !!(sid && token && from),
  };
}

// Digits as typed by the team, turned into what a carrier expects. A bare
// 10-digit US number is the common case here; anything already in +E.164 form
// (or a longer international number) is passed through.
function e164(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  if (raw.startsWith('+')) return '+' + raw.slice(1).replace(/\D/g, '');
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits.length >= 8 ? `+${digits}` : '';
}

// Carriers bill per segment: 160 GSM-7 characters, or 70 when the text needs
// unicode (emoji, curly quotes), dropping to 153/67 once it splits.
function smsSegments(body) {
  const text = String(body || '');
  const unicode = /[^\x00-\x7F]/.test(text);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  if (text.length === 0) return 0;
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

async function sendOneSms({ to, body, cfg }) {
  const res = await fetch(`${SMS_ENDPOINT}/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: cfg.from, Body: body }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Carrier rejected the message (${res.status})`);
  return { id: data.sid || '', price: Math.abs(Number(data.price)) || 0 };
}

function textMessageRow(row) {
  const counts = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(status IN ('delivered', 'app')) AS delivered,
           SUM(status = 'failed') AS failed,
           COALESCE(SUM(price), 0) AS price
    FROM text_recipients WHERE message_id = ?
  `).get(row.id);
  return {
    ...row,
    recipients: counts.total,
    delivered: counts.delivered || 0,
    failed: counts.failed || 0,
    price: Number(counts.price) || 0,
    segments: smsSegments(row.body),
  };
}

// Sends (or re-sends) everything still queued on one message. Runs one number
// at a time on purpose: a failure on one phone must not lose the rest, and each
// row records its own outcome.
async function deliverTextMessage(messageId) {
  const message = db.prepare('SELECT * FROM text_messages WHERE id = ?').get(messageId);
  if (!message || message.status === 'canceled') return;
  const cfg = smsConfig();
  const queued = db.prepare(`SELECT * FROM text_recipients WHERE message_id = ? AND status = 'queued'`).all(messageId);
  const segments = smsSegments(message.body);
  const mark = db.prepare(
    'UPDATE text_recipients SET status = ?, error = ?, price = ?, provider_id = ?, delivered_at = ? WHERE id = ?'
  );

  for (const r of queued) {
    const to = e164(r.phone);
    if (!to) {
      mark.run('no_number', 'No mobile number on file', 0, null, null, r.id);
      continue;
    }
    if (!cfg.configured) {
      // No carrier account: the app is the delivery channel.
      mark.run('app', '', 0, null, new Date().toISOString(), r.id);
      continue;
    }
    try {
      const sent = await sendOneSms({ to, body: message.body, cfg });
      mark.run('delivered', '', sent.price || segments * cfg.price, sent.id, new Date().toISOString(), r.id);
    } catch (err) {
      mark.run('failed', String(err.message).slice(0, 300), 0, null, null, r.id);
    }
  }

  // Everyone with the app also gets it in their pocket, so a text blast is
  // never missed by someone whose number bounced. The sender is left out —
  // they wrote it.
  const userIds = db.prepare(
    'SELECT user_id FROM text_recipients WHERE message_id = ? AND user_id IS NOT NULL AND user_id != ?'
  ).all(messageId, message.created_by || 0).map((r) => r.user_id);
  notify(userIds, {
    title: '💬 Message from the office',
    body: message.body.length > 160 ? message.body.slice(0, 157) + '…' : message.body,
    url: '/#/updates',
    category: 'texts',
  });

  const any = db.prepare(`SELECT COUNT(*) AS n FROM text_recipients WHERE message_id = ? AND status IN ('delivered', 'app')`)
    .get(messageId).n;
  db.prepare('UPDATE text_messages SET status = ?, sent_at = ? WHERE id = ?')
    .run(any ? 'sent' : 'failed', new Date().toISOString(), messageId);
  events.broadcast('texts', {});
}

// Scheduled blasts go out on the same one-minute sweep as shift reminders.
let sendingDueTexts = false;
async function sendDueTexts() {
  if (sendingDueTexts) return;
  sendingDueTexts = true;
  try {
    const due = db.prepare(
      `SELECT id FROM text_messages WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?`
    ).all(new Date().toISOString());
    for (const row of due) await deliverTextMessage(row.id);
  } catch (err) {
    console.error('scheduled text sweep failed', err);
  } finally {
    sendingDueTexts = false;
  }
}
setInterval(sendDueTexts, 60 * 1000);
sendDueTexts();

app.get('/api/texts/config', requireAuth, requireAdmin, (req, res) => {
  const cfg = smsConfig();
  res.json({
    configured: cfg.configured,
    from_number: cfg.from,
    price: cfg.price,
    reachable: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE phone IS NOT NULL AND phone != ''`).get().n,
    headcount: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  });
});

app.get('/api/texts', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, u.name AS sent_by_name, u.color AS sent_by_color
    FROM text_messages t LEFT JOIN users u ON u.id = t.created_by
    ORDER BY COALESCE(t.sent_at, t.scheduled_at, t.created_at) DESC, t.id DESC
    LIMIT 200
  `).all();
  res.json({ messages: rows.map(textMessageRow) });
});

app.get('/api/texts/:id', requireAuth, requireAdmin, (req, res) => {
  const row = db.prepare(`
    SELECT t.*, u.name AS sent_by_name, u.color AS sent_by_color
    FROM text_messages t LEFT JOIN users u ON u.id = t.created_by WHERE t.id = ?
  `).get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Message not found' });
  const recipients = db.prepare(`
    SELECT r.*, u.color AS user_color
    FROM text_recipients r LEFT JOIN users u ON u.id = r.user_id
    WHERE r.message_id = ? ORDER BY r.id
  `).all(row.id);
  res.json({ message: textMessageRow(row), recipients });
});

app.post('/api/texts', requireAuth, requireAdmin, (req, res) => {
  const { body, scheduled_at = null, user_ids = null } = req.body || {};
  const text = String(body || '').trim();
  if (!text) return res.status(400).json({ error: 'Write the message first' });
  if (text.length > 1600) return res.status(400).json({ error: 'Keep the message under 1600 characters' });

  let when = null;
  if (scheduled_at) {
    const at = new Date(scheduled_at);
    if (Number.isNaN(at.getTime())) return res.status(400).json({ error: 'That send time is not a real date' });
    if (at.getTime() < Date.now() - 60 * 1000) return res.status(400).json({ error: 'Pick a send time in the future' });
    when = at.toISOString();
  }

  const everyone = !Array.isArray(user_ids) || user_ids.length === 0;
  const people = everyone
    ? db.prepare('SELECT id, name, phone FROM users ORDER BY name').all()
    : db.prepare(`SELECT id, name, phone FROM users WHERE id IN (${user_ids.map(() => '?').join(',')}) ORDER BY name`)
      .all(...user_ids.map(Number));
  if (!people.length) return res.status(400).json({ error: 'Nobody to send to yet' });

  const cfg = smsConfig();
  const info = db.prepare(`
    INSERT INTO text_messages (body, from_number, audience, scheduled_at, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(text, cfg.from, everyone ? 'all' : 'some', when, 'scheduled', req.user.id);
  const id = Number(info.lastInsertRowid);

  const addRecipient = db.prepare(
    'INSERT INTO text_recipients (message_id, user_id, name, phone) VALUES (?, ?, ?, ?)'
  );
  for (const p of people) addRecipient.run(id, p.id, p.name, p.phone || '');

  events.broadcast('texts', {});
  if (!when) {
    // Answer the browser now; the carrier round-trips in the background.
    deliverTextMessage(id).catch((err) => console.error('text send failed', err));
  }
  res.json({ ok: true, id, scheduled: !!when, recipients: people.length });
});

app.delete('/api/texts/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM text_messages WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Message not found' });
  if (row.status === 'scheduled') {
    // Still waiting on the clock — call it off rather than lose the record.
    db.prepare(`UPDATE text_messages SET status = 'canceled' WHERE id = ?`).run(id);
    db.prepare(`UPDATE text_recipients SET status = 'canceled' WHERE message_id = ? AND status = 'queued'`).run(id);
  } else {
    db.prepare('DELETE FROM text_messages WHERE id = ?').run(id);
  }
  events.broadcast('texts', {});
  res.json({ ok: true, canceled: row.status === 'scheduled' });
});

/* ---------------------------------- static --------------------------------- */

app.use(express.static(path.join(__dirname, 'public')));
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(PORT, () => {
  console.log(`E&E Job Scheduling running on http://localhost:${PORT}`);
});
