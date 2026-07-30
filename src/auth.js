const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('./db');

const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
if (!fs.existsSync(SECRET_FILE)) {
  fs.writeFileSync(SECRET_FILE, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
}
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function issueToken(userId) {
  const expires = Date.now() + TOKEN_TTL_MS;
  const payload = `${userId}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expires, sig] = parts;
  const payload = `${userId}.${expires}`;
  const expected = sign(payload);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(expires) < Date.now()) return null;
  return Number(userId);
}

function tokenFromReq(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)ee_token=([^;]+)/);
  if (match) return match[1];
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

// Express middleware: attaches req.user or sends 401.
function requireAuth(req, res, next) {
  const userId = verifyToken(tokenFromReq(req));
  if (!userId) return res.status(401).json({ error: 'Not signed in' });
  const user = db.prepare('SELECT id, name, email, role, color FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

module.exports = { hashPassword, verifyPassword, issueToken, verifyToken, tokenFromReq, requireAuth, requireAdmin };
