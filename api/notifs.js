// GET /api/notifs?since=<timestamp>
// Lightweight endpoint that returns only notifications newer than `since`.
// Avoids fetching the entire user data blob just to check for new notifs.

const { sql }         = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const zlib            = require('zlib');
const { promisify }   = require('util');
const gunzip          = promisify(zlib.gunzip);

async function maybeDecompress(raw) {
  if (raw && raw._c === 1 && typeof raw.v === 'string') {
    try {
      const buf  = Buffer.from(raw.v, 'base64');
      const json = await gunzip(buf);
      return JSON.parse(json.toString('utf8'));
    } catch (e) { return raw; }
  }
  return raw;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  const since = parseInt(req.query.since) || 0;

  try {
    const [row] = await sql`SELECT data FROM user_data WHERE user_id = ${payload.id} LIMIT 1`;
    if (!row) return res.json({ ok: true, notifs: [], count: 0 });

    const data = await maybeDecompress(row.data || {});
    const allNotifs = (data.notifs || []).filter(n => n.userId === payload.id);
    const newNotifs = since > 0 ? allNotifs.filter(n => (n.createdAt || 0) > since) : allNotifs;
    const unreadCount = allNotifs.filter(n => !n.read).length;

    return res.json({ ok: true, notifs: newNotifs, count: unreadCount });
  } catch (e) {
    console.error('[notifs]', e.message);
    return res.status(500).json({ ok: false, error: 'Failed to load notifications.' });
  }
};
