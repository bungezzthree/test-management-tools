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

/** Attaches req.user or responds 401. */
export function requireAuth(req, res, next) {
  const token = readCookie(req, COOKIE);
  const user = token && get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`, token, Date.now());
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = publicUser(user);
  next();
}

/** Roles: admin (everything), tester (write test assets, execute), client (view, approve, sign off). */
export const requireRole = (...roles) => (req, res, next) => {
  if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
  res.status(403).json({ error: 'You do not have permission for this action' });
};
