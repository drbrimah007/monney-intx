// POST /api/auth/reset-request
// Body: { email }
// Generates a reset token and sends it via email.

const { sql }                  = require('../../lib/db');
const { sendPasswordReset }    = require('../../lib/email');
const crypto                   = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { email } = req.body || {};
    if (!email?.trim()) return res.status(400).json({ ok: false, error: 'Email is required.' });

    // Always respond the same way to avoid email enumeration
    const successMsg = 'If that email is registered, a reset link has been sent.';

    const [user] = await sql`
      SELECT id, display_name, email FROM users
      WHERE email = ${email.trim().toLowerCase()} AND status = 'active' LIMIT 1
    `;
    if (!user) return res.json({ ok: true, message: successMsg });

    // Clean up old tokens
    await sql`DELETE FROM password_resets WHERE user_id = ${user.id}`;

    // Generate token
    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await sql`
      INSERT INTO password_resets (user_id, token, expires_at)
      VALUES (${user.id}, ${token}, ${expiresAt})
    `;

    const baseUrl  = process.env.APP_URL || 'https://moneyintx.vercel.app';
    const resetUrl = `${baseUrl}/reset-password?token=${token}`;

    await sendPasswordReset({ to: user.email, displayName: user.display_name, resetUrl });

    return res.json({ ok: true, message: successMsg });
  } catch (e) {
    console.error('[reset-request]', e.message);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
};
