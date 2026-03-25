// GET /api/admin/user-data?userId=<id>
// Admin-only: returns the full data blob for any user.
// Used by the impersonation feature so the admin sees the real user's data.

const { sql }         = require('../../lib/db');
const { requireAuth } = require('../../lib/auth');
const zlib            = require('zlib');
const { promisify }   = require('util');
const gunzip          = promisify(zlib.gunzip);

// Decompress blob if stored compressed by sync.js ({ _c:1, v:"<base64>" })
async function maybeDecompress(raw) {
  if (raw && raw._c === 1 && typeof raw.v === 'string') {
    try {
      const buf  = Buffer.from(raw.v, 'base64');
      const json = await gunzip(buf);
      return JSON.parse(json.toString('utf8'));
    } catch (e) {
      console.error('[admin/user-data] decompress failed:', e.message);
      return {};
    }
  }
  return raw; // already plain JSON (legacy uncompressed rows)
}

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

    // Decompress the blob before returning — same as /api/data/load does
    const data = await maybeDecompress(row?.data || {});

    // Also fetch confirmed share tokens linked to this user so admin
    // impersonation can display and migrate the user's incoming shared records.
    const shareRows = await sql`
      SELECT token, confirmed, recipient_closed, shared_at, entry_data
      FROM share_tokens
      WHERE linked_user_id = ${userId}
        AND confirmed = true
        AND (recipient_closed IS NULL OR recipient_closed = false)
      ORDER BY shared_at DESC
      LIMIT 100
    `;
    const sharedRecords = shareRows.map(r => ({
      token:           r.token,
      confirmed:       r.confirmed,
      recipientClosed: r.recipient_closed || false,
      sharedAt:        r.shared_at,
      entry:           r.entry_data || {}
    }));

    return res.json({
      ok: true,
      data,
      user: {
        id: user.id,
        displayName: user.display_name,
        email: user.email,
        username: user.username,
        role: user.role
      },
      sharedRecords
    });
  } catch (e) {
    console.error('[admin/user-data]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
