// GET /api/data/freshness
// Lightweight endpoint: returns only the updated_at timestamp of the user's blob.
// Client polls this to detect when another device has saved newer data.
// No blob decompression — fast and cheap.

const { sql }         = require('../../lib/db');
const { requireAuth } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  try {
    const [row] = await sql`
      SELECT updated_at FROM user_data WHERE user_id = ${payload.id} LIMIT 1
    `;
    const updatedAt = row?.updated_at ? new Date(row.updated_at).getTime() : 0;
    return res.json({ ok: true, updatedAt });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Failed.' });
  }
};
