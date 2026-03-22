// /api/share — consolidated share handler
//
// GET  ?t=TOKEN              → view entry (public)
// GET  ?linked=1             → list entries shared with current user (auth)
// POST { action:'create', entryId, … } → create/get share link (auth)
// POST { action:'acknowledge', token } → mark acknowledged (public)
// POST { action:'link', token }        → link token to current user's account (auth)

const { sql }         = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const crypto          = require('crypto');

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS share_tokens (
      token            TEXT        PRIMARY KEY,
      user_id          UUID        NOT NULL,
      entry_id         TEXT        NOT NULL,
      entry_data       JSONB       NOT NULL,
      acknowledged     BOOLEAN     NOT NULL DEFAULT false,
      acknowledged_at  TIMESTAMPTZ,
      linked_user_id   UUID,
      linked_at        TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  // Migration: add columns if the table already existed without them
  await sql`ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS linked_user_id UUID`;
  await sql`ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS linked_at TIMESTAMPTZ`;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {

    // GET ?linked=1 — return all records shared with the current user (auth)
    if (req.query.linked) {
      const payload = requireAuth(req, res);
      if (!payload) return;
      try {
        await ensureTable();
        const rows = await sql`
          SELECT token, entry_data, acknowledged, acknowledged_at, linked_at, created_at
          FROM share_tokens
          WHERE linked_user_id = ${payload.id}
          ORDER BY linked_at DESC NULLS LAST
        `;
        return res.json({ ok: true, shared: rows.map(r => ({
          token:          r.token,
          entry:          r.entry_data,
          acknowledged:   r.acknowledged,
          acknowledgedAt: r.acknowledged_at,
          linkedAt:       r.linked_at,
          sharedAt:       r.created_at
        }))});
      } catch (e) {
        console.error('[share/linked]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to load shared records.' });
      }
    }

    // GET ?t=TOKEN — public view
    const token = req.query.t;
    if (!token) return res.status(400).json({ ok: false, error: 'Token required' });
    try {
      await ensureTable();
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
        entry:          row.entry_data,
        acknowledged:   row.acknowledged,
        acknowledgedAt: row.acknowledged_at,
        sharedAt:       row.created_at
      });
    } catch (e) {
      console.error('[share/view]', e.message);
      return res.status(500).json({ ok: false, error: 'Failed to load record.' });
    }
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action } = req.body || {};

    // ── acknowledge (public) ────────────────────────────────────────────────
    if (action === 'acknowledge') {
      const { token } = req.body;
      if (!token) return res.status(400).json({ ok: false, error: 'Token required' });
      try {
        await ensureTable();
        const result = await sql`
          UPDATE share_tokens
          SET acknowledged = true, acknowledged_at = now()
          WHERE token = ${token} AND acknowledged = false
          RETURNING entry_id
        `;
        return res.json({ ok: true, acknowledged: true, alreadyAcknowledged: result.length === 0 });
      } catch (e) {
        console.error('[share/acknowledge]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to acknowledge.' });
      }
    }

    // ── link token to current user (auth required) ──────────────────────────
    if (action === 'link') {
      const payload = requireAuth(req, res);
      if (!payload) return;
      const { token } = req.body;
      if (!token) return res.status(400).json({ ok: false, error: 'Token required' });
      try {
        await ensureTable();
        // Don't link if the token belongs to this same user (they sent it to themselves)
        const rows = await sql`
          SELECT user_id, entry_data FROM share_tokens WHERE token = ${token} LIMIT 1
        `;
        if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Token not found.' });
        if (rows[0].user_id === payload.id) {
          // Same person — return the entry data but don't create a link
          return res.json({ ok: true, selfLink: true, entry: rows[0].entry_data });
        }
        await sql`
          UPDATE share_tokens
          SET linked_user_id = ${payload.id}, linked_at = now()
          WHERE token = ${token} AND (linked_user_id IS NULL OR linked_user_id = ${payload.id})
        `;
        return res.json({ ok: true, linked: true, entry: rows[0].entry_data });
      } catch (e) {
        console.error('[share/link]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to link record.' });
      }
    }

    // ── create share token (auth required) ──────────────────────────────────
    if (action === 'create') {
      const payload = requireAuth(req, res);
      if (!payload) return;
      const { entryId, contactName, fromName, fromEmail, txType, amount, date,
              note, invoiceNumber, status, appName, siteUrl, tagline } = req.body;
      if (!entryId) return res.status(400).json({ ok: false, error: 'entryId required' });
      try {
        await ensureTable();
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

    return res.status(400).json({ ok: false, error: 'Invalid action.' });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
