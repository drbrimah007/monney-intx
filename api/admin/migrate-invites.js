// GET /api/admin/migrate-invites — one-time migration to create invite_tokens table
// Admin-only endpoint.

const { sql }         = require('../../lib/db');
const { requireAuth } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;
  if (payload.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin only.' });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS invite_tokens (
        token            TEXT        PRIMARY KEY,
        inviter_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        inviter_contact_id TEXT,
        email            TEXT        NOT NULL,
        name             TEXT,
        status           TEXT        DEFAULT 'pending',
        created_at       TIMESTAMPTZ DEFAULT now(),
        accepted_at      TIMESTAMPTZ,
        accepted_by      UUID        REFERENCES users(id)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_invite_email   ON invite_tokens(lower(email))`;
    await sql`CREATE INDEX IF NOT EXISTS idx_invite_inviter ON invite_tokens(inviter_id)`;

    return res.json({ ok: true, message: 'invite_tokens table created successfully.' });
  } catch (e) {
    console.error('[migrate-invites]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
