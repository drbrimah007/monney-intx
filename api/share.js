// /api/share — consolidated share handler
//
// GET  ?t=TOKEN              → view entry (public)
// POST { action:'create', entryId, … } → create/get share link (auth required)
// POST { action:'acknowledge', token } → mark acknowledged (public)

const { sql }         = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const crypto          = require('crypto');

const ENSURE_TABLE = sql`
  CREATE TABLE IF NOT EXISTS share_tokens (
    token            TEXT        PRIMARY KEY,
    user_id          UUID        NOT NULL,
    entry_id         TEXT        NOT NULL,
    entry_data       JSONB       NOT NULL,
    acknowledged     BOOLEAN     NOT NULL DEFAULT false,
    acknowledged_at  TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: public view ──────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const token = req.query.t;
    if (!token) return res.status(400).json({ ok: false, error: 'Token required' });

    try {
      await ENSURE_TABLE;
      const rows = await sql`
        SELECT entry_data, acknowledged, acknowledged_at, created_at
        FROM share_tokens WHERE token = ${token} LIMIT 1
      `;
      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Link not found or expired.' });
      }
      const row = rows[0];
      return res.json({
        ok: true,
        entry: row.entry_data,
        acknowledged: row.acknowledged,
        acknowledgedAt: row.acknowledged_at,
        sharedAt: row.created_at
      });
    } catch (e) {
      console.error('[share/view]', e.message);
      return res.status(500).json({ ok: false, error: 'Failed to load record.' });
    }
  }

  // ── POST: create or acknowledge ───────────────────────────────────────────
  if (req.method === 'POST') {
    const { action } = req.body || {};

    // ── acknowledge (public) ────────────────────────────────────────────────
    if (action === 'acknowledge') {
      const { token } = req.body;
      if (!token) return res.status(400).json({ ok: false, error: 'Token required' });

      try {
        await ENSURE_TABLE;
        const result = await sql`
          UPDATE share_tokens
          SET acknowledged = true, acknowledged_at = now()
          WHERE token = ${token} AND acknowledged = false
          RETURNING entry_id
        `;
        if (result.length === 0) {
          return res.json({ ok: true, alreadyAcknowledged: true });
        }
        return res.json({ ok: true, acknowledged: true });
      } catch (e) {
        console.error('[share/acknowledge]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to acknowledge.' });
      }
    }

    // ── create (auth required) ──────────────────────────────────────────────
    if (action === 'create') {
      const payload = requireAuth(req, res);
      if (!payload) return;

      const { entryId, contactName, fromName, fromEmail, txType, amount, date,
              note, invoiceNumber, status, appName, siteUrl, tagline } = req.body;

      if (!entryId) return res.status(400).json({ ok: false, error: 'entryId required' });

      try {
        await ENSURE_TABLE;

        // Return existing token if available
        const existing = await sql`
          SELECT token FROM share_tokens WHERE entry_id = ${entryId} AND user_id = ${payload.id} LIMIT 1
        `;
        if (existing.length > 0) {
          const token = existing[0].token;
          const base  = siteUrl || 'https://moneyinteractions.com';
          return res.json({ ok: true, token, shareUrl: `${base}/view?t=${token}` });
        }

        const token = crypto.randomBytes(18).toString('base64url');
        const entryData = {
          entryId, contactName, fromName, fromEmail: fromEmail || '',
          txType, amount, date, note: note || '',
          invoiceNumber: invoiceNumber || null,
          status: status || 'posted',
          appName: appName || 'Money Intx',
          siteUrl: siteUrl || 'https://moneyinteractions.com',
          tagline: tagline || 'Making Money Matters Memorable',
          sharedAt: Date.now()
        };

        await sql`
          INSERT INTO share_tokens (token, user_id, entry_id, entry_data)
          VALUES (${token}, ${payload.id}, ${entryId}, ${entryData})
        `;

        const base = siteUrl || 'https://moneyinteractions.com';
        return res.json({ ok: true, token, shareUrl: `${base}/view?t=${token}` });

      } catch (e) {
        console.error('[share/create]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to create share link.' });
      }
    }

    return res.status(400).json({ ok: false, error: 'Invalid action. Use create or acknowledge.' });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
