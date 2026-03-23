// GET /api/admin/user-data?userId=<id>
// Admin-only: returns the full data blob for any user.
// Used by the impersonation feature so the admin sees the real user's data.

const { sql }         = require('../../lib/db');
const { requireAuth } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;
  if (payload.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin only.' });

  const { userId } = req.query;
  if (!userId) return res.status(400).json({ ok: false, error: 'userId required.' });

  try {
    const [row] = await sql`
      SELECT data FROM user_data WHERE user_id = ${userId} LIMIT 1
    `;
    const [user] = await sql`
      SELECT id, display_name, email, username, role, status
      FROM users WHERE id = ${userId} LIMIT 1
    `;
    if (!user) return res.status(404).json({ ok: false, error: 'User not found.' });

    return res.json({
      ok: true,
      data: row?.data || {},
      user: {
        id: user.id,
        displayName: user.display_name,
        email: user.email,
        username: user.username,
        role: user.role
      }
    });
  } catch (e) {
    console.error('[admin/user-data]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
