// GET /api/data/load
// Returns the authenticated user's full data blob.
// Frontend calls this on login to populate its in-memory db.

const { sql }         = require('../../lib/db');
const { requireAuth } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  try {
    const [row] = await sql`
      SELECT data FROM user_data WHERE user_id = ${payload.id} LIMIT 1
    `;

    // Also grab the user's profile fields to merge in
    const [user] = await sql`
      SELECT id, display_name, email, username, role, status
      FROM users WHERE id = ${payload.id} LIMIT 1
    `;

    const data = row?.data || {};

    return res.json({ ok: true, data, user: {
      id: user.id,
      displayName: user.display_name,
      email: user.email,
      username: user.username,
      role: user.role
    }});
  } catch (e) {
    console.error('[data/load]', e.message);
    return res.status(500).json({ ok: false, error: 'Failed to load data.' });
  }
};
