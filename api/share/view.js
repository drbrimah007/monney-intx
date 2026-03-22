// GET /api/share/view?t=TOKEN
// Public — no auth required
// Returns limited public entry data

const { sql } = require('../../lib/db');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const token = req.query.t;
  if (!token) return res.status(400).json({ ok: false, error: 'Token required' });

  try {
    const rows = await sql`
      SELECT entry_data, acknowledged, acknowledged_at, created_at
      FROM share_tokens WHERE token = ${token} LIMIT 1
    `;

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Link not found or expired.' });
    }

    const row = rows[0];
    return res.json({
      ok: true,
      entry: row.entry_data,
      acknowledged: row.acknowledged,
      acknowledgedAt: row.acknowledged_at,
      sharedAt: row.created_at
    });

  } catch (e) {
    console.error('[share/view]', e.message);
    return res.status(500).json({ ok: false, error: 'Failed to load record.' });
  }
};
