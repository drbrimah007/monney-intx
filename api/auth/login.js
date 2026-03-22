// POST /api/auth/login
// Body: { email, password }  (email can be username or email address)
// Returns { ok, user } and sets session cookie

const { sql }                                      = require('../../lib/db');
const { verifyPassword, signToken, setCookie }     = require('../../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { email, password } = req.body || {};
    if (!email?.trim() || !password) return res.status(400).json({ ok: false, error: 'Email and password are required.' });

    const identifier = email.trim().toLowerCase();

    // Lookup by email OR username
    const [user] = await sql`
      SELECT id, display_name, email, username, password_hash, role, status
      FROM users
      WHERE (email = ${identifier} OR username = ${identifier})
        AND status = 'active'
      LIMIT 1
    `;

    if (!user) return res.status(401).json({ ok: false, error: 'Invalid email or password.' });

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: 'Invalid email or password.' });

    const token = signToken({ id: user.id, email: user.email, role: user.role });
    setCookie(res, token);

    return res.json({
      ok: true,
      user: { id: user.id, displayName: user.display_name, email: user.email, role: user.role }
    });
  } catch (e) {
    console.error('[login]', e.message);
    return res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
};
