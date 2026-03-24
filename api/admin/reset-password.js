// POST /api/admin/reset-password
// Admin-only: reset a user's password
// Body: { userId, newPassword }

const { sql }                        = require('../../lib/db');
const { requireAuth, hashPassword }  = require('../../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;
  if (payload.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin only.' });

  const { userId, newPassword } = req.body || {};
  if (!userId || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: 'userId and newPassword (min 6 chars) required.' });
  }

  try {
    const hash = await hashPassword(newPassword);
    await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${userId}`;
    return res.json({ ok: true, message: 'Password reset.' });
  } catch (e) {
    console.error('[admin/reset-password]', e.message);
    return res.status(500).json({ ok: false, error: 'Failed to reset password.' });
  }
};
