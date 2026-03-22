// POST /api/share/acknowledge
// Body: { token }
// Public — no auth required (recipient acknowledges the record)

const { sql } = require('../../lib/db');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const { token } = req.body || {};
  if (!token) return res.status(400).json({ ok: false, error: 'Token required' });

  try {
    const result = await sql`
      UPDATE share_tokens
      SET acknowledged = true, acknowledged_at = now()
      WHERE token = ${token} AND acknowledged = false
      RETURNING entry_id, user_id
    `;

    if (result.length === 0) {
      // Already acknowledged or not found — still return ok
      return res.json({ ok: true, alreadyAcknowledged: true });
    }

    return res.json({ ok: true, acknowledged: true });

  } catch (e) {
    console.error('[share/acknowledge]', e.message);
    return res.status(500).json({ ok: false, error: 'Failed to acknowledge.' });
  }
};
