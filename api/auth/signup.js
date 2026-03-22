// POST /api/auth/signup
// Body: { displayName, email, password }
// Creates account, sets session cookie, returns { ok, user }

const { sql }                             = require('../../lib/db');
const { hashPassword, signToken, setCookie } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { displayName, email, password } = req.body || {};

    // ── Validation ───────────────────────────────────────────────────────
    if (!displayName?.trim())                     return res.status(400).json({ ok: false, error: 'Name is required.' });
    if (!email?.trim() || !email.includes('@'))   return res.status(400).json({ ok: false, error: 'A valid email is required.' });
    if (!password || password.length < 6)         return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });

    const emailClean = email.trim().toLowerCase();
    const nameClean  = displayName.trim();
    const username   = emailClean.split('@')[0].replace(/[^a-z0-9_]/gi, '_').toLowerCase();

    // ── Check duplicate ──────────────────────────────────────────────────
    const existing = await sql`SELECT id FROM users WHERE email = ${emailClean} LIMIT 1`;
    if (existing.length > 0) return res.status(409).json({ ok: false, error: 'An account with that email already exists.' });

    // ── Create user ──────────────────────────────────────────────────────
    const passwordHash = await hashPassword(password);
    const [user] = await sql`
      INSERT INTO users (display_name, username, email, password_hash, role)
      VALUES (${nameClean}, ${username}, ${emailClean}, ${passwordHash}, 'standard')
      RETURNING id, display_name, email, role, created_at
    `;

    // ── Seed empty data blob ─────────────────────────────────────────────
    await sql`INSERT INTO user_data (user_id, data) VALUES (${user.id}, '{}')`;

    // ── Issue session ────────────────────────────────────────────────────
    const token = signToken({ id: user.id, email: user.email, role: user.role });
    setCookie(res, token);

    return res.status(201).json({
      ok: true,
      user: { id: user.id, displayName: user.display_name, email: user.email, role: user.role }
    });
  } catch (e) {
    console.error('[signup]', e.message);
    return res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
};
