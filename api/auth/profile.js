// POST /api/auth/profile
// Updates the authenticated user's profile in the users table.
// Body: { displayName, username, email, phone, address }

const { sql }         = require('../../lib/db');
const { requireAuth } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  try {
    const { displayName, username, email } = req.body || {};

    if (!displayName?.trim()) return res.status(400).json({ ok: false, error: 'Display name is required.' });
    if (!email?.trim() || !email.includes('@')) return res.status(400).json({ ok: false, error: 'A valid email is required.' });

    const emailClean = email.trim().toLowerCase();
    const nameClean  = displayName.trim();
    const userClean  = username ? username.trim().replace(/\s+/g, '_').toLowerCase() : null;

    // Check for duplicate email (excluding self)
    const dupEmail = await sql`SELECT id FROM users WHERE email = ${emailClean} AND id != ${payload.id} LIMIT 1`;
    if (dupEmail.length > 0) return res.status(409).json({ ok: false, error: 'Email already in use by another account.' });

    // Check for duplicate username (excluding self)
    if (userClean) {
      const dupUser = await sql`SELECT id FROM users WHERE username = ${userClean} AND id != ${payload.id} LIMIT 1`;
      if (dupUser.length > 0) return res.status(409).json({ ok: false, error: 'Username already taken.' });
    }

    // Update the users table
    if (userClean) {
      await sql`
        UPDATE users SET display_name = ${nameClean}, username = ${userClean}, email = ${emailClean}
        WHERE id = ${payload.id}
      `;
    } else {
      await sql`
        UPDATE users SET display_name = ${nameClean}, email = ${emailClean}
        WHERE id = ${payload.id}
      `;
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('[profile]', e.message);
    return res.status(500).json({ ok: false, error: 'Failed to update profile.' });
  }
};
