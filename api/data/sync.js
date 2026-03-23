// POST /api/data/sync
// Body: { data: <full db object> }
// Saves the user's entire data blob server-side.
// Data is gzip-compressed before storage to minimise Neon network transfer.

const { sql }          = require('../../lib/db');
const { requireAuth }  = require('../../lib/auth');
const zlib             = require('zlib');
const { promisify }    = require('util');
const gzip             = promisify(zlib.gzip);

// Max uncompressed blob size — 8 MB
const MAX_BYTES = 8 * 1024 * 1024;

// Prune the db object before saving to reduce blob size and network transfer.
// Keeps all functional data; trims unlimited-growth arrays.
function pruneForSync(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const db = { ...raw };

  // Keep only the last 500 audit log entries (they're append-only and grow forever)
  if (Array.isArray(db.audit) && db.audit.length > 500) {
    db.audit = db.audit.slice(-500);
  }

  // Strip heavy fields that are transient / re-derivable on load
  if (Array.isArray(db.entries)) {
    db.entries = db.entries.map(e => {
      // templateData: {} is the default — drop it to save bytes
      if (e.templateData && typeof e.templateData === 'object' && Object.keys(e.templateData).length === 0) {
        const { templateData, ...rest } = e;
        return rest;
      }
      return e;
    });
  }

  return db;
}

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

    // Prune transient / unlimited-growth data
    const pruned = pruneForSync(data);

    // Size guard (pre-compression)
    const json = JSON.stringify(pruned);
    if (json.length > MAX_BYTES) {
      return res.status(413).json({ ok: false, error: 'Data exceeds the 8 MB limit.' });
    }

    // Gzip-compress the JSON — typically 75-90% reduction for JSON blobs.
    // Stored as { _c: 1, v: "<base64>" } so load.js can detect and decompress.
    const compressed = await gzip(Buffer.from(json, 'utf8'));
    const envelope   = { _c: 1, v: compressed.toString('base64') };

    await sql`
      INSERT INTO user_data (user_id, data, updated_at)
      VALUES (${payload.id}, ${envelope}, now())
      ON CONFLICT (user_id)
      DO UPDATE SET data = EXCLUDED.data, updated_at = now()
    `;

    return res.json({ ok: true, synced: true, bytes: compressed.length });
  } catch (e) {
    console.error('[data/sync]', e.message);
    return res.status(500).json({ ok: false, error: 'Failed to sync data.' });
  }
};
