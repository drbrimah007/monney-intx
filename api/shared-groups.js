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

      // Find if any contact in this blob points to me (by linkedUserId, email, or boolean true + email match)
      const myContactIds = contacts
        .filter(c => {
          // Direct ID match
          if (c.linkedUserId && c.linkedUserId !== true && c.linkedUserId === me.id) return true;
          // Email match (handles linkedUserId=true bug and unlinked contacts)
          if (me.email && c.email && c.email.toLowerCase() === me.email.toLowerCase()) return true;
          return false;
        })
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

  } else if (req.method === 'POST') {
    // POST: Push a notification to another user's blob
    const payload = requireAuth(req, res);
    if (!payload) return;

    const { targetEmail, notification } = req.body || {};
    if (!targetEmail || !notification) {
      return res.status(400).json({ ok: false, error: 'targetEmail and notification required.' });
    }

    try {
      // Find target user by email
      const [targetUser] = await sql`SELECT id FROM users WHERE LOWER(email) = ${targetEmail.toLowerCase()} LIMIT 1`;
      if (!targetUser) return res.json({ ok: true, delivered: false, reason: 'User not found.' });

      // Load their blob and push notification
      const [row] = await sql`SELECT data FROM user_data WHERE user_id = ${targetUser.id} LIMIT 1`;
      if (!row) return res.json({ ok: true, delivered: false, reason: 'No user data.' });

      const data = await maybeDecompress(row.data || {});
      if (!data.notifs) data.notifs = [];
      notification.userId = targetUser.id; // Ensure correct userId
      data.notifs.push(notification);

      // Compress and save
      const zlib = require('zlib');
      const gzip = require('util').promisify(zlib.gzip);
      const json = JSON.stringify(data);
      const buf = await gzip(Buffer.from(json, 'utf8'));
      const compressed = { _c: 1, v: buf.toString('base64') };
      await sql`UPDATE user_data SET data = ${compressed}, updated_at = now() WHERE user_id = ${targetUser.id}`;

      return res.json({ ok: true, delivered: true });
    } catch (e) {
      console.error('[shared-groups/POST]', e.message);
      return res.status(500).json({ ok: false, error: 'Failed to deliver notification.' });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
};
