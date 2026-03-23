// GET /api/ping — health check; tests DB connectivity
// Returns { ok, db, ts } — safe to call without authentication

const { sql } = require('../lib/db');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const ts = Date.now();
  try {
    await sql`SELECT 1`; // lightest possible query
    return res.json({ ok: true, db: 'connected', ts });
  } catch (e) {
    console.error('[ping] DB error:', e.message);
    return res.status(503).json({ ok: false, db: 'error', error: e.message, ts });
  }
};
