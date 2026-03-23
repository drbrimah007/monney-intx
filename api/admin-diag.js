// GET /api/admin-diag
// Admin-only diagnostic endpoint.
// Returns all users from the users table AND all user_data blobs,
// with cross-reference to detect duplicates or key mismatches.
// TEMPORARY — remove after diagnosis.

const { sql }         = require('../lib/db');
const { requireAuth } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;
  if (payload.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin only.' });

  try {
    // ALL users from the users table
    const users = await sql`
      SELECT id, display_name, email, username, role, status, created_at
      FROM users ORDER BY created_at ASC
    `;

    // ALL data blobs
    const blobs = await sql`
      SELECT ud.user_id,
             length(ud.data::text) as blob_size,
             ud.updated_at,
             ud.data->>'settings' as settings_raw,
             (ud.data->'entries') as entries,
             jsonb_array_length(COALESCE(ud.data->'entries', '[]'::jsonb)) as entry_count,
             jsonb_array_length(COALESCE(ud.data->'contacts', '[]'::jsonb)) as contact_count,
             jsonb_array_length(COALESCE(ud.data->'templates', '[]'::jsonb)) as template_count,
             ud.data->'settings'->>'sessionUserId' as blob_session_user_id
      FROM user_data ud
      ORDER BY ud.updated_at DESC
    `;

    // Build cross-reference
    const blobMap = {};
    blobs.forEach(b => { blobMap[b.user_id] = b; });

    const crossRef = users.map(u => {
      const blob = blobMap[u.id];
      return {
        // From users table
        userId:    u.id,
        name:      u.display_name,
        email:     u.email,
        username:  u.username,
        role:      u.role,
        status:    u.status,
        createdAt: u.created_at,
        // Blob info
        hasBlob:        !!blob,
        blobSize:       blob?.blob_size || 0,
        blobUpdated:    blob?.updated_at || null,
        entryCount:     blob?.entry_count || 0,
        contactCount:   blob?.contact_count || 0,
        templateCount:  blob?.template_count || 0,
        blobSessionId:  blob?.blob_session_user_id || null,
        // Key match check
        blobKeyMatch:   blob ? (blob.user_id === u.id) : null,
        sessionIdMatch: blob ? (blob.blob_session_user_id === u.id) : null
      };
    });

    // Also check for emails that appear more than once (duplicate detection)
    const emailCounts = {};
    users.forEach(u => { emailCounts[u.email] = (emailCounts[u.email] || 0) + 1; });
    const duplicateEmails = Object.entries(emailCounts).filter(([,c]) => c > 1).map(([e]) => e);

    return res.json({
      ok: true,
      totalUsers: users.length,
      totalBlobs: blobs.length,
      duplicateEmails,
      users: crossRef
    });
  } catch (e) {
    console.error('[admin-diag]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
