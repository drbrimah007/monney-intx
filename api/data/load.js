// GET /api/data/load
// Returns the authenticated user's full data blob.
// Frontend calls this on login to populate its in-memory db.
// Supports gzip-compressed blobs written by sync.js ({ _c:1, v:"<base64>" }).

const { sql }         = require('../../lib/db');
const { requireAuth } = require('../../lib/auth');
const zlib            = require('zlib');
const { promisify }   = require('util');
const gunzip          = promisify(zlib.gunzip);

// Decompress blob if it was stored compressed by sync.js
async function maybeDecompress(raw) {
  if (raw && raw._c === 1 && typeof raw.v === 'string') {
    try {
      const buf  = Buffer.from(raw.v, 'base64');
      const json = await gunzip(buf);
      return JSON.parse(json.toString('utf8'));
    } catch (e) {
      console.error('[load] decompress failed:', e.message);
      return {}; // safe fallback — frontend will recover from localStorage
    }
  }
  return raw; // already plain JSON (legacy rows written before compression)
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  // Prevent browser/CDN caching — data must always be fresh
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  try {
    const [row] = await sql`
      SELECT data, updated_at FROM user_data WHERE user_id = ${payload.id} LIMIT 1
    `;

    // Also grab the user's profile fields to merge in
    const [user] = await sql`
      SELECT id, display_name, email, username, role, status, created_at
      FROM users WHERE id = ${payload.id} LIMIT 1
    `;

    // Decompress if stored compressed; fall back to raw object for legacy rows
    const data = await maybeDecompress(row?.data || {});

    // For admin: return all registered users so admin panel stays in sync
    let allUsers = null;
    if (user.role === 'admin') {
      try {
        const userRows = await sql`
          SELECT id, display_name, email, username, role, status, created_at
          FROM users ORDER BY created_at ASC
        `;
        allUsers = userRows.map(u => ({
          id: u.id, displayName: u.display_name, email: u.email,
          username: u.username, role: u.role, status: u.status || 'active',
          createdAt: u.created_at ? new Date(u.created_at).getTime() : Date.now()
        }));
      } catch (_) { /* non-critical */ }
    }

    // For non-admin: fetch admin's branding so emails/headers use correct name
    let platformSettings = null;
    if (user.role !== 'admin') {
      try {
        const [adminRow] = await sql`
          SELECT d.data FROM user_data d
          JOIN users u ON u.id = d.user_id
          WHERE u.role = 'admin'
          ORDER BY u.created_at ASC LIMIT 1
        `;
        // Admin blob may also be compressed
        const adminData = await maybeDecompress(adminRow?.data || {});
        if (adminData?.settings) {
          const s = adminData.settings;
          platformSettings = {
            appName:  s.appName  || '',
            tagline:  s.tagline  || '',
            siteUrl:  s.siteUrl  || '',
            logoData: s.logoData || ''
          };
        }
      } catch (_) { /* non-critical */ }
    }

    const updatedAt = row?.updated_at ? new Date(row.updated_at).getTime() : 0;

    return res.json({
      ok: true, data, updatedAt,
      user: { id: user.id, displayName: user.display_name, email: user.email, username: user.username, role: user.role },
      ...(allUsers !== null ? { allUsers } : {}),
      ...(platformSettings ? { platformSettings } : {})
    });
  } catch (e) {
    console.error('[data/load]', e.message);
    return res.status(500).json({ ok: false, error: 'Failed to load data.' });
  }
};
