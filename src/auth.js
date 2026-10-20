import crypto from 'node:crypto';
import { get, run, verifyPassword, hashPassword, HttpError } from './db.js';
const SESSION_DAYS = 7;
const COOKIE = 'tm_sid';

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function publicUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return rest;
}

export function login(req, res) {
  const { username, password } = req.body || {};
  const user = get('SELECT * FROM users WHERE username = ? AND active = 1', String(username || ''));
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    throw new HttpError(401, 'Invalid username or password');
  }
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
    token, user.id, Date.now() + SESSION_DAYS * 86400000);
  run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
  res.json(publicUser(user));
}

export function logout(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
}

export function changePassword(req, res) {
  const { current_password, new_password } = req.body || {};
  const user = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(String(current_password || ''), user.password_hash)) {
    throw new HttpError(400, 'Current password is incorrect');
  }
  if (!new_password || String(new_password).length < 6) {
    throw new HttpError(400, 'New password must be at least 6 characters');
  }
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(String(new_password)), user.id);
  res.json({ ok: true });
}

/* ---------------------------------------------------------------- API tokens (CI / automation) */

const TOKEN_PREFIX = 'tdk_';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createApiToken({ userId, name, expiresDays, createdBy }) {
  const label = String(name || '').trim();
  if (!label) throw new HttpError(400, 'Give the token a name, e.g. "GitHub Actions"');
  const user = get('SELECT role, active FROM users WHERE id = ?', userId);
  if (!user || !user.active) throw new HttpError(400, 'User not found or inactive');
  if (user.role === 'client') throw new HttpError(400, 'Tokens are for admin and tester accounts. Clients sign in through the web UI.');
  const days = Number(expiresDays);
  const expiresAt = Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const r = run(
    'INSERT INTO api_tokens (user_id, name, token_hash, prefix, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    userId, label.slice(0, 100), sha256(token), token.slice(0, 12), expiresAt, createdBy);
  return { id: Number(r.lastInsertRowid), token, prefix: token.slice(0, 12), expires_at: expiresAt };
}

function userFromBearer(req) {
  const m = /^Bearer\s+(tdk_[A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const row = get(
    `SELECT t.id AS token_id, t.expires_at, t.last_used_at, u.* FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND u.active = 1`, sha256(m[1]));
  if (!row || (row.expires_at && new Date(row.expires_at) < new Date())) return null;
  // avoid a write on every request
  if (!row.last_used_at || Date.now() - new Date(`${row.last_used_at.replace(' ', 'T')}Z`) > 60000) {
    run('UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', row.token_id);
  }
  const { token_id, expires_at, last_used_at, ...user } = row;
  return user;
}

/** Attaches req.user (browser session cookie, or `Authorization: Bearer tdk_…`) or responds 401. */
export function requireAuth(req, res, next) {
  const cookie = readCookie(req, COOKIE);
  const sessionUser = cookie && get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`, cookie, Date.now());
  if (sessionUser) {
    req.user = publicUser(sessionUser);
    return next();
  }
  const tokenUser = userFromBearer(req);
  if (tokenUser) {
    req.user = publicUser(tokenUser);
    req.viaToken = true;
    return next();
  }
  res.status(401).json({ error: req.headers.authorization ? 'Invalid or expired API token' : 'Not logged in' });
}

/** API tokens may only reach the automation endpoints (plus identity and project lookup), never admin or destructive routes. */
export function limitTokenScope(req, res, next) {
  if (!req.viaToken) return next();
  const ok = /\/automation(\/|$)/.test(req.path)
    || req.path === '/auth/me'
    || (req.method === 'GET' && (req.path === '/projects' || req.path === '/meta'));
  if (ok) return next();
  res.status(403).json({ error: 'API tokens can only be used with the automation endpoints' });
}

/** Roles: admin (everything), tester (write test assets, execute), client (view, approve, sign off). */
export const requireRole = (...roles) => (req, res, next) => {
  if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
  res.status(403).json({ error: 'You do not have permission for this action' });
};
