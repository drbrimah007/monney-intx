// /api/reconcile — Balance reconciliation between linked users
//
// GET  (admin only)       → compute all linked-pair balances, flag mismatches
// POST { action:'check-entry', entryId } (auth) → check one contact pair after settlement

const { sql }         = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const zlib            = require('zlib');
const { promisify }   = require('util');
const _gunzip         = promisify(zlib.gunzip);
const _gzip           = promisify(zlib.gzip);

// ── Decompress / Compress (same pattern as share.js) ────────────────────────
async function _decompress(raw) {
  if (raw && raw._c === 1 && typeof raw.v === 'string') {
    try {
      const buf = await _gunzip(Buffer.from(raw.v, 'base64'));
      return JSON.parse(buf.toString('utf8'));
    } catch (e) {
      console.error('[reconcile] decompress failed:', e.message);
    }
  }
  return raw;
}

async function _compress(data) {
  const json = JSON.stringify(data);
  const buf  = await _gzip(Buffer.from(json, 'utf8'));
  return { _c: 1, v: buf.toString('base64') };
}

// ── Ledger direction map (mirrors client-side TX_LEDGER) ────────────────────
const TX_LEDGER = {
  they_owe_you:  'toy', they_paid_you: 'toy_credit',
  you_owe_them:  'yot', you_paid_them: 'yot_credit',
  invoice:       'toy', bill:          'toy'
};

function computeLedger(entries, contactId) {
  const contact = (entries._contacts || []).find(c => c.id === contactId);
  let toy = contact ? (contact.startToy || 0) : 0;
  let yot = contact ? (contact.startYot || 0) : 0;
  const list = (entries._entries || []);
  list.filter(e => e.cId === contactId && e.status !== 'voided' && !e.noLedger).forEach(e => {
    const a = Math.abs(parseFloat(e.amount) || 0);
    const dir = TX_LEDGER[e.txType] || '';
    if      (dir === 'toy')        toy += a;
    else if (dir === 'toy_credit') toy = Math.max(0, toy - a);
    else if (dir === 'yot')        yot += a;
    else if (dir === 'yot_credit') yot = Math.max(0, yot - a);
  });
  return { toy: Math.round(toy * 100) / 100, yot: Math.round(yot * 100) / 100, net: Math.round((toy - yot) * 100) / 100 };
}

// Helper: load a user's blob and return { entries, contacts } arrays
async function loadUserBlob(userId) {
  const [row] = await sql`SELECT data FROM user_data WHERE user_id = ${userId} LIMIT 1`;
  if (!row) return null;
  const data = await _decompress(row.data || {});
  return { _entries: data.entries || [], _contacts: data.contacts || [], _notifs: data.notifs || [], _raw: data };
}

// Helper: find admin user id
async function findAdminId() {
  const [admin] = await sql`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`;
  return admin ? admin.id : null;
}

// Helper: push notification to a user's blob
async function pushNotification(userId, notif) {
  const [row] = await sql`SELECT data FROM user_data WHERE user_id = ${userId} LIMIT 1`;
  if (!row) return;
  const data = await _decompress(row.data || {});
  if (!data.notifs) data.notifs = [];
  data.notifs.push(notif);
  const compressed = await _compress(data);
  await sql`UPDATE user_data SET data = ${compressed}, updated_at = now() WHERE user_id = ${userId}`;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: Full reconciliation report (admin only) ──────────────────────────
  if (req.method === 'GET') {
    const payload = requireAuth(req, res);
    if (!payload) return;
    if (payload.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Admin only.' });
    }

    try {
      // Find all share tokens where both parties are on platform
      const tokens = await sql`
        SELECT DISTINCT user_id, linked_user_id
        FROM share_tokens
        WHERE linked_user_id IS NOT NULL
      `;

      // Deduplicate pairs (A,B) and (B,A) into one pair
      const pairMap = new Map();
      for (const t of tokens) {
        const a = t.user_id < t.linked_user_id ? t.user_id : t.linked_user_id;
        const b = t.user_id < t.linked_user_id ? t.linked_user_id : t.user_id;
        const key = a + '|' + b;
        if (!pairMap.has(key)) {
          // Count tokens for this pair
          const tokenCount = await sql`
            SELECT COUNT(*)::int AS cnt FROM share_tokens
            WHERE (user_id = ${a} AND linked_user_id = ${b})
               OR (user_id = ${b} AND linked_user_id = ${a})
          `;
          pairMap.set(key, { userAId: a, userBId: b, tokens: tokenCount[0]?.cnt || 0 });
        }
      }

      // Load user info
      const userIds = new Set();
      for (const p of pairMap.values()) { userIds.add(p.userAId); userIds.add(p.userBId); }
      const userInfoMap = new Map();
      if (userIds.size > 0) {
        const ids = [...userIds];
        const userRows = await sql`
          SELECT id, display_name, email FROM users WHERE id = ANY(${ids})
        `;
        for (const u of userRows) {
          userInfoMap.set(u.id, { id: u.id, name: u.display_name, email: u.email });
        }
      }

      // For each pair, compute both ledgers
      const pairs = [];
      let mismatches = 0;
      const blobCache = new Map();

      for (const p of pairMap.values()) {
        // Load blobs (cached)
        if (!blobCache.has(p.userAId)) blobCache.set(p.userAId, await loadUserBlob(p.userAId));
        if (!blobCache.has(p.userBId)) blobCache.set(p.userBId, await loadUserBlob(p.userBId));

        const blobA = blobCache.get(p.userAId);
        const blobB = blobCache.get(p.userBId);
        if (!blobA || !blobB) continue;

        // Find A's contact for B: a contact in A's blob whose linkedUserId = B
        const contactAforB = (blobA._contacts || []).find(c => c.linkedUserId === p.userBId);
        const contactBforA = (blobB._contacts || []).find(c => c.linkedUserId === p.userAId);

        const balanceA = contactAforB ? computeLedger(blobA, contactAforB.id) : { toy: 0, yot: 0, net: 0 };
        const balanceB = contactBforA ? computeLedger(blobB, contactBforA.id) : { toy: 0, yot: 0, net: 0 };

        // A's TOY for B should equal B's YOT for A, and vice versa
        const diffToy = Math.abs(balanceA.toy - balanceB.yot);
        const diffYot = Math.abs(balanceA.yot - balanceB.toy);
        const difference = Math.round(Math.max(diffToy, diffYot) * 100) / 100;
        const mismatch = difference > 0.50;
        if (mismatch) mismatches++;

        pairs.push({
          userA: userInfoMap.get(p.userAId) || { id: p.userAId, name: '?', email: '?' },
          userB: userInfoMap.get(p.userBId) || { id: p.userBId, name: '?', email: '?' },
          balanceA,
          balanceB,
          mismatch,
          difference,
          tokens: p.tokens
        });
      }

      // Sort: mismatches first, then by difference descending
      pairs.sort((a, b) => (b.mismatch ? 1 : 0) - (a.mismatch ? 1 : 0) || b.difference - a.difference);

      return res.json({ ok: true, pairs, mismatches, total: pairs.length });
    } catch (e) {
      console.error('[reconcile/GET]', e.message);
      return res.status(500).json({ ok: false, error: 'Reconciliation failed.' });
    }
  }

  // ── POST: Check specific entry ────────────────────────────────────────────
  if (req.method === 'POST') {
    const payload = requireAuth(req, res);
    if (!payload) return;

    const { action, entryId } = req.body || {};
    if (action !== 'check-entry' || !entryId) {
      return res.status(400).json({ ok: false, error: 'Invalid request. Expected action=check-entry with entryId.' });
    }

    try {
      // Find share token(s) for this entry where both parties are linked
      const tokenRows = await sql`
        SELECT user_id, linked_user_id FROM share_tokens
        WHERE entry_id = ${entryId} AND linked_user_id IS NOT NULL
        LIMIT 1
      `;
      if (tokenRows.length === 0) {
        return res.json({ ok: true, balanced: true, difference: 0, msg: 'No linked pair for this entry.' });
      }

      const { user_id: senderId, linked_user_id: recipientId } = tokenRows[0];
      const blobSender = await loadUserBlob(senderId);
      const blobRecipient = await loadUserBlob(recipientId);
      if (!blobSender || !blobRecipient) {
        return res.json({ ok: true, balanced: true, difference: 0, msg: 'Could not load user data.' });
      }

      // Find contacts
      const contactSforR = (blobSender._contacts || []).find(c => c.linkedUserId === recipientId);
      const contactRforS = (blobRecipient._contacts || []).find(c => c.linkedUserId === senderId);

      const balSender = contactSforR ? computeLedger(blobSender, contactSforR.id) : { toy: 0, yot: 0, net: 0 };
      const balRecip  = contactRforS ? computeLedger(blobRecipient, contactRforS.id) : { toy: 0, yot: 0, net: 0 };

      const diffToy = Math.abs(balSender.toy - balRecip.yot);
      const diffYot = Math.abs(balSender.yot - balRecip.toy);
      const difference = Math.round(Math.max(diffToy, diffYot) * 100) / 100;
      const balanced = difference <= 0.50;

      // If mismatch, notify admin
      if (!balanced) {
        const adminId = await findAdminId();
        if (adminId) {
          const senderInfo = await sql`SELECT display_name FROM users WHERE id = ${senderId} LIMIT 1`;
          const recipInfo  = await sql`SELECT display_name FROM users WHERE id = ${recipientId} LIMIT 1`;
          const nameA = senderInfo[0]?.display_name || 'User';
          const nameB = recipInfo[0]?.display_name || 'User';

          await pushNotification(adminId, {
            id:        'n' + Math.random().toString(36).substr(2, 9),
            userId:    adminId,
            cId:       null,
            eid:       entryId,
            type:      'reconciliation_mismatch',
            msg:       `Balance mismatch of $${difference.toFixed(2)} between ${nameA} and ${nameB}`,
            channel:   'in-app',
            sent:      true,
            who:       'system',
            sentTo:    '',
            read:      false,
            createdAt: Date.now()
          });
        }
      }

      return res.json({ ok: true, balanced, difference });
    } catch (e) {
      console.error('[reconcile/POST]', e.message);
      return res.status(500).json({ ok: false, error: 'Reconciliation check failed.' });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
};
