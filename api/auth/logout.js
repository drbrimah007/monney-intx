// POST /api/auth/logout
// Clears the session cookie. No body needed.

const { clearCookie } = require('../../lib/auth');

module.exports = function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  clearCookie(res);
  return res.json({ ok: true });
};
