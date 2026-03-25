// /api/shared-groups
// GET  — returns groups/investments from OTHER users' blobs where current user is a member
// POST — push a notification into another user's blob

const { sql }         = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const zlib            = require('zlib');
const { promisify }   = require('util');
const _gunzip         = promisify(zlib.gunzip);
const _gzip           = promisify(zlib.gzip);

async function decompress(raw) {
  if (raw && raw._c === 1 && typeof raw.v === 'string') {
    try {
      const buf = Buffer.from(raw.v, 'base64');
      const json = await _gunzip(buf);
      return JSON.parse(json.toString('utf8'));
    } catch (e) { return raw; }
  }
  return raw;
}

async function compress(data) {
  const json = JSON.stringify(data);
  const buf  = await _gzip(Buffer.from(json, 'utf8'));
  return { _c: 1, v: buf.toString('base64') };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;

  // ── GET: fetch shared groups/investments ────────────────────────────
  if (req.method === 'GET') {
    try {
      const [me] = await sql`SELECT id, email FROM users WHERE id = ${payload.id} LIMIT 1`;
      if (!me) return res.json({ ok: true, groups: [], investments: [] });

      const allBlobs = await sql`SELECT user_id, data FROM user_data WHERE user_id != ${me.id}`;
      const sharedGroups = [];
      const sharedInvestments = [];

      for (const row of allBlobs) {
        const data = await decompress(row.data || {});
        const contacts = data.contacts || [];

        // Find contacts in this blob that represent me
        const myContactIds = contacts
          .filter(c => {
            if (c.linkedUserId && c.linkedUserId !== true && c.linkedUserId === me.id) return true;
            if (me.email && c.email && c.email.toLowerCase() === me.email.toLowerCase()) return true;
            return false;
          })
          .map(c => c.id);

        if (myContactIds.length === 0) continue;

        for (const g of (data.groups || [])) {
          if ((g.members || []).some(m => myContactIds.includes(m.contactId))) {
            sharedGroups.push({ ...g, _ownerUserId: row.user_id, _shared: true });
          }
        }
        for (const inv of (data.investments || [])) {
          if ((inv.members || []).some(m => myContactIds.includes(m.contactId))) {
            sharedInvestments.push({ ...inv, _ownerUserId: row.user_id, _shared: true });
          }
        }
      }

      return res.json({ ok: true, groups: sharedGroups, investments: sharedInvestments });
    } catch (e) {
      console.error('[shared-groups/GET]', e.message);
      return res.status(500).json({ ok: false, error: 'Failed to load shared groups.' });
    }
  }

  // ── POST: push notification to another user's blob ──────────────────
  if (req.method === 'POST') {
    const { targetEmail, notification } = req.body || {};
    if (!targetEmail || !notification) {
      return res.status(400).json({ ok: false, error: 'targetEmail and notification required.' });
    }

    try {
      // Support lookup by userId or email
      let targetUser;
      if (targetEmail.startsWith('_byUserId:')) {
        const uid = targetEmail.replace('_byUserId:', '');
        [targetUser] = await sql`SELECT id FROM users WHERE id = ${uid} LIMIT 1`;
      } else {
        [targetUser] = await sql`SELECT id FROM users WHERE LOWER(email) = ${targetEmail.toLowerCase()} LIMIT 1`;
      }
      if (!targetUser) return res.json({ ok: true, delivered: false, reason: 'User not found.' });

      const [row] = await sql`SELECT data FROM user_data WHERE user_id = ${targetUser.id} LIMIT 1`;
      if (!row) return res.json({ ok: true, delivered: false, reason: 'No user data.' });

      const data = await decompress(row.data || {});
      if (!data.notifs) data.notifs = [];
      notification.userId = targetUser.id;
      data.notifs.push(notification);

      const compressed = await compress(data);
      await sql`UPDATE user_data SET data = ${compressed}, updated_at = now() WHERE user_id = ${targetUser.id}`;

      return res.json({ ok: true, delivered: true });
    } catch (e) {
      console.error('[shared-groups/POST]', e.message);
      return res.status(500).json({ ok: false, error: 'Failed to deliver notification.' });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
};
