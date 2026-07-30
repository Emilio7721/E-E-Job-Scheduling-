const express = require('express');
const path = require('node:path');
const { db } = require('./src/db');
const {
  hashPassword, verifyPassword, issueToken, verifyToken, tokenFromReq,
  requireAuth, requireAdmin,
} = require('./src/auth');
const push = require('./src/push');
const events = require('./src/events');

const app = express();
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 3000;
const COOKIE_OPTS = 'Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000';

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
  const { name, email, password } = req.body || {};
  if (!name?.trim() || !email?.trim() || !password || password.length < 6) {
    return res.status(400).json({ error: 'Name, email and a password of 6+ characters are required' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim());
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  // First account becomes the admin/owner of the workspace.
  const isFirst = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  const colors = ['#4f46e5', '#0ea5e9', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const info = db.prepare('INSERT INTO users (name, email, pass_hash, role, color) VALUES (?, ?, ?, ?, ?)')
    .run(name.trim(), email.trim(), hashPassword(password), isFirst ? 'admin' : 'member', color);
  const userId = Number(info.lastInsertRowid);

  const general = db.prepare(`SELECT id FROM channels WHERE kind = 'group' AND name = 'General'`).get();
  db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(general.id, userId);

  setAuthCookie(res, userId);
  res.json({ user: db.prepare('SELECT id, name, email, role, color FROM users WHERE id = ?').get(userId) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').trim());
  if (!user || !verifyPassword(password || '', user.pass_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  setAuthCookie(res, user.id);
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role, color: user.color } });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'ee_token=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user, vapidPublicKey: push.publicKey });
});

/* ---------------------------------- team ---------------------------------- */

app.get('/api/users', requireAuth, (req, res) => {
  const cols = req.user.role === 'admin'
    ? 'id, name, email, role, color, hourly_rate'
    : 'id, name, email, role, color';
  res.json({ users: db.prepare(`SELECT ${cols} FROM users ORDER BY name`).all() });
});

app.patch('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found' });
  const { role = target.role, hourly_rate = target.hourly_rate } = req.body || {};
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (role !== target.role && target.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot change your own role' });
  }
  const rate = Math.max(0, Number(hourly_rate) || 0);
  db.prepare('UPDATE users SET role = ?, hourly_rate = ? WHERE id = ?').run(role, rate, target.id);
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
  SELECT s.*, v.name AS venue_name, v.address AS venue_address, v.color AS venue_color
  FROM shifts s LEFT JOIN venues v ON v.id = s.venue_id
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
  const { title, venue_id = null, starts_at, ends_at, notes = '', assignee_ids = [] } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Job title is required' });
  if (!starts_at || !ends_at || new Date(ends_at) <= new Date(starts_at)) {
    return res.status(400).json({ error: 'Valid start and end times are required' });
  }
  const info = db.prepare('INSERT INTO shifts (title, venue_id, starts_at, ends_at, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title.trim(), venue_id, starts_at, ends_at, notes.trim(), req.user.id);
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
    title = shift.title, venue_id = shift.venue_id, starts_at = shift.starts_at,
    ends_at = shift.ends_at, notes = shift.notes, assignee_ids,
  } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Job title is required' });
  if (new Date(ends_at) <= new Date(starts_at)) return res.status(400).json({ error: 'End time must be after start time' });

  db.prepare('UPDATE shifts SET title = ?, venue_id = ?, starts_at = ?, ends_at = ?, notes = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(title.trim(), venue_id, starts_at, ends_at, notes.trim(), shift.id);

  const before = db.prepare('SELECT user_id FROM shift_assignees WHERE shift_id = ?').all(shift.id).map((r) => r.user_id);
  let added = [];
  if (Array.isArray(assignee_ids)) {
    db.prepare('DELETE FROM shift_assignees WHERE shift_id = ?').run(shift.id);
    const addAssignee = db.prepare('INSERT OR IGNORE INTO shift_assignees (shift_id, user_id) VALUES (?, ?)');
    for (const uid of assignee_ids) addAssignee.run(shift.id, uid);
    added = assignee_ids.filter((id) => !before.includes(id));
  }

  const updated = shiftWithAssignees(db.prepare(SHIFT_QUERY + ' WHERE s.id = ?').get(shift.id));
  events.broadcast('shifts', {});
  const kept = Array.isArray(assignee_ids) ? assignee_ids.filter((id) => before.includes(id)) : before;
  notify(added.filter((id) => id !== req.user.id), {
    title: `New job: ${updated.title}`,
    body: `${fmtShiftTime(updated.starts_at)}${updated.venue_name ? ' @ ' + updated.venue_name : ''}`,
    url: '/#/schedule',
  });
  notify(kept.filter((id) => id !== req.user.id), {
    title: `Job updated: ${updated.title}`,
    body: `${fmtShiftTime(updated.starts_at)}${updated.venue_name ? ' @ ' + updated.venue_name : ''}`,
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

app.post('/api/push/test', requireAuth, (req, res) => {
  push.pushToUser(req.user.id, {
    title: 'E&E Scheduling',
    body: 'Push notifications are working on this device 🎉',
    url: '/#/settings',
  }).catch(() => {});
  res.json({ ok: true });
});

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
  SELECT t.*, u.name AS user_name, u.color AS user_color, u.hourly_rate,
         s.title AS shift_title
  FROM time_entries t
  JOIN users u ON u.id = t.user_id
  LEFT JOIN shifts s ON s.id = t.shift_id
`;

app.get('/api/time/status', requireAuth, (req, res) => {
  const entry = db.prepare(TIME_ENTRY_QUERY + ' WHERE t.user_id = ? AND t.clock_out IS NULL').get(req.user.id);
  res.json({ entry: entry || null });
});

app.post('/api/time/clock-in', requireAuth, (req, res) => {
  const open = db.prepare('SELECT id FROM time_entries WHERE user_id = ? AND clock_out IS NULL').get(req.user.id);
  if (open) return res.status(400).json({ error: 'You are already clocked in' });
  const { lat = null, lng = null, shift_id = null, note = '' } = req.body || {};
  const info = db.prepare(
    'INSERT INTO time_entries (user_id, shift_id, clock_in, in_lat, in_lng, note) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, shift_id || null, new Date().toISOString(), lat, lng, String(note).slice(0, 500));
  events.broadcast('time', {});
  res.json({ entry: db.prepare(TIME_ENTRY_QUERY + ' WHERE t.id = ?').get(Number(info.lastInsertRowid)) });
});

app.post('/api/time/clock-out', requireAuth, (req, res) => {
  const open = db.prepare('SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NULL').get(req.user.id);
  if (!open) return res.status(400).json({ error: 'You are not clocked in' });
  const { lat = null, lng = null } = req.body || {};
  db.prepare('UPDATE time_entries SET clock_out = ?, out_lat = ?, out_lng = ? WHERE id = ?')
    .run(new Date().toISOString(), lat, lng, open.id);
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
  if (req.user.role !== 'admin') for (const e of entries) delete e.hourly_rate;
  res.json({ entries });
});

app.patch('/api/time/entries/:id', requireAuth, requireAdmin, (req, res) => {
  const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(Number(req.params.id));
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  const { clock_in = entry.clock_in, clock_out = entry.clock_out, approved = entry.approved } = req.body || {};
  if (clock_out && new Date(clock_out) <= new Date(clock_in)) {
    return res.status(400).json({ error: 'Clock-out must be after clock-in' });
  }
  db.prepare('UPDATE time_entries SET clock_in = ?, clock_out = ?, approved = ? WHERE id = ?')
    .run(clock_in, clock_out, approved ? 1 : 0, entry.id);
  events.broadcast('time', {});
  res.json({ ok: true });
});

app.delete('/api/time/entries/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM time_entries WHERE id = ?').run(Number(req.params.id));
  events.broadcast('time', {});
  res.json({ ok: true });
});

// Payroll CSV export: one row per entry with hours and computed pay.
app.get('/api/time/export', requireAuth, requireAdmin, (req, res) => {
  const { from = '1970-01-01', to = '9999-12-31' } = req.query;
  const entries = db.prepare(
    TIME_ENTRY_QUERY + ' WHERE t.clock_in >= ? AND t.clock_in < ? AND t.clock_out IS NOT NULL ORDER BY u.name, t.clock_in'
  ).all(from, to);
  const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Employee', 'Email', 'Clock in', 'Clock out', 'Hours', 'Hourly rate', 'Pay', 'Job', 'Approved']];
  const totals = new Map();
  for (const e of entries) {
    const hours = (new Date(e.clock_out) - new Date(e.clock_in)) / 3600000;
    const pay = hours * (e.hourly_rate || 0);
    const email = db.prepare('SELECT email FROM users WHERE id = ?').get(e.user_id)?.email || '';
    rows.push([e.user_name, email, e.clock_in, e.clock_out, hours.toFixed(2), (e.hourly_rate || 0).toFixed(2), pay.toFixed(2), e.shift_title || '', e.approved ? 'yes' : 'no']);
    const t = totals.get(e.user_name) || { hours: 0, pay: 0 };
    t.hours += hours; t.pay += pay;
    totals.set(e.user_name, t);
  }
  rows.push([]);
  rows.push(['TOTALS']);
  for (const [name, t] of totals) rows.push([name, '', '', '', t.hours.toFixed(2), '', t.pay.toFixed(2)]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="timesheet-${from.slice(0, 10)}-to-${to.slice(0, 10)}.csv"`);
  res.send(rows.map((r) => r.map(csvEsc).join(',')).join('\n'));
});

/* --------------------------------- time off --------------------------------- */

const TIMEOFF_QUERY = `
  SELECT r.*, u.name AS user_name, u.color AS user_color
  FROM timeoff_requests r JOIN users u ON u.id = r.user_id
`;

app.get('/api/timeoff', requireAuth, (req, res) => {
  const requests = req.user.role === 'admin'
    ? db.prepare(TIMEOFF_QUERY + ' ORDER BY r.id DESC LIMIT 200').all()
    : db.prepare(TIMEOFF_QUERY + ' WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 200').all(req.user.id);
  res.json({ requests });
});

app.post('/api/timeoff', requireAuth, (req, res) => {
  const { start_date, end_date, kind = 'vacation', note = '' } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end_date || '') || end_date < start_date) {
    return res.status(400).json({ error: 'Valid start and end dates are required' });
  }
  if (!['vacation', 'sick', 'personal', 'other'].includes(kind)) return res.status(400).json({ error: 'Invalid type' });
  const info = db.prepare('INSERT INTO timeoff_requests (user_id, start_date, end_date, kind, note) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, start_date, end_date, kind, String(note).slice(0, 500));
  events.broadcast('timeoff', {});
  const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all().map((r) => r.id);
  notify(admins.filter((id) => id !== req.user.id), {
    title: `Time-off request from ${req.user.name}`,
    body: `${kind} · ${start_date} → ${end_date}`,
    url: '/#/timeoff',
  });
  res.json({ request: db.prepare(TIMEOFF_QUERY + ' WHERE r.id = ?').get(Number(info.lastInsertRowid)) });
});

app.post('/api/timeoff/:id/decide', requireAuth, requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!['approved', 'denied'].includes(status)) return res.status(400).json({ error: 'Invalid decision' });
  const request = db.prepare('SELECT * FROM timeoff_requests WHERE id = ?').get(Number(req.params.id));
  if (!request) return res.status(404).json({ error: 'Request not found' });
  db.prepare('UPDATE timeoff_requests SET status = ?, decided_by = ? WHERE id = ?').run(status, req.user.id, request.id);
  events.broadcast('timeoff', {});
  notify([request.user_id].filter((id) => id !== req.user.id), {
    title: `Time off ${status}`,
    body: `${request.kind} · ${request.start_date} → ${request.end_date}`,
    url: '/#/timeoff',
  });
  res.json({ ok: true });
});

app.delete('/api/timeoff/:id', requireAuth, (req, res) => {
  const request = db.prepare('SELECT * FROM timeoff_requests WHERE id = ?').get(Number(req.params.id));
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
  db.prepare('DELETE FROM timeoff_requests WHERE id = ?').run(request.id);
  events.broadcast('timeoff', {});
  res.json({ ok: true });
});

/* ---------------------------------- tasks ----------------------------------- */

function taskWithAssignees(task) {
  const assignees = db.prepare(`
    SELECT u.id, u.name, u.color, a.done_at
    FROM task_assignees a JOIN users u ON u.id = a.user_id
    WHERE a.task_id = ? ORDER BY u.name
  `).all(task.id);
  return { ...task, assignees };
}

app.get('/api/tasks', requireAuth, (req, res) => {
  const tasks = (req.user.role === 'admin'
    ? db.prepare('SELECT * FROM tasks ORDER BY due_at IS NULL, due_at, id DESC LIMIT 300').all()
    : db.prepare(`
        SELECT t.* FROM tasks t JOIN task_assignees a ON a.task_id = t.id
        WHERE a.user_id = ? ORDER BY t.due_at IS NULL, t.due_at, t.id DESC LIMIT 300
      `).all(req.user.id)
  ).map(taskWithAssignees);
  res.json({ tasks });
});

app.post('/api/tasks', requireAuth, requireAdmin, (req, res) => {
  const { title, notes = '', due_at = null, assignee_ids = [] } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Task title is required' });
  const info = db.prepare('INSERT INTO tasks (title, notes, due_at, created_by) VALUES (?, ?, ?, ?)')
    .run(title.trim(), String(notes).trim(), due_at, req.user.id);
  const taskId = Number(info.lastInsertRowid);
  const add = db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)');
  for (const uid of assignee_ids) add.run(taskId, uid);
  events.broadcast('tasks', {});
  notify(assignee_ids.filter((id) => id !== req.user.id), {
    title: `New task: ${title.trim()}`,
    body: due_at ? `Due ${new Date(due_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: process.env.APP_TZ || 'America/New_York' })}` : '',
    url: '/#/tasks',
  });
  res.json({ task: taskWithAssignees(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)) });
});

app.patch('/api/tasks/:id', requireAuth, requireAdmin, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const { title = task.title, notes = task.notes, due_at = task.due_at, assignee_ids } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Task title is required' });
  db.prepare('UPDATE tasks SET title = ?, notes = ?, due_at = ? WHERE id = ?')
    .run(title.trim(), String(notes).trim(), due_at, task.id);
  if (Array.isArray(assignee_ids)) {
    const before = db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(task.id).map((r) => r.user_id);
    db.prepare('DELETE FROM task_assignees WHERE task_id = ?').run(task.id);
    const add = db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)');
    for (const uid of assignee_ids) add.run(task.id, uid);
    notify(assignee_ids.filter((id) => !before.includes(id) && id !== req.user.id), {
      title: `New task: ${title.trim()}`,
      url: '/#/tasks',
    });
  }
  events.broadcast('tasks', {});
  res.json({ ok: true });
});

app.delete('/api/tasks/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(req.params.id));
  events.broadcast('tasks', {});
  res.json({ ok: true });
});

app.post('/api/tasks/:id/toggle', requireAuth, (req, res) => {
  const taskId = Number(req.params.id);
  const row = db.prepare('SELECT * FROM task_assignees WHERE task_id = ? AND user_id = ?').get(taskId, req.user.id);
  if (!row) return res.status(404).json({ error: 'You are not assigned to this task' });
  const done = !row.done_at;
  db.prepare('UPDATE task_assignees SET done_at = ? WHERE task_id = ? AND user_id = ?')
    .run(done ? new Date().toISOString() : null, taskId, req.user.id);
  events.broadcast('tasks', {});
  if (done) {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all().map((r) => r.id);
    notify(admins.filter((id) => id !== req.user.id), {
      title: `${req.user.name} completed a task`,
      body: task.title,
      url: '/#/tasks',
    });
  }
  res.json({ ok: true });
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
  const forms = db.prepare('SELECT * FROM forms WHERE archived = 0 ORDER BY id DESC').all()
    .map((f) => ({
      ...f,
      fields: JSON.parse(f.fields),
      my_submissions: db.prepare('SELECT COUNT(*) AS n FROM form_submissions WHERE form_id = ? AND user_id = ?').get(f.id, req.user.id).n,
      total_submissions: req.user.role === 'admin'
        ? db.prepare('SELECT COUNT(*) AS n FROM form_submissions WHERE form_id = ?').get(f.id).n
        : undefined,
    }));
  res.json({ forms });
});

app.post('/api/forms', requireAuth, requireAdmin, (req, res) => {
  const { title, description = '', fields } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Form title is required' });
  const clean = sanitizeFields(fields);
  if (!clean) return res.status(400).json({ error: 'The form needs at least one valid field' });
  const info = db.prepare('INSERT INTO forms (title, description, fields, created_by) VALUES (?, ?, ?, ?)')
    .run(title.trim(), String(description).trim(), JSON.stringify(clean), req.user.id);
  events.broadcast('forms', {});
  const members = db.prepare('SELECT id FROM users WHERE id != ?').all(req.user.id).map((r) => r.id);
  notify(members, { title: `New form: ${title.trim()}`, body: 'Tap to fill it in', url: '/#/forms' });
  res.json({ form: db.prepare('SELECT * FROM forms WHERE id = ?').get(Number(info.lastInsertRowid)) });
});

app.delete('/api/forms/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE forms SET archived = 1 WHERE id = ?').run(Number(req.params.id));
  events.broadcast('forms', {});
  res.json({ ok: true });
});

app.post('/api/forms/:id/submit', requireAuth, (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ? AND archived = 0').get(Number(req.params.id));
  if (!form) return res.status(404).json({ error: 'Form not found' });
  const fields = JSON.parse(form.fields);
  const answers = req.body?.answers || {};
  const clean = {};
  for (const f of fields) {
    const v = answers[f.id];
    if (f.required && (v === undefined || v === null || v === '' || (f.type === 'checkbox' && !v))) {
      return res.status(400).json({ error: `"${f.label}" is required` });
    }
    clean[f.id] = f.type === 'checkbox' ? !!v : String(v ?? '').slice(0, 2000);
  }
  db.prepare('INSERT INTO form_submissions (form_id, user_id, answers) VALUES (?, ?, ?)')
    .run(form.id, req.user.id, JSON.stringify(clean));
  events.broadcast('forms', {});
  const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all().map((r) => r.id);
  notify(admins.filter((id) => id !== req.user.id), {
    title: `${req.user.name} submitted "${form.title}"`,
    url: '/#/forms',
  });
  res.json({ ok: true });
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
