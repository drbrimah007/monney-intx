// POST /api/data/sync
// Body: { data: <full db object> }
// Saves the user's entire data blob server-side.
// Called by the frontend's save() function after every change.

const { sql }         = require('../../lib/db');
const { requireAuth } = require('../../lib/auth');

// Max blob size guard — 5 MB should be very generous for this app
const MAX_BYTES = 5 * 1024 * 1024;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  try {
    const { data } = req.body || {};
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ ok: false, error: 'data must be a JSON object.' });
    }

    // Size guard
    const json = JSON.stringify(data);
    if (json.length > MAX_BYTES) {
      return res.status(413).json({ ok: false, error: 'Data exceeds the 5 MB limit.' });
    }

    // Upsert — insert if first time, update otherwise
    await sql`
      INSERT INTO user_data (user_id, data, updated_at)
      VALUES (${payload.id}, ${data}, now())
      ON CONFLICT (user_id)
      DO UPDATE SET data = EXCLUDED.data, updated_at = now()
    `;

    return res.json({ ok: true, synced: true });
  } catch (e) {
    console.error('[data/sync]', e.message);
    return res.status(500).json({ ok: false, error: 'Failed to sync data.' });
  }
};
