// GET /api/admin-diag?userId=<id>
// Admin-only endpoint to inspect a specific user's data blob for diagnostics.
// Returns blob size, entry count, contact count, and last updated timestamp.
// TEMPORARY — remove after diagnosis.

const { sql }         = require('../lib/db');
const { requireAuth } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;
  if (payload.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin only.' });

  try {
    // List ALL user blobs with sizes
    const blobs = await sql`
      SELECT ud.user_id, u.display_name, u.email,
             length(ud.data::text) as blob_size,
             ud.updated_at,
             ud.data
      FROM user_data ud
      LEFT JOIN users u ON u.id = ud.user_id
      ORDER BY ud.updated_at DESC
    `;

    const result = blobs.map(row => {
      const d = row.data || {};
      return {
        userId:    row.user_id,
        name:      row.display_name,
        email:     row.email,
        blobSize:  row.blob_size,
        updatedAt: row.updated_at,
        entries:   d.entries?.length || 0,
        contacts:  d.contacts?.length || 0,
        templates: d.templates?.length || 0,
        settings_sessionUserId: d.settings?.sessionUserId || null
      };
    });

    return res.json({ ok: true, blobs: result });
  } catch (e) {
    console.error('[admin-diag]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
