// /api/templates — public template DB
//
// GET  (no auth required) → return all public templates from all users
// POST { action:'publish',   templateId } (auth) → mark template public
// POST { action:'unpublish', templateId } (auth) → mark template private

const { sql }         = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const zlib            = require('zlib');
const { promisify }   = require('util');
const gunzip          = promisify(zlib.gunzip);
const gzip            = promisify(zlib.gzip);

// User data blobs are gzip-compressed by /api/data/sync as { _c:1, v:"<base64>" }.
// We must decompress before reading and re-compress before writing.
async function maybeDecompress(raw) {
  if (raw && raw._c === 1 && typeof raw.v === 'string') {
    try {
      const buf  = Buffer.from(raw.v, 'base64');
      const json = await gunzip(buf);
      return JSON.parse(json.toString('utf8'));
    } catch (e) {
      console.error('[templates] decompress failed:', e.message);
      return {};
    }
  }
  return raw || {}; // legacy uncompressed row
}

async function recompress(obj) {
  const json       = JSON.stringify(obj);
  const compressed = await gzip(Buffer.from(json, 'utf8'));
  return { _c: 1, v: compressed.toString('base64') };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET — public listing (no auth needed) ─────────────────────────────────
  if (req.method === 'GET') {
    try {
      // Query all user blobs and extract public, non-archived templates
      const rows = await sql`SELECT user_id, data FROM user_data`;
      const results = [];
      for (const row of rows) {
        // Decompress the blob — stored as { _c:1, v:"<base64>" } by sync.js
        const data      = await maybeDecompress(row.data);
        const templates = data.templates || [];
        for (const t of templates) {
          if (t.isPublic && !t.archived) {
            results.push({
              id:          t.id,
              name:        t.name        || '',
              desc:        t.desc        || '',
              txType:      t.txType      || '',
              fields:      t.fields      || [],
              creatorName: t.creatorName || '',
              createdAt:   t.createdAt   || 0,
              copiedFrom:  t.copiedFrom  || null,
              userId:      row.user_id
            });
          }
        }
      }
      // Sort newest first
      results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return res.json({ ok: true, templates: results });
    } catch (e) {
      console.error('[templates/GET]', e.message);
      return res.status(500).json({ ok: false, error: 'Failed to load templates.' });
    }
  }

  // ── POST — publish / unpublish (auth required) ────────────────────────────
  if (req.method === 'POST') {
    const payload = requireAuth(req, res);
    if (!payload) return;

    const { action, templateId } = req.body || {};
    if (!templateId) return res.status(400).json({ ok: false, error: 'templateId required' });

    try {
      const [blobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${payload.id} LIMIT 1`;
      if (!blobRow) return res.status(404).json({ ok: false, error: 'User data not found.' });

      // Decompress the blob before modifying
      const data = await maybeDecompress(blobRow.data);
      const tpl  = (data.templates || []).find(t => t.id === templateId);
      if (!tpl) return res.status(404).json({ ok: false, error: 'Template not found.' });

      if (action === 'publish') {
        tpl.isPublic    = true;
        // JWT payload has no displayName — look it up from the users table
        if (!tpl.creatorName) {
          const [_cr] = await sql`SELECT display_name FROM users WHERE id = ${payload.id} LIMIT 1`;
          tpl.creatorName = _cr?.display_name || payload.email || 'Anonymous';
        }
      } else if (action === 'unpublish') {
        tpl.isPublic = false;
      } else {
        return res.status(400).json({ ok: false, error: 'Invalid action.' });
      }

      // Re-compress before saving so we don't break the compressed format
      const envelope = await recompress(data);
      await sql`UPDATE user_data SET data = ${envelope}, updated_at = now() WHERE user_id = ${payload.id}`;
      return res.json({ ok: true, isPublic: tpl.isPublic });
    } catch (e) {
      console.error('[templates/POST]', e.message);
      return res.status(500).json({ ok: false, error: 'Failed to update template.' });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
