// GET /api/shared-groups
// Returns groups and investments from OTHER users' blobs where the current user is a member.
// Matches by contact.linkedUserId or contact.email.

const { sql }         = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const zlib            = require('zlib');
const { promisify }   = require('util');
const gunzip          = promisify(zlib.gunzip);

async function maybeDecompress(raw) {
  if (raw && raw._c === 1 && typeof raw.v === 'string') {
    try {
      const buf = Buffer.from(raw.v, 'base64');
      const json = await gunzip(buf);
      return JSON.parse(json.toString('utf8'));
    } catch (e) { return raw; }
  }
  return raw;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  try {
    // Get current user's info
    const [me] = await sql`SELECT id, email FROM users WHERE id = ${payload.id} LIMIT 1`;
    if (!me) return res.json({ ok: true, groups: [], investments: [] });

    // Find all contacts that link to this user (by linkedUserId or email)
    // These are contacts in OTHER users' blobs that represent "me"
    const allBlobs = await sql`SELECT user_id, data FROM user_data WHERE user_id != ${me.id}`;

    const sharedGroups = [];
    const sharedInvestments = [];

    for (const row of allBlobs) {
      const data = await maybeDecompress(row.data || {});
      const contacts = data.contacts || [];

      // Find if any contact in this blob points to me
      const myContactIds = contacts
        .filter(c => c.linkedUserId === me.id || (me.email && (c.email || '').toLowerCase() === me.email.toLowerCase()))
        .map(c => c.id);

      if (myContactIds.length === 0) continue;

      // Check groups where I'm a member (by contactId matching)
      const groups = data.groups || [];
      for (const g of groups) {
        const isMember = (g.members || []).some(m => myContactIds.includes(m.contactId));
        if (isMember) {
          sharedGroups.push({
            ...g,
            _ownerUserId: row.user_id,
            _shared: true
          });
        }
      }

      // Check investments where I'm a member
      const investments = data.investments || [];
      for (const inv of investments) {
        const isMember = (inv.members || []).some(m => myContactIds.includes(m.contactId));
        if (isMember) {
          sharedInvestments.push({
            ...inv,
            _ownerUserId: row.user_id,
            _shared: true
          });
        }
      }
    }

    return res.json({ ok: true, groups: sharedGroups, investments: sharedInvestments });
  } catch (e) {
    console.error('[shared-groups]', e.message);
    return res.status(500).json({ ok: false, error: 'Failed to load shared groups.' });
  }
};
