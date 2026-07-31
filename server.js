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

function notify(userIds, { title, body = '', url = '/' }) {
  const insert = db.prepare('INSERT INTO notifications (user_id, title, body, url) VALUES (?, ?, ?, ?)');
  for (const userId of new Set(userIds)) {
    const info = insert.run(userId, title, body, url);
    events.sendTo(userId, 'notification', { id: Number(info.lastInsertRowid), title, body, url });
    push.pushToUser(userId, { title, body, url }).catch(() => {});
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
  claimWorkerId(userId, name.trim());

  setAuthCookie(res, userId);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)), pin });
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
function claimWorkerId(userId, name) {
  const key = nameKey(name);
  if (!key) return null;
  const row = db.prepare('SELECT worker_id FROM worker_id_roster WHERE name_key = ?').get(key);
  if (!row) return null;
  const taken = db.prepare('SELECT id FROM users WHERE worker_id = ? AND id != ?').get(row.worker_id, userId);
  if (taken) return null;
  db.prepare('UPDATE users SET worker_id = ? WHERE id = ?').run(row.worker_id, userId);
  return row.worker_id;
}

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
  paychex_company_id: '',
  pay_component: 'Hourly',
  // Monday of the first pay period; every period runs 14 days from here.
  period_anchor: '2026-01-05',
  export_per_day: '0',   // one row per employee per day (adds Line Date)
  export_jobs: '0',      // include venue as Job Number / Job Name
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
    if (key === 'paychex_company_id' && value && !/^[a-z0-9]{1,8}$/i.test(value)) {
      return res.status(400).json({ error: 'Paychex Company ID must be up to 8 letters or numbers' });
    }
    if (key === 'pay_component' && value.length > 20) {
      return res.status(400).json({ error: 'Pay Component must be 20 characters or fewer' });
    }
    if (key === 'period_anchor' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return res.status(400).json({ error: 'Pay period start must be a date' });
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

/* --------------------------------- shifts --------------------------------- */

const SHIFT_QUERY = `
  SELECT s.*, v.name AS venue_name, v.address AS venue_address, v.color AS venue_color,
         r.name AS role_name
  FROM shifts s
  LEFT JOIN venues v ON v.id = s.venue_id
  LEFT JOIN roles r ON r.id = s.role_id
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

function fmtShiftTime(iso) {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: process.env.APP_TZ || 'America/New_York',
  });
}

app.post('/api/shifts', requireAuth, requireAdmin, (req, res) => {
  const { title, venue_id = null, role_id = null, starts_at, ends_at, notes = '', assignee_ids = [] } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Job title is required' });
  if (!starts_at || !ends_at || new Date(ends_at) <= new Date(starts_at)) {
    return res.status(400).json({ error: 'Valid start and end times are required' });
  }
  const info = db.prepare('INSERT INTO shifts (title, venue_id, role_id, starts_at, ends_at, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(title.trim(), venue_id, role_id, starts_at, ends_at, notes.trim(), req.user.id);
  const shiftId = Number(info.lastInsertRowid);
  const addAssignee = db.prepare('INSERT OR IGNORE INTO shift_assignees (shift_id, user_id) VALUES (?, ?)');
  for (const uid of assignee_ids) addAssignee.run(shiftId, uid);

  const shift = shiftWithAssignees(db.prepare(SHIFT_QUERY + ' WHERE s.id = ?').get(shiftId));
  events.broadcast('shifts', {});
  notify(assignee_ids.filter((id) => id !== req.user.id), {
    title: `New job: ${shift.title}`,
    body: `${fmtShiftTime(shift.starts_at)}${shift.venue_name ? ' @ ' + shift.venue_name : ''}`,
    url: '/#/schedule',
  });
  res.json({ shift });
});

app.patch('/api/shifts/:id', requireAuth, requireAdmin, (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(req.params.id));
  if (!shift) return res.status(404).json({ error: 'Job not found' });
  const {
    title = shift.title, venue_id = shift.venue_id, role_id = shift.role_id,
    starts_at = shift.starts_at, ends_at = shift.ends_at, notes = shift.notes, assignee_ids,
  } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Job title is required' });
  if (new Date(ends_at) <= new Date(starts_at)) return res.status(400).json({ error: 'End time must be after start time' });

  db.prepare(`UPDATE shifts SET title = ?, venue_id = ?, role_id = ?, starts_at = ?, ends_at = ?, notes = ?,
      reminded_at = CASE WHEN starts_at != ? THEN NULL ELSE reminded_at END,
      updated_at = datetime('now') WHERE id = ?`)
    .run(title.trim(), venue_id, role_id, starts_at, ends_at, notes.trim(), starts_at, shift.id);

  const before = db.prepare('SELECT user_id FROM shift_assignees WHERE shift_id = ?').all(shift.id).map((r) => r.user_id);
  let added = [];
  let removed = [];
  if (Array.isArray(assignee_ids)) {
    db.prepare('DELETE FROM shift_assignees WHERE shift_id = ?').run(shift.id);
    const addAssignee = db.prepare('INSERT OR IGNORE INTO shift_assignees (shift_id, user_id) VALUES (?, ?)');
    for (const uid of assignee_ids) addAssignee.run(shift.id, uid);
    added = assignee_ids.filter((id) => !before.includes(id));
    removed = before.filter((id) => !assignee_ids.includes(id));
  }

  const updated = shiftWithAssignees(db.prepare(SHIFT_QUERY + ' WHERE s.id = ?').get(shift.id));
  events.broadcast('shifts', {});
  const kept = Array.isArray(assignee_ids) ? assignee_ids.filter((id) => before.includes(id)) : before;

  // People already on the job only hear about it when something really changed.
  const changes = [];
  if (shift.title !== updated.title) changes.push('title');
  if (shift.starts_at !== updated.starts_at || shift.ends_at !== updated.ends_at) changes.push('time');
  if (shift.venue_id !== updated.venue_id) changes.push('venue');
  if (shift.role_id !== updated.role_id) changes.push('job');
  if (shift.notes !== updated.notes) changes.push('notes');

  notify(added.filter((id) => id !== req.user.id), {
    title: `New job: ${updated.title}`,
    body: `${fmtShiftTime(updated.starts_at)}${updated.venue_name ? ' @ ' + updated.venue_name : ''}`,
    url: '/#/schedule',
  });
  if (changes.length) {
    notify(kept.filter((id) => id !== req.user.id), {
      title: `Job updated (${changes.join(', ')}): ${updated.title}`,
      body: `${fmtShiftTime(updated.starts_at)}${updated.venue_name ? ' @ ' + updated.venue_name : ''}`,
      url: '/#/schedule',
    });
  }
  notify(removed.filter((id) => id !== req.user.id), {
    title: `You were taken off: ${updated.title}`,
    body: fmtShiftTime(updated.starts_at),
    url: '/#/schedule',
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
  res.json({ entries: db.prepare(sql).all(...params) });
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

// Paychex SPI import file (flexible layout) for a pay period.
// Only approved, finished punches are exported; rates are deliberately absent
// so Paychex applies each worker's configured rate.
app.get('/api/time/export', requireAuth, requireAdmin, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'A pay period is required' });
  const cfg = getSettings();

  const entries = db.prepare(
    TIME_ENTRY_QUERY + ' WHERE t.approved = 1 AND t.clock_out IS NOT NULL AND t.clock_in >= ? AND t.clock_in < ? ORDER BY u.name, t.clock_in'
  ).all(from, to);

  const workerIds = new Map(db.prepare('SELECT id, worker_id FROM users').all().map((u) => [u.id, u.worker_id]));
  const missing = [...new Set(entries.filter((e) => !workerIds.get(e.user_id)).map((e) => e.user_name))];
  if (missing.length) {
    return res.status(400).json({ error: `Add a Paychex Worker ID in Team for: ${missing.join(', ')}` });
  }
  if (!cfg.paychex_company_id) {
    return res.status(400).json({ error: 'Set your Paychex Company ID in Timesheets settings first' });
  }

  const perDay = cfg.export_per_day === '1';
  const withJobs = cfg.export_jobs === '1';
  const tz = process.env.APP_TZ || 'America/New_York';
  const dayKey = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });       // yyyy-mm-dd
  const lineDate = (iso) => new Date(iso).toLocaleDateString('en-US', {
    timeZone: tz, month: '2-digit', day: '2-digit', year: 'numeric',
  });

  // Group hours to the level the settings ask for.
  const groups = new Map();
  for (const e of entries) {
    const hours = (new Date(e.clock_out) - new Date(e.clock_in)) / 3600000;
    const key = [e.user_id, perDay ? dayKey(e.clock_in) : '', withJobs ? (e.venue_id || '') : ''].join('|');
    const g = groups.get(key) || {
      worker: workerIds.get(e.user_id),
      date: e.clock_in,
      venueName: e.venue_name || '',
      venueId: e.venue_id || '',
      hours: 0,
    };
    g.hours += hours;
    groups.set(key, g);
  }

  const header = ['Company ID', 'Worker ID', 'Pay Component', 'Hours'];
  if (perDay) header.push('Line Date');
  if (withJobs) header.push('Job Number', 'Job Name');

  const csvEsc = (v) => {
    const str = String(v ?? '');
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const rows = [header];
  for (const g of groups.values()) {
    // Paychex rejects meaningless zero-hour lines, so drop anything that
    // rounds away (a punch corrected to the same in/out time, say).
    if (g.hours < 0.005) continue;
    const row = [cfg.paychex_company_id, g.worker, cfg.pay_component, g.hours.toFixed(2)];
    if (perDay) row.push(lineDate(g.date));
    if (withJobs) row.push(String(g.venueId).slice(0, 25), g.venueName.slice(0, 30));
    rows.push(row);
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="paychex-spi-${from.slice(0, 10)}.csv"`);
  // Paychex expects CRLF line endings in the import file.
  res.send(rows.map((r) => r.map(csvEsc).join(',')).join('\r\n') + '\r\n');
});

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
