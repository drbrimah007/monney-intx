// POST /api/share/create
// Body: { entryId, contactName, fromName, fromEmail, txType, amount, date, note, invoiceNumber, status, appName, siteUrl }
// Returns: { ok, token, shareUrl }

const { sql }         = require('../../lib/db');
const { requireAuth } = require('../../lib/auth');
const crypto          = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  const { entryId, contactName, fromName, fromEmail, txType, amount, date,
          note, invoiceNumber, status, appName, siteUrl, tagline } = req.body || {};

  if (!entryId) return res.status(400).json({ ok: false, error: 'entryId required' });

  try {
    // Ensure share_tokens table exists
    await sql`
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

    // Check if a token already exists for this entry+user
    const existing = await sql`
      SELECT token FROM share_tokens WHERE entry_id = ${entryId} AND user_id = ${payload.id} LIMIT 1
    `;
    if (existing.length > 0) {
      const token = existing[0].token;
      const base  = siteUrl || 'https://moneyinteractions.com';
      return res.json({ ok: true, token, shareUrl: `${base}/view?t=${token}` });
    }

    // Generate a new token
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
};
