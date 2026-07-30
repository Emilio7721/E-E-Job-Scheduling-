const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash  TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'member', -- 'admin' | 'member'
    color      TEXT NOT NULL DEFAULT '#4f46e5',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS venues (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    address    TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    color      TEXT NOT NULL DEFAULT '#0ea5e9',
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS shifts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    venue_id   INTEGER REFERENCES venues(id) ON DELETE SET NULL,
    starts_at  TEXT NOT NULL, -- ISO 8601 UTC
    ends_at    TEXT NOT NULL,
    notes      TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_shifts_starts ON shifts(starts_at);

  CREATE TABLE IF NOT EXISTS shift_assignees (
    shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status   TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted' | 'declined'
    PRIMARY KEY (shift_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS channels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'group', -- 'group' | 'dm'
    dm_key     TEXT UNIQUE,                   -- 'minUserId:maxUserId' for DMs
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS channel_members (
    channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);

  CREATE TABLE IF NOT EXISTS push_subs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    url        TEXT NOT NULL DEFAULT '/',
    read       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS time_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shift_id   INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
    clock_in   TEXT NOT NULL,
    clock_out  TEXT,
    in_lat     REAL, in_lng REAL,
    out_lat    REAL, out_lng REAL,
    note       TEXT NOT NULL DEFAULT '',
    approved   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_time_user ON time_entries(user_id, clock_in);

  CREATE TABLE IF NOT EXISTS timeoff_requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_date TEXT NOT NULL, -- YYYY-MM-DD
    end_date   TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'vacation', -- vacation | sick | personal | other
    note       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | denied
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    notes      TEXT NOT NULL DEFAULT '',
    due_at     TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS task_assignees (
    task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    done_at  TEXT,
    PRIMARY KEY (task_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS forms (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    fields      TEXT NOT NULL DEFAULT '[]', -- JSON array of field specs
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS form_submissions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    form_id    INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    answers    TEXT NOT NULL DEFAULT '{}', -- JSON: field id -> answer
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title      TEXT NOT NULL DEFAULT '',
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS post_likes (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, user_id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS roles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS hour_requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    venue_id   INTEGER REFERENCES venues(id) ON DELETE SET NULL,
    role_id    INTEGER REFERENCES roles(id) ON DELETE SET NULL,
    starts_at  TEXT NOT NULL,
    ends_at    TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS positions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    is_admin   INTEGER NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Lightweight migrations for databases created before a column existed.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('users', 'hourly_rate', 'hourly_rate REAL NOT NULL DEFAULT 0');
ensureColumn('users', 'pin', 'pin TEXT');
ensureColumn('users', 'phone', 'phone TEXT');
ensureColumn('users', 'role_id', 'role_id INTEGER');
ensureColumn('users', 'position_id', 'position_id INTEGER');
ensureColumn('roles', 'is_admin', 'is_admin INTEGER NOT NULL DEFAULT 0');
ensureColumn('shifts', 'role_id', 'role_id INTEGER');
ensureColumn('shifts', 'reminded_at', 'reminded_at TEXT');
ensureColumn('time_entries', 'venue_id', 'venue_id INTEGER');
ensureColumn('time_entries', 'role_id', 'role_id INTEGER');
ensureColumn('time_entries', 'mileage', 'mileage REAL NOT NULL DEFAULT 0');

// Every user gets a unique 5-digit clock-in PIN.
function newPin() {
  for (;;) {
    const pin = String(Math.floor(10000 + Math.random() * 90000));
    if (!db.prepare('SELECT 1 FROM users WHERE pin = ?').get(pin)) return pin;
  }
}
for (const u of db.prepare(`SELECT id FROM users WHERE pin IS NULL OR pin = ''`).all()) {
  db.prepare('UPDATE users SET pin = ? WHERE id = ?').run(newPin(), u.id);
}

// Ensure the company-wide "General" channel exists.
const general = db.prepare(`SELECT id FROM channels WHERE kind = 'group' AND name = 'General'`).get();
if (!general) {
  db.prepare(`INSERT INTO channels (name, kind) VALUES ('General', 'group')`).run();
}

module.exports = { db, DATA_DIR, newPin };
