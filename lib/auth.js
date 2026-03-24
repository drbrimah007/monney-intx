// lib/auth.js — JWT + bcrypt helpers

const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');

const JWT_SECRET  = process.env.JWT_SECRET  || 'change_this_secret_in_production';
if (!process.env.JWT_SECRET) console.warn('[auth] WARNING: JWT_SECRET env var not set — using insecure default. Set JWT_SECRET in production!');
const JWT_EXPIRES = process.env.JWT_EXPIRES || '30d'; // 30-day rolling sessions
const COOKIE_NAME = 'mxi_session';

// ── Password ──────────────────────────────────────────────────────────────
async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// ── Token ─────────────────────────────────────────────────────────────────
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// ── Cookie helpers ────────────────────────────────────────────────────────
function setCookie(res, token) {
  const maxAge = 60 * 60 * 24 * 30; // 30 days in seconds
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`
  );
}

function clearCookie(res) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
  );
}

function getTokenFromRequest(req) {
  // Check cookie first, then Authorization header as fallback
  const cookies = parseCookies(req.headers.cookie || '');
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function parseCookies(cookieHeader) {
  return Object.fromEntries(
    cookieHeader.split(';').map(c => {
      const idx = c.indexOf('=');
      if (idx === -1) return [c.trim(), ''];
      return [decodeURIComponent(c.slice(0, idx).trim()), decodeURIComponent(c.slice(idx + 1).trim())];
    })
  );
}

// ── Middleware-style auth check ───────────────────────────────────────────
// Usage: const user = requireAuth(req, res); if (!user) return;
function requireAuth(req, res) {
  const token = getTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ ok: false, error: 'Not authenticated.' });
    return null;
  }
  const payload = verifyToken(token);
  if (!payload) {
    clearCookie(res);
    res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
    return null;
  }
  return payload; // { id, email, role, iat, exp }
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  setCookie,
  clearCookie,
  getTokenFromRequest,
  requireAuth,
  COOKIE_NAME
};
