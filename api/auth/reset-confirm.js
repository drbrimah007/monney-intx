// POST /api/auth/reset-confirm
// Body: { token, password }
// Validates token, updates password, clears token.

const { sql }          = require('../../lib/db');
const { hashPassword } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { token, password } = req.body || {};
    if (!token)               return res.status(400).json({ ok: false, error: 'Reset token is required.' });
    if (!password || password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });

    const [reset] = await sql`
      SELECT id, user_id, expires_at, used FROM password_resets
      WHERE token = ${token} LIMIT 1
    `;

    if (!reset)            return res.status(400).json({ ok: false, error: 'Invalid or expired reset link.' });
    if (reset.used)        return res.status(400).json({ ok: false, error: 'This reset link has already been used.' });
    if (new Date() > new Date(reset.expires_at)) {
      return res.status(400).json({ ok: false, error: 'This reset link has expired. Please request a new one.' });
    }

    const passwordHash = await hashPassword(password);

    await sql`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${reset.user_id}`;
    await sql`UPDATE password_resets SET used = true WHERE id = ${reset.id}`;

    return res.json({ ok: true, message: 'Password updated. You can now log in.' });
  } catch (e) {
    console.error('[reset-confirm]', e.message);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
};
