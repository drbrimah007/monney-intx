// GET /api/auth/session
// Returns current authenticated user info, or 401.

const { sql }         = require('../../lib/db');
const { requireAuth } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return; // requireAuth already sent 401

  try {
    const [user] = await sql`
      SELECT id, display_name, email, username, role, status
      FROM users WHERE id = ${payload.id} AND status = 'active' LIMIT 1
    `;
    if (!user) return res.status(401).json({ ok: false, error: 'User not found.' });

    return res.json({
      ok: true,
      user: { id: user.id, displayName: user.display_name, email: user.email, username: user.username, role: user.role }
    });
  } catch (e) {
    console.error('[session]', e.message);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
};
