// /api/share — consolidated share handler
//
// GET  ?t=TOKEN              → view entry (public)
// GET  ?linked=1             → list entries shared with current user (auth)
// POST { action:'create', entryId, … } → create/get share link (auth)
// POST { action:'acknowledge', token } → mark acknowledged (public)
// POST { action:'link', token }        → link token to current user's account (auth)

const { sql }         = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const crypto          = require('crypto');
const zlib            = require('zlib');
const { promisify }   = require('util');
const _gunzip         = promisify(zlib.gunzip);
const _gzip           = promisify(zlib.gzip);

// Decompress user_data blob if stored compressed by sync.js
async function _decompress(raw) {
  if (raw && raw._c === 1 && typeof raw.v === 'string') {
    try {
      const buf = await _gunzip(Buffer.from(raw.v, 'base64'));
      return JSON.parse(buf.toString('utf8'));
    } catch (e) {
      console.error('[share] decompress failed:', e.message);
    }
  }
  return raw;
}
// Compress data object back to the sync.js envelope format
async function _compress(data) {
  const json  = JSON.stringify(data);
  const buf   = await _gzip(Buffer.from(json, 'utf8'));
  return { _c: 1, v: buf.toString('base64') };
}

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS share_tokens (
      token            TEXT        PRIMARY KEY,
      user_id          UUID        NOT NULL,
      entry_id         TEXT        NOT NULL,
      entry_data       JSONB       NOT NULL,
      acknowledged     BOOLEAN     NOT NULL DEFAULT false,
      acknowledged_at  TIMESTAMPTZ,
      linked_user_id   UUID,
      linked_at        TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  // Migration: add columns if the table already existed without them
  await sql`ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS linked_user_id UUID`;
  await sql`ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS linked_at TIMESTAMPTZ`;
  await sql`ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS recipient_closed BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS recipient_closed_at TIMESTAMPTZ`;
  await sql`ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS viewed BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ`;
  // confirmed: true = recipient accepted/confirmed; false = auto-linked, awaiting confirmation
  await sql`ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS confirmed BOOLEAN NOT NULL DEFAULT false`;
  // recipient_email: stored at send time so unregistered recipients can claim records on later signup/login
  await sql`ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS recipient_email TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS idx_share_tokens_recipient_email ON share_tokens (LOWER(recipient_email)) WHERE recipient_email IS NOT NULL`;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {

    // GET ?sent=1 — return outbound share tokens created by the current user with current status
    if (req.query.sent) {
      const payload = requireAuth(req, res);
      if (!payload) return;
      try {
        await ensureTable();
        const rows = await sql`
          SELECT token, entry_id, entry_data, viewed, viewed_at, confirmed, created_at,
                 recipient_closed, linked_user_id
          FROM share_tokens
          WHERE user_id = ${payload.id}
          ORDER BY created_at DESC
          LIMIT 200
        `;
        return res.json({ ok: true, sent: rows.map(r => ({
          token:           r.token,
          entryId:         r.entry_id,
          entry:           r.entry_data,
          viewed:          r.viewed || false,
          viewedAt:        r.viewed_at,
          confirmed:       r.confirmed || false,
          recipientClosed: r.recipient_closed || false,
          createdAt:       r.created_at
        }))});
      } catch (e) {
        console.error('[share/sent]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to load sent records.' });
      }
    }

    // GET ?linked=1 — return all records shared with the current user (auth)
    if (req.query.linked) {
      const payload = requireAuth(req, res);
      if (!payload) return;
      try {
        await ensureTable();
        const rows = await sql`
          SELECT st.token, st.entry_data, st.acknowledged, st.acknowledged_at, st.linked_at,
                 st.created_at, st.recipient_closed, st.confirmed,
                 u.email AS owner_email
          FROM share_tokens st
          LEFT JOIN users u ON u.id = st.user_id
          WHERE st.linked_user_id = ${payload.id}
            AND (st.entry_data->>'isShared') IS DISTINCT FROM 'true'
          ORDER BY st.linked_at DESC NULLS LAST
        `;
        return res.json({ ok: true, shared: rows.map(r => ({
          token:           r.token,
          entry:           r.entry_data,
          acknowledged:    r.acknowledged,
          acknowledgedAt:  r.acknowledged_at,
          linkedAt:        r.linked_at,
          sharedAt:        r.created_at,
          recipientClosed: r.recipient_closed,
          confirmed:       r.confirmed,
          ownerEmail:      r.owner_email || ''   // actual account email of the share creator
        }))});
      } catch (e) {
        console.error('[share/linked]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to load shared records.' });
      }
    }

    // GET ?t=TOKEN — public view
    const token = req.query.t;
    if (!token) return res.status(400).json({ ok: false, error: 'Token required' });
    try {
      await ensureTable();
      const rows = await sql`
        SELECT user_id, entry_id, entry_data, acknowledged, acknowledged_at,
               recipient_closed, recipient_closed_at, viewed, viewed_at, created_at,
               linked_user_id, confirmed
        FROM share_tokens WHERE token = ${token} LIMIT 1
      `;
      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Link not found or expired.' });
      }
      const row = rows[0];

      // First view — mark viewed and push in-app notification to owner
      // Skip "viewed" notification for settlement receipts — they're auto-generated
      const _isSettlementReceipt = row.entry_data &&
        (row.entry_data.linkedInvoiceId || row.entry_data.settledByRecipient ||
         row.entry_data.txType === 'they_paid_you' || row.entry_data.txType === 'you_paid_them');
      if (!row.viewed) {
        // Also update entry_data.status to 'viewed' so recipient sees correct status
        const _viewedEntryData = (!_isSettlementReceipt && row.entry_data && (row.entry_data.status === 'posted' || row.entry_data.status === 'sent' || !row.entry_data.status))
          ? { ...row.entry_data, status: 'viewed' } : row.entry_data;
        await sql`
          UPDATE share_tokens SET viewed = true, viewed_at = now(), entry_data = ${_viewedEntryData}
          WHERE token = ${token}
        `;
        // Don't send "viewed" notification for settlement receipts
        if (!_isSettlementReceipt) {
        try {
          const ownerId = row.user_id;
          const entryId = row.entry_id;
          const entryData = row.entry_data;
          const [blobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${ownerId} LIMIT 1`;
          if (blobRow) {
            // Decompress if gzip-compressed (sync.js stores {_c:1, v:"<base64>"})
            const ownerData = await _decompress(blobRow.data || {});
            const entry   = (ownerData.entries  || []).find(e => e.id === entryId);
            const contact = entry ? (ownerData.contacts || []).find(c => c.id === entry.cId) : null;
            const name    = contact?.name || entryData?.contactName || 'Someone';
            if (!ownerData.notifs) ownerData.notifs = [];
            ownerData.notifs.push({
              id:        'n' + Math.random().toString(36).substr(2, 9),
              userId:    ownerId,
              cId:       entry?.cId || null,
              eid:       entryId,
              type:      'viewed',
              msg:       `${name} viewed a record you shared with them.`,
              channel:   'in-app',
              sent:      true,
              who:       'them',
              sentTo:    '',
              read:      false,
              createdAt: Date.now()
            });
            // Update the sender's original entry status to 'viewed' so Entries list reflects it
            if (entry && (entry.status === 'posted' || entry.status === 'sent')) {
              entry.status = 'viewed';
            }
            // Re-compress before writing back
            const recompressed = await _compress(ownerData);
            await sql`UPDATE user_data SET data = ${recompressed}, updated_at = now() WHERE user_id = ${ownerId}`;
          }
        } catch (innerErr) {
          console.error('[share/view] notif push failed:', innerErr.message);
        }
        } // end if (!_isSettlementReceipt)
      }

      // Optionally detect if the current viewer is the linked recipient
      // (so view.html can show a "Confirm & Track" button without requiring login first)
      let isLinkedUser = false;
      if (row.linked_user_id && !row.confirmed) {
        try {
          const { verifyToken, getTokenFromRequest } = require('../lib/auth');
          const jwtPayload = verifyToken(getTokenFromRequest(req));
          if (jwtPayload && jwtPayload.id === row.linked_user_id) {
            isLinkedUser = true;
          }
        } catch (_) {}
      }

      return res.json({
        ok: true,
        entry:                  row.entry_data,
        acknowledged:           row.acknowledged,
        acknowledgedAt:         row.acknowledged_at,
        recipientClosed:        row.recipient_closed,
        recipientClosedAt:      row.recipient_closed_at,
        settlementPending:      row.entry_data?.settlementPending || false,
        settlementConfirmed:    row.entry_data?.settlementConfirmed || false,
        confirmed:              row.confirmed || false,
        isLinkedUser,
        isSettlementReceipt:    !!_isSettlementReceipt,
        viewed:                 true,
        viewedAt:               row.viewed_at,
        sharedAt:               row.created_at
      });
    } catch (e) {
      console.error('[share/view]', e.message);
      return res.status(500).json({ ok: false, error: 'Failed to load record.' });
    }
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action } = req.body || {};

    // ── acknowledge (public) ────────────────────────────────────────────────
    if (action === 'acknowledge') {
      const { token } = req.body;
      if (!token) return res.status(400).json({ ok: false, error: 'Token required' });
      try {
        await ensureTable();
        const result = await sql`
          UPDATE share_tokens
          SET acknowledged = true, acknowledged_at = now()
          WHERE token = ${token} AND acknowledged = false
          RETURNING entry_id
        `;
        return res.json({ ok: true, acknowledged: true, alreadyAcknowledged: result.length === 0 });
      } catch (e) {
        console.error('[share/acknowledge]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to acknowledge.' });
      }
    }

    // ── link token to current user (auth required) ──────────────────────────
    // Also permanently writes linkedUserId into the sender's contact record so
    // ALL future entries for that contact are auto-resolved — email doesn't matter.
    if (action === 'link') {
      const payload = requireAuth(req, res);
      if (!payload) return;
      const { token } = req.body;
      if (!token) return res.status(400).json({ ok: false, error: 'Token required' });
      try {
        await ensureTable();
        const rows = await sql`
          SELECT user_id, entry_id, entry_data FROM share_tokens WHERE token = ${token} LIMIT 1
        `;
        if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Token not found.' });
        const senderId  = rows[0].user_id;
        const entryId   = rows[0].entry_id;
        const entryData = rows[0].entry_data;

        // Self-link: sender previewing their own share link
        if (senderId === payload.id) {
          return res.json({ ok: true, selfLink: true, entry: entryData });
        }

        // 1. Link the token to the recipient's account — manual accept = confirmed=true
        await sql`
          UPDATE share_tokens
          SET linked_user_id = ${payload.id}, linked_at = now(), confirmed = true
          WHERE token = ${token} AND (linked_user_id IS NULL OR linked_user_id = ${payload.id})
        `;

        // 2. Permanently link the contact in Perry's data blob → identity resolved
        //    regardless of what email Perry used for this contact
        try {
          const [blobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${senderId} LIMIT 1`;
          if (blobRow) {
            const senderData = blobRow.data || {};
            const entry   = (senderData.entries  || []).find(e => e.id === entryId);
            const contact = entry ? (senderData.contacts || []).find(c => c.id === entry.cId) : null;
            if (contact) {
              if (!contact.linkedUserId) {
                contact.linkedUserId = payload.id;
                await sql`
                  UPDATE user_data SET data = ${senderData}, updated_at = now()
                  WHERE user_id = ${senderId}
                `;
              }
              // Auto-link ALL other unlinked tokens from this sender for this same contact
              // so the recipient doesn't need to click each share link individually
              const contactEntryIds = (senderData.entries || [])
                .filter(e => e.cId === contact.id)
                .map(e => e.id);
              if (contactEntryIds.length > 0) {
                await sql`
                  UPDATE share_tokens
                  SET linked_user_id = ${payload.id}, linked_at = now()
                  WHERE user_id   = ${senderId}
                    AND linked_user_id IS NULL
                    AND entry_id  = ANY(${contactEntryIds})
                `;
              }
            }
          }
        } catch (innerErr) {
          // Non-fatal — token link already succeeded
          console.error('[share/link] contact update failed:', innerErr.message);
        }

        return res.json({ ok: true, linked: true, entry: entryData });
      } catch (e) {
        console.error('[share/link]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to link record.' });
      }
    }

    // ── create share token (auth required) ──────────────────────────────────
    if (action === 'create') {
      const payload = requireAuth(req, res);
      if (!payload) return;
      const { entryId, contactName, contactEmail, fromName, fromEmail, txType, amount, date,
              note, invoiceNumber, status, appName, siteUrl, tagline } = req.body;
      if (!entryId) return res.status(400).json({ ok: false, error: 'entryId required' });
      try {
        await ensureTable();

        // SAFETY: verify the entry belongs to the sender and is NOT a received shared record.
        // If it is isShared, creating a share token would send a reverse share back to the
        // original sender — producing a duplicate Pending record in their inbox.
        try {
          const [blobCheck] = await sql`SELECT data FROM user_data WHERE user_id = ${payload.id} LIMIT 1`;
          if (blobCheck) {
            const blobData = await _decompress(blobCheck.data || {});
            const targetEntry = (blobData.entries || []).find(e => e.id === entryId);
            if (targetEntry?.isShared) {
              // Return existing share link (original) instead of creating a reverse one
              const origToken = targetEntry.shareToken;
              const base = (targetEntry.fromSiteUrl) || siteUrl || 'https://moneyinteractions.com';
              if (origToken) return res.json({ ok: true, token: origToken, shareUrl: `${base}/view?t=${origToken}`, isOriginal: true });
              return res.status(400).json({ ok: false, error: 'Cannot create share for a received record.' });
            }
          }
        } catch (_) {} // non-critical — fall through to normal create

        // Resolve recipient user — two paths:
        //  1. contactEmail passed directly from client (fast, no blob read needed)
        //  2. blob-read for contact.linkedUserId (established relationship → confirmed=true)
        let autoLinkedUserId = null;
        let autoLinkedByEmail = false;
        const senderEmail = (payload.email || '').toLowerCase().trim();

        // Path 1: direct email lookup
        if (contactEmail) {
          const emailClean = contactEmail.toLowerCase().trim();
          if (emailClean && emailClean !== senderEmail) {
            try {
              const [uRow] = await sql`SELECT id FROM users WHERE LOWER(email) = ${emailClean} LIMIT 1`;
              if (uRow) { autoLinkedUserId = uRow.id; autoLinkedByEmail = true; }
            } catch (_) {}
          }
        }

        // Path 2: blob-read for linkedUserId (established trusted relationship)
        if (!autoLinkedUserId) {
          try {
            const [blobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${payload.id} LIMIT 1`;
            if (blobRow) {
              const senderData = await _decompress(blobRow.data) || {};
              const entry   = (senderData.entries  || []).find(e => e.id === entryId);
              const contact = entry ? (senderData.contacts || []).find(c => c.id === entry.cId) : null;
              if (contact?.linkedUserId) { autoLinkedUserId = contact.linkedUserId; autoLinkedByEmail = false; }
            }
          } catch (_) {}
        }

        const existing = await sql`
          SELECT token, linked_user_id FROM share_tokens
          WHERE entry_id = ${entryId} AND user_id = ${payload.id} LIMIT 1
        `;
        if (existing.length > 0) {
          const token = existing[0].token;
          // If not yet linked but we now know the linked user, fill it in
          if (autoLinkedUserId && !existing[0].linked_user_id) {
            const autoConfirmed = !autoLinkedByEmail;
            await sql`
              UPDATE share_tokens SET linked_user_id = ${autoLinkedUserId}, linked_at = now(), confirmed = ${autoConfirmed}
              WHERE token = ${token}
            `;
          }
          // Refresh the entry_data snapshot so reminders/views reflect the latest edits
          const updatedEntryData = {
            entryId, contactName,
            contactEmail: contactEmail ? contactEmail.toLowerCase().trim() : '',
            fromName, fromEmail: fromEmail || '',
            txType, amount, date, note: note || '',
            invoiceNumber: invoiceNumber || null,
            status: status || 'posted',
            appName: appName || 'Money IntX',
            siteUrl: siteUrl || 'https://moneyinteractions.com',
            tagline: tagline || 'Making Money Matters Memorable',
            sharedAt: Date.now()
          };
          await sql`
            UPDATE share_tokens SET entry_data = ${JSON.stringify(updatedEntryData)}::jsonb
            WHERE token = ${token}
          `;
          const base = siteUrl || 'https://moneyinteractions.com';
          return res.json({ ok: true, token, shareUrl: `${base}/view?t=${token}` });
        }

        const token = crypto.randomBytes(18).toString('base64url');
        // Normalize recipient email — stored as column for later-registration claim
        const recipientEmailNorm = contactEmail ? contactEmail.toLowerCase().trim() : null;
        const entryData = {
          entryId, contactName,
          contactEmail: recipientEmailNorm || '',   // stored so view.html can show direction
          fromName, fromEmail: fromEmail || '',
          txType, amount, date, note: note || '',
          invoiceNumber: invoiceNumber || null,
          status: status || 'posted',
          appName: appName || 'Money IntX',
          siteUrl: siteUrl || 'https://moneyinteractions.com',
          tagline: tagline || 'Making Money Matters Memorable',
          sharedAt: Date.now()
        };

        if (autoLinkedUserId) {
          // Auto-linked: confirmed=true for established linkedUserId, false for email-matched (needs recipient confirmation)
          const autoConfirmed = !autoLinkedByEmail;
          await sql`
            INSERT INTO share_tokens (token, user_id, entry_id, entry_data, linked_user_id, linked_at, confirmed, recipient_email)
            VALUES (${token}, ${payload.id}, ${entryId}, ${entryData}, ${autoLinkedUserId}, now(), ${autoConfirmed}, ${recipientEmailNorm})
          `;
        } else {
          // No user match yet — store recipient_email so they can claim when they register/login
          await sql`
            INSERT INTO share_tokens (token, user_id, entry_id, entry_data, recipient_email)
            VALUES (${token}, ${payload.id}, ${entryId}, ${entryData}, ${recipientEmailNorm})
          `;
        }

        const base = siteUrl || 'https://moneyinteractions.com';
        return res.json({ ok: true, token, shareUrl: `${base}/view?t=${token}`, autoLinked: !!autoLinkedUserId });
      } catch (e) {
        console.error('[share/create]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to create share link.' });
      }
    }

    // ── owner-close: owner closes the record from their side ────────────
    if (action === 'owner-close') {
      const payload = requireAuth(req, res);
      if (!payload) return;
      const { entryId, closedMsg } = req.body;
      if (!entryId) return res.status(400).json({ ok: false, error: 'entryId required' });
      try {
        await ensureTable();
        // Update the entry_data snapshot in all matching share_tokens
        const rows = await sql`
          SELECT token, entry_data FROM share_tokens
          WHERE entry_id = ${entryId} AND user_id = ${payload.id}
        `;
        for (const row of rows) {
          const updated = { ...row.entry_data, status: 'closed', closedAt: Date.now(), closedMsg: closedMsg || '' };
          await sql`UPDATE share_tokens SET entry_data = ${updated} WHERE token = ${row.token}`;
        }
        return res.json({ ok: true, closed: true });
      } catch (e) {
        console.error('[share/owner-close]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to close record.' });
      }
    }

    // ── recipient-close: contact closes from their side ─────────────────
    if (action === 'recipient-close') {
      const { token } = req.body;
      if (!token) return res.status(400).json({ ok: false, error: 'Token required' });
      try {
        await ensureTable();
        const rows = await sql`
          SELECT user_id, entry_id FROM share_tokens WHERE token = ${token} LIMIT 1
        `;
        if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Token not found.' });
        const { user_id: ownerId, entry_id: entryId } = rows[0];

        // 1. Mark recipient_closed on the token row
        await sql`
          UPDATE share_tokens SET recipient_closed = true, recipient_closed_at = now()
          WHERE token = ${token}
        `;

        // 2. Update owner's data blob: set closedByRecipient on the entry + push in-app notif
        try {
          const [blobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${ownerId} LIMIT 1`;
          if (blobRow) {
            // Decompress if gzip-compressed
            const ownerData = await _decompress(blobRow.data || {});
            const entry = (ownerData.entries || []).find(e => e.id === entryId);
            if (entry) {
              entry.closedByRecipient = true;
              entry.closedByRecipientAt = Date.now();
            }
            // Push in-app notification for the owner
            const contact = entry ? (ownerData.contacts || []).find(c => c.id === entry?.cId) : null;
            if (!ownerData.notifs) ownerData.notifs = [];
            ownerData.notifs.push({
              id: 'n' + Math.random().toString(36).substr(2, 9),
              userId: ownerId,
              cId: entry?.cId || null,
              eid: entryId,
              type: 'closed',
              msg: `${contact?.name || 'Your contact'} has closed their side of a record.`,
              channel: 'in-app',
              sent: true,
              who: 'them',
              sentTo: '',
              read: false,
              createdAt: Date.now()
            });
            // Re-compress before writing back
            const recompressed = await _compress(ownerData);
            await sql`UPDATE user_data SET data = ${recompressed}, updated_at = now() WHERE user_id = ${ownerId}`;
          }
        } catch (innerErr) {
          console.error('[share/recipient-close] owner update failed:', innerErr.message);
        }

        return res.json({ ok: true, recipientClosed: true });
      } catch (e) {
        console.error('[share/recipient-close]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to close record.' });
      }
    }

    // ── confirm-shared: recipient confirms (Confirm & Track) a shared record ──
    if (action === 'confirm-shared') {
      const payload = requireAuth(req, res);
      if (!payload) return;
      const { token: cToken } = req.body;
      if (!cToken) return res.status(400).json({ ok: false, error: 'token required' });
      try {
        await ensureTable();
        await sql`
          UPDATE share_tokens SET confirmed = true
          WHERE token = ${cToken} AND linked_user_id = ${payload.id}
        `;

        // Push "confirmed" notification to sender + update their entry status to 'accepted'
        try {
          const [tokenRow] = await sql`
            SELECT user_id, entry_id, entry_data FROM share_tokens WHERE token = ${cToken} LIMIT 1
          `;
          if (tokenRow) {
            const ownerId   = tokenRow.user_id;
            const entryId   = tokenRow.entry_id;
            const entryData = tokenRow.entry_data;
            const [blobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${ownerId} LIMIT 1`;
            if (blobRow) {
              const ownerData = await _decompress(blobRow.data || {});
              const entry     = (ownerData.entries  || []).find(e => e.id === entryId);
              const contact   = entry ? (ownerData.contacts || []).find(c => c.id === entry.cId) : null;
              const name      = contact?.name || entryData?.contactName || 'Someone';
              if (!ownerData.notifs) ownerData.notifs = [];
              ownerData.notifs.push({
                id:        'n' + Math.random().toString(36).substr(2, 9),
                userId:    ownerId,
                cId:       entry?.cId || null,
                eid:       entryId,
                type:      'confirmed',
                msg:       `${name} confirmed and is now tracking a record you shared with them.`,
                channel:   'in-app',
                sent:      true,
                who:       'them',
                sentTo:    '',
                read:      false,
                createdAt: Date.now()
              });
              // Update sender's entry status to 'accepted' so their Entries list reflects confirmation
              if (entry && entry.status !== 'settled' && entry.status !== 'voided' && entry.status !== 'fulfilled') {
                entry.status = 'accepted';
              }
              const recompressed = await _compress(ownerData);
              await sql`UPDATE user_data SET data = ${recompressed}, updated_at = now() WHERE user_id = ${ownerId}`;
            }
            // Also update entry_data.status in the token so recipient sees 'Accepted'
            const [freshToken] = await sql`SELECT entry_data FROM share_tokens WHERE token = ${cToken} LIMIT 1`;
            if (freshToken && freshToken.entry_data) {
              const _acceptedData = { ...freshToken.entry_data, status: 'accepted', acceptedAt: Date.now() };
              await sql`UPDATE share_tokens SET entry_data = ${_acceptedData} WHERE token = ${cToken}`;
            }
          }
        } catch (innerErr) {
          console.error('[share/confirm-shared] sender update failed:', innerErr.message);
        }

        return res.json({ ok: true });
      } catch (e) {
        console.error('[share/confirm-shared]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to confirm record.' });
      }
    }

    // ── mark-paid: recipient marks a shared record as settled/paid ───────────
    if (action === 'mark-paid') {
      const payload = requireAuth(req, res);
      if (!payload) return;
      const { token: mpToken, settledAmt: _sAmt, totalAmt: _tAmt, proofData, proofFilename } = req.body;
      if (!mpToken) return res.status(400).json({ ok: false, error: 'token required' });

      // Validate proof size (2MB max for base64)
      if (proofData && proofData.length > 2 * 1024 * 1024 * 1.37) {
        return res.status(400).json({ ok: false, error: 'Proof file too large (2MB max).' });
      }

      try {
        await ensureTable();
        const [row] = await sql`
          SELECT user_id, entry_id, entry_data, linked_user_id
          FROM share_tokens WHERE token = ${mpToken} AND linked_user_id = ${payload.id} LIMIT 1
        `;
        if (!row) return res.status(404).json({ ok: false, error: 'Not found.' });

        const ownerId   = row.user_id;
        const entryId   = row.entry_id;
        const entryData = row.entry_data || {};

        // thisPayment = the amount being paid RIGHT NOW
        const totalAmt   = parseFloat(_tAmt || entryData.amount || 0);
        const thisPayment = Math.max(0, parseFloat(_sAmt || totalAmt));

        // Read prior settled amount from existing entry_data (accumulated across all payments)
        const priorSettled = parseFloat(entryData.settledAmt || 0);
        const cumulativeSettled = Math.min(priorSettled + thisPayment, totalAmt);
        const remaining  = Math.max(0, totalAmt - cumulativeSettled);
        const newStatus  = remaining <= 0.005 ? 'settled' : 'partially_settled';

        // Build settlement proof object if proof was uploaded
        const settlementProof = proofData ? {
          data:       proofData,
          filename:   proofFilename || 'proof',
          uploadedAt: Date.now(),
          uploadedBy: payload.id
        } : null;

        // Store pending settlement details — actual settlement entry created on confirm
        const pendingSettlement = {
          amount:        thisPayment,
          totalAmt,
          cumulativeSettled,
          remaining,
          newStatus,
          proofData:     proofData || null,
          proofFilename: proofFilename || null,
          uploadedAt:    Date.now(),
          recipientId:   payload.id,
          recipientName: (await sql`SELECT display_name FROM users WHERE id = ${payload.id} LIMIT 1`)[0]?.display_name || payload.email || 'recipient'
        };

        // Update share_token entry_data with CUMULATIVE amounts
        const updatedEntry = {
          ...entryData,
          _preSettlementStatus: entryData.status || 'accepted',
          status:            newStatus,
          settledByRecipient: true,
          settledAmt:        cumulativeSettled,
          remaining:         remaining,
          settledAt:         new Date().toISOString(),
          settlementPending: true,
          settlementConfirmed: false,
          pendingSettlement,
          ...(settlementProof ? { settlementProof } : {})
        };
        await sql`UPDATE share_tokens SET entry_data = ${updatedEntry} WHERE token = ${mpToken}`;

        // DO NOT create settlement entry on sender's blob yet — that happens on confirm.
        // Only push notification to sender asking them to review.
        try {
          const [blobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${ownerId} LIMIT 1`;
          if (blobRow) {
            const ownerData = await _decompress(blobRow.data || {});
            const entry   = (ownerData.entries  || []).find(e => e.id === entryId);
            const contact = entry ? (ownerData.contacts || []).find(c => c.id === entry.cId) : null;
            const name    = contact?.name || entryData?.contactName || 'Your contact';

            // Push in-app notification to sender — settlement_pending type
            if (!ownerData.notifs) ownerData.notifs = [];
            ownerData.notifs.push({
              id:        'n' + Math.random().toString(36).substr(2, 9),
              userId:    ownerId,
              cId:       entry?.cId || null,
              eid:       entryId,
              shareToken: mpToken,
              type:      'settlement_pending',
              msg:       `${name} recorded a payment of $${thisPayment.toFixed(2)} — review proof to confirm`,
              channel:   'in-app',
              sent:      true,
              who:       'them',
              sentTo:    '',
              read:      false,
              createdAt: Date.now()
            });
            const recompressed = await _compress(ownerData);
            await sql`UPDATE user_data SET data = ${recompressed}, updated_at = now() WHERE user_id = ${ownerId}`;
          }
        } catch (innerErr) {
          console.error('[share/mark-paid] owner update failed:', innerErr.message);
        }
        return res.json({ ok: true, status: newStatus, remaining, settledAmt: thisPayment, totalSettled: cumulativeSettled, pending: true });
      } catch (e) {
        console.error('[share/mark-paid]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to mark paid.' });
      }
    }

    // ── dismiss-shared: recipient dismisses (Dismiss) a shared record ────────
    if (action === 'dismiss-shared') {
      const payload = requireAuth(req, res);
      if (!payload) return;
      const { token: dToken } = req.body;
      if (!dToken) return res.status(400).json({ ok: false, error: 'token required' });
      try {
        await ensureTable();
        const [row] = await sql`SELECT entry_data FROM share_tokens WHERE token = ${dToken} AND linked_user_id = ${payload.id} LIMIT 1`;
        if (!row) return res.status(404).json({ ok: false, error: 'Not found.' });
        const updated = { ...(row.entry_data || {}), dismissed: true };
        await sql`UPDATE share_tokens SET entry_data = ${updated} WHERE token = ${dToken}`;
        return res.json({ ok: true });
      } catch (e) {
        console.error('[share/dismiss-shared]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to dismiss record.' });
      }
    }

    // ── backfill: scan sender's blob and create/link tokens for entries missing them ─
    // Called once after login to recover entries created before auto-linking was added.
    if (action === 'backfill') {
      const payload = requireAuth(req, res);
      if (!payload) return;
      try {
        await ensureTable();
        const [blobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${payload.id} LIMIT 1`;
        if (!blobRow) return res.json({ ok: true, created: 0 });
        const db = await _decompress(blobRow.data) || {};
        const entries  = db.entries  || [];
        const contacts = db.contacts || [];
        const senderEmail = (payload.email || '').toLowerCase().trim();
        const settings = db.settings || {};
        const siteUrl  = settings.siteUrl || 'https://moneyinteractions.com';
        const appName  = settings.appName || 'Money IntX';
        const tagline  = settings.tagline || 'Making Money Matters Memorable';
        // JWT payload does not carry displayName — look it up from the users table.
        const [_senderRow] = await sql`SELECT display_name FROM users WHERE id = ${payload.id} LIMIT 1`;
        const fromName = (_senderRow?.display_name) || payload.email || appName;

        let created = 0;
        for (const e of entries) {
          if (e.status === 'voided') continue;
          // NEVER backfill isShared entries — they were RECEIVED from someone else.
          // Creating a share token for them would send a reverse share back to the
          // original sender, which lands in their inbox as a new "Pending" record.
          if (e.isShared) continue;
          const contact = contacts.find(c => c.id === e.cId);
          if (!contact?.email) continue;
          const emailClean = contact.email.toLowerCase().trim();
          if (!emailClean || emailClean === senderEmail) continue;

          // Check if token already exists for this entry
          const [existing] = await sql`SELECT token FROM share_tokens WHERE entry_id = ${e.id} AND user_id = ${payload.id} LIMIT 1`;
          if (existing) continue; // already has token

          // Look up user by email
          const [uRow] = await sql`SELECT id FROM users WHERE LOWER(email) = ${emailClean} LIMIT 1`;
          if (!uRow) continue; // no registered user with this email

          const token = crypto.randomBytes(18).toString('base64url');
          const entryData = {
            entryId: e.id, contactName: contact.name || '',
            contactEmail: emailClean,
            fromName, fromEmail: payload.email || '',
            txType: e.txType, amount: e.amount,
            date: e.date, note: e.note || '', invoiceNumber: e.invoiceNumber || null,
            status: e.status || 'posted', appName, siteUrl, tagline, sharedAt: Date.now()
          };
          await sql`
            INSERT INTO share_tokens (token, user_id, entry_id, entry_data, linked_user_id, linked_at, confirmed, recipient_email)
            VALUES (${token}, ${payload.id}, ${e.id}, ${entryData}, ${uRow.id}, now(), false, ${emailClean})
          `;
          created++;
        }
        // Also update existing tokens that are missing recipient_email
        await sql`
          UPDATE share_tokens st
          SET recipient_email = LOWER((entry_data->>'contactEmail'))
          WHERE st.user_id = ${payload.id}
            AND recipient_email IS NULL
            AND entry_data->>'contactEmail' IS NOT NULL
            AND entry_data->>'contactEmail' != ''
        `;
        return res.json({ ok: true, created });
      } catch (e) {
        console.error('[share/backfill]', e.message);
        return res.status(500).json({ ok: false, error: 'Backfill failed.' });
      }
    }

    // ── claim-pending: recipient claims all tokens sent to their email ────────
    // Called on login/initApp from the recipient side.
    // Handles Case 3: user registers AFTER a record was sent to their email.
    if (action === 'claim-pending') {
      const payload = requireAuth(req, res);
      if (!payload) return;
      try {
        await ensureTable();
        const myEmail = (payload.email || '').toLowerCase().trim();
        if (!myEmail) return res.json({ ok: true, claimed: 0 });
        // Find tokens sent to this email that aren't yet linked to any account
        const rows = await sql`
          SELECT token FROM share_tokens
          WHERE LOWER(recipient_email) = ${myEmail}
            AND linked_user_id IS NULL
        `;
        if (rows.length === 0) return res.json({ ok: true, claimed: 0 });
        const tokens = rows.map(r => r.token);
        await sql`
          UPDATE share_tokens
          SET linked_user_id = ${payload.id}, linked_at = now(), confirmed = false
          WHERE token = ANY(${tokens})
        `;
        return res.json({ ok: true, claimed: rows.length });
      } catch (e) {
        console.error('[share/claim-pending]', e.message);
        return res.status(500).json({ ok: false, error: 'Claim failed.' });
      }
    }

    // ── sync-status: push settlement status update to share_tokens snapshot ─
    if (action === 'sync-status') {
      const payload = requireAuth(req, res);
      if (!payload) return;
      const { entryId, status, amount, settledAt, settledAmt, remaining } = req.body;
      if (!entryId || !status) return res.status(400).json({ ok: false, error: 'entryId and status required' });
      try {
        await ensureTable();
        const rows = await sql`
          SELECT token, entry_data, linked_user_id FROM share_tokens
          WHERE entry_id = ${entryId} AND user_id = ${payload.id}
        `;
        for (const row of rows) {
          const updated = { ...row.entry_data, status };
          if (amount     !== undefined) updated.amount    = amount;
          if (settledAt  !== undefined) updated.settledAt = settledAt;
          if (settledAmt !== undefined) updated.settledAmt = settledAmt;
          if (remaining  !== undefined) updated.remaining  = remaining;
          // Seller-initiated settlements don't need buyer confirmation.
          // Only mark-paid (buyer-initiated) sets settlementPending.
          // Clean up any stale pending flags from seller-side syncs
          if (updated.settlementPending && !updated.pendingSettlement) {
            updated.settlementPending = false;
          }
          await sql`UPDATE share_tokens SET entry_data = ${updated} WHERE token = ${row.token}`;

          // Also update recipient's isShared entry in their blob so their side reflects new status
          if (row.linked_user_id) {
            try {
              const [recipBlob] = await sql`SELECT data FROM user_data WHERE user_id = ${row.linked_user_id} LIMIT 1`;
              if (recipBlob) {
                const recipData = await _decompress(recipBlob.data || {});
                const recipEntry = (recipData.entries || []).find(e => e.shareToken === row.token);
                if (recipEntry) {
                  let changed = false;
                  if (recipEntry.status !== status) { recipEntry.status = status; changed = true; }

                  // Settlement credits are handled by auto-confirmed receipt share tokens
                  // on the buyer's client side — no server-side credit creation needed.
                  if (settledAmt !== undefined && recipEntry.settledAmt !== settledAmt) {
                    recipEntry.settledAmt = settledAmt; changed = true;
                  }
                  if (remaining !== undefined && recipEntry.remaining !== remaining) { recipEntry.remaining = remaining; changed = true; }
                  if (changed) {
                    const rRecompressed = await _compress(recipData);
                    await sql`UPDATE user_data SET data = ${rRecompressed}, updated_at = now() WHERE user_id = ${row.linked_user_id}`;
                  }
                }
              }
            } catch (_recipErr) {
              // non-fatal — entry_data was already updated above
            }
          }
        }
        return res.json({ ok: true, synced: rows.length });
      } catch (e) {
        console.error('[share/sync-status]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to sync status.' });
      }
    }

    // ── confirm-settlement: sender confirms a pending settlement (with proof review) ──
    if (action === 'confirm-settlement') {
      const payload = requireAuth(req, res);
      if (!payload) return;
      const { token: cToken } = req.body;
      if (!cToken) return res.status(400).json({ ok: false, error: 'token required' });
      try {
        await ensureTable();
        const [row] = await sql`
          SELECT user_id, entry_id, entry_data, linked_user_id
          FROM share_tokens WHERE token = ${cToken} LIMIT 1
        `;
        if (!row) return res.status(404).json({ ok: false, error: 'Token not found' });
        // Only the token owner (sender) can confirm
        if (row.user_id !== payload.id) return res.status(403).json({ ok: false, error: 'Not authorized.' });

        const entryData = row.entry_data || {};
        const pending   = entryData.pendingSettlement;
        if (!pending) return res.status(400).json({ ok: false, error: 'No pending settlement to confirm.' });

        const ownerId  = row.user_id;
        const entryId  = row.entry_id;
        const thisPayment     = parseFloat(pending.amount || 0);
        const cumulativeSettled = parseFloat(pending.cumulativeSettled || thisPayment);
        const remaining       = parseFloat(pending.remaining || 0);
        const newStatus       = pending.newStatus || (remaining <= 0.005 ? 'settled' : 'partially_settled');

        // 1. Create the actual settlement entry on the sender's blob
        // Retry up to 2 times to handle race conditions with browser sync
        let entryCreated = false;
        for (let attempt = 0; attempt < 2 && !entryCreated; attempt++) {
          const [blobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${ownerId} LIMIT 1`;
          if (!blobRow) break;
          const ownerData = await _decompress(blobRow.data || {});
          const entry   = (ownerData.entries  || []).find(e => e.id === entryId);

          if (!entry) {
            console.warn(`[confirm-settlement] entry ${entryId} not found in owner blob (attempt ${attempt+1})`);
            if (attempt === 0) { await new Promise(r => setTimeout(r, 500)); continue; }
            break;
          }
          if (entry.status === 'voided' || entry.status === 'fulfilled') break;

          // Check if this settlement was already created (idempotency guard)
          const alreadyExists = (ownerData.entries || []).some(s =>
            s.linkedInvoiceId === entryId && s.settledByRecipient &&
            Math.abs((parseFloat(s.amount) || 0) - thisPayment) < 0.01 &&
            s.createdAt && (Date.now() - s.createdAt) < 300000 // within 5 min
          );
          if (alreadyExists) { entryCreated = true; break; }

          const creditType = (entry.txType === 'they_owe_you' || entry.txType === 'invoice' || entry.txType === 'bill')
            ? 'they_paid_you' : 'you_paid_them';
          ownerData.settings = ownerData.settings || {};
          ownerData.settings.entryCounter = (ownerData.settings.entryCounter || 0) + 1;
          const docRef = entry.invoiceNumber || ('#' + String(entry.entryNum || '?').padStart(4, '0'));
          if (!ownerData.entries) ownerData.entries = [];
          ownerData.entries.push({
            id:              'x' + Math.random().toString(36).substr(2, 9),
            userId:          ownerId,
            cId:             entry.cId,
            txType:          creditType,
            amount:          thisPayment,
            note:            `Payment (by recipient) for ${docRef}`,
            date:            Date.now(),
            status:          'payment',
            archived:        false,
            shared:          false,
            responses:       [],
            templateId:      null,
            templateData:    {},
            invoiceNumber:   null,
            entryNum:        ownerData.settings.entryCounter,
            createdAt:       Date.now(),
            linkedInvoiceId: entryId,
            settledByRecipient: true,
            noLedger:        true,  // receipt only — balance tracked on parent invoice
            isReceipt:       true   // informational, no flags/badges/actions needed
          });
          // Recompute invoice status from all linked settlement entries
          const allSettledSum = ownerData.entries
            .filter(s => s.linkedInvoiceId === entryId && s.status !== 'voided')
            .reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
          const totalOrig  = parseFloat(entry.amount) || 0;
          const allRemain  = Math.max(0, totalOrig - allSettledSum);
          entry.status = allRemain <= 0.005 ? 'settled' : 'partially_settled';
          entry.lastActivityAt = Date.now();

          // Also update sender's own notification from settlement_pending → settlement_confirmed
          if (ownerData.notifs) {
            ownerData.notifs.forEach(n => {
              if (n.shareToken === cToken && n.type === 'settlement_pending') {
                n.type = 'settlement_confirmed';
                n.msg = n.msg.replace(/review proof to confirm$/i, 'confirmed');
              }
            });
          }

          const recompressed = await _compress(ownerData);
          await sql`UPDATE user_data SET data = ${recompressed}, updated_at = now() WHERE user_id = ${ownerId}`;
          entryCreated = true;
        }

        // 2. Update share_token entry_data
        const updatedEntry = {
          ...entryData,
          settlementConfirmed: true,
          settlementPending:   false,
          pendingSettlement:   null
        };
        await sql`UPDATE share_tokens SET entry_data = ${updatedEntry} WHERE token = ${cToken}`;

        // 3. Notify recipient that payment was confirmed
        if (row.linked_user_id) {
          try {
            const [recipBlob] = await sql`SELECT data FROM user_data WHERE user_id = ${row.linked_user_id} LIMIT 1`;
            if (recipBlob) {
              const recipData = await _decompress(recipBlob.data || {});
              if (!recipData.notifs) recipData.notifs = [];
              recipData.notifs.push({
                id:        'n' + Math.random().toString(36).substr(2, 9),
                userId:    row.linked_user_id,
                shareToken: cToken,
                type:      'settlement_confirmed',
                msg:       `Your payment of $${thisPayment.toFixed(2)} has been confirmed`,
                channel:   'in-app',
                sent:      true,
                who:       'them',
                sentTo:    '',
                read:      false,
                createdAt: Date.now()
              });
              // Update recipient's isShared entry status
              const recipEntry = (recipData.entries || []).find(e => e.shareToken === cToken);
              if (recipEntry) {
                recipEntry.status     = newStatus;
                recipEntry.settledAmt = cumulativeSettled;
                recipEntry.remaining  = remaining;
              }
              const rRecompressed = await _compress(recipData);
              await sql`UPDATE user_data SET data = ${rRecompressed}, updated_at = now() WHERE user_id = ${row.linked_user_id}`;
            }
          } catch (recipErr) {
            console.error('[share/confirm-settlement] recipient update failed:', recipErr.message);
          }
        }

        return res.json({ ok: true, confirmed: true, entryId });
      } catch (e) {
        console.error('[share/confirm-settlement]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to confirm settlement.' });
      }
    }

    // ── reject-settlement: sender rejects a pending settlement ────────────────
    if (action === 'reject-settlement') {
      const payload = requireAuth(req, res);
      if (!payload) return;
      const { token: rToken } = req.body;
      if (!rToken) return res.status(400).json({ ok: false, error: 'token required' });
      try {
        await ensureTable();
        const [row] = await sql`
          SELECT user_id, entry_id, entry_data, linked_user_id
          FROM share_tokens WHERE token = ${rToken} LIMIT 1
        `;
        if (!row) return res.status(404).json({ ok: false, error: 'Token not found' });
        // Only the token owner (sender) can reject
        if (row.user_id !== payload.id) return res.status(403).json({ ok: false, error: 'Not authorized.' });

        const entryData = row.entry_data || {};
        const pending   = entryData.pendingSettlement;
        if (!pending) return res.status(400).json({ ok: false, error: 'No pending settlement to reject.' });

        const thisPayment = parseFloat(pending.amount || 0);

        // Revert settledAmt and remaining to pre-payment values
        const priorCumulative = parseFloat(pending.cumulativeSettled || 0) - thisPayment;
        const totalAmt        = parseFloat(pending.totalAmt || entryData.amount || 0);
        const revertedSettled = Math.max(0, priorCumulative);
        const revertedRemaining = Math.max(0, totalAmt - revertedSettled);
        const revertedStatus  = revertedSettled <= 0.005
          ? (entryData._preSettlementStatus || 'accepted')
          : 'partially_settled';

        // Update share_token entry_data — clear pending, revert amounts
        const updatedEntry = {
          ...entryData,
          status:              revertedStatus,
          settlementPending:   false,
          settlementConfirmed: false,
          settledAmt:          revertedSettled > 0 ? revertedSettled : undefined,
          remaining:           revertedRemaining,
          pendingSettlement:   null,
          settlementProof:     null
        };
        // Clean up undefined keys
        if (revertedSettled <= 0) { delete updatedEntry.settledAmt; delete updatedEntry.settledByRecipient; delete updatedEntry.settledAt; }
        await sql`UPDATE share_tokens SET entry_data = ${updatedEntry} WHERE token = ${rToken}`;

        // Look up sender name for notification + update sender's notif type
        let senderName = 'the sender';
        try {
          const [blobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${row.user_id} LIMIT 1`;
          if (blobRow) {
            const ownerData = await _decompress(blobRow.data || {});
            const entry = (ownerData.entries || []).find(e => e.id === row.entry_id);
            // senderName = the ORIGINAL SENDER's display name (not the recipient's, not the contact name)
            const [_sndRow] = await sql`SELECT display_name FROM users WHERE id = ${row.user_id} LIMIT 1`;
            senderName = _sndRow?.display_name || payload.email || 'the sender';
            // Update sender's notification from settlement_pending → settlement_rejected
            let senderBlobChanged = false;
            if (ownerData.notifs) {
              ownerData.notifs.forEach(n => {
                if (n.shareToken === rToken && n.type === 'settlement_pending') {
                  n.type = 'settlement_rejected';
                  n.msg = n.msg.replace(/review proof to confirm$/i, 'rejected');
                  senderBlobChanged = true;
                }
              });
            }
            if (senderBlobChanged) {
              const recompressed = await _compress(ownerData);
              await sql`UPDATE user_data SET data = ${recompressed}, updated_at = now() WHERE user_id = ${row.user_id}`;
            }
          }
        } catch (_) {}

        // Notify recipient that payment was rejected
        if (row.linked_user_id) {
          try {
            const [recipBlob] = await sql`SELECT data FROM user_data WHERE user_id = ${row.linked_user_id} LIMIT 1`;
            if (recipBlob) {
              const recipData = await _decompress(recipBlob.data || {});
              if (!recipData.notifs) recipData.notifs = [];
              recipData.notifs.push({
                id:        'n' + Math.random().toString(36).substr(2, 9),
                userId:    row.linked_user_id,
                shareToken: rToken,
                type:      'settlement_rejected',
                msg:       `Your payment of $${thisPayment.toFixed(2)} was not confirmed. Please contact ${senderName}.`,
                channel:   'in-app',
                sent:      true,
                who:       'them',
                sentTo:    '',
                read:      false,
                createdAt: Date.now()
              });
              // Revert recipient's isShared entry status
              const recipEntry = (recipData.entries || []).find(e => e.shareToken === rToken);
              if (recipEntry) {
                recipEntry.status     = revertedStatus;
                recipEntry.settledAmt = revertedSettled > 0 ? revertedSettled : undefined;
                recipEntry.remaining  = revertedRemaining;
              }
              const rRecompressed = await _compress(recipData);
              await sql`UPDATE user_data SET data = ${rRecompressed}, updated_at = now() WHERE user_id = ${row.linked_user_id}`;
            }
          } catch (recipErr) {
            console.error('[share/reject-settlement] recipient update failed:', recipErr.message);
          }
        }

        return res.json({ ok: true, rejected: true });
      } catch (e) {
        console.error('[share/reject-settlement]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to reject settlement.' });
      }
    }

    // ── mark-fulfilled: sender marks an invoice as fulfilled ─────────────────
    // Status becomes 'fulfilled' on sender's entry, all share_tokens, and recipient's isShared entry.
    if (action === 'mark-fulfilled') {
      const payload = requireAuth(req, res);
      if (!payload) return;
      const { entryId } = req.body;
      if (!entryId) return res.status(400).json({ ok: false, error: 'entryId required' });
      try {
        await ensureTable();
        // Update sender's blob
        const [blobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${payload.id} LIMIT 1`;
        if (!blobRow) return res.status(404).json({ ok: false, error: 'No data found.' });
        const ownerData = await _decompress(blobRow.data || {});
        const entry = (ownerData.entries || []).find(e => e.id === entryId);
        if (!entry) return res.status(404).json({ ok: false, error: 'Entry not found.' });
        if (entry.userId && entry.userId !== payload.id) return res.status(403).json({ ok: false, error: 'Not authorized.' });
        entry.status       = 'fulfilled';
        entry.fulfilledAt  = Date.now();
        entry.lastActivityAt = Date.now();
        const recompressed = await _compress(ownerData);
        await sql`UPDATE user_data SET data = ${recompressed}, updated_at = now() WHERE user_id = ${payload.id}`;

        // Update share_tokens entry_data + push notification to recipient(s)
        const rows = await sql`
          SELECT token, entry_data, linked_user_id FROM share_tokens
          WHERE entry_id = ${entryId} AND user_id = ${payload.id}
        `;
        const contact    = (ownerData.contacts || []).find(c => c.id === entry.cId);
        const senderName = contact?.name || payload.email || 'Sender';
        for (const row of rows) {
          const updatedData = { ...row.entry_data, status: 'fulfilled', fulfilledAt: Date.now() };
          await sql`UPDATE share_tokens SET entry_data = ${updatedData} WHERE token = ${row.token}`;
          // Notify + update recipient's blob
          if (row.linked_user_id) {
            try {
              const [recipBlob] = await sql`SELECT data FROM user_data WHERE user_id = ${row.linked_user_id} LIMIT 1`;
              if (recipBlob) {
                const recipData = await _decompress(recipBlob.data || {});
                if (!recipData.notifs) recipData.notifs = [];
                recipData.notifs.push({
                  id:        'n' + Math.random().toString(36).substr(2, 9),
                  userId:    row.linked_user_id,
                  shareToken: row.token,
                  type:      'fulfilled',
                  msg:       `${senderName} marked a record as fulfilled.`,
                  channel:   'in-app',
                  sent:      true,
                  who:       'them',
                  sentTo:    '',
                  read:      false,
                  createdAt: Date.now()
                });
                // Update recipient's isShared entry status
                const recipEntry = (recipData.entries || []).find(e => e.shareToken === row.token);
                if (recipEntry) {
                  recipEntry.status      = 'fulfilled';
                  recipEntry.fulfilledAt = Date.now();
                }
                const rRecompressed = await _compress(recipData);
                await sql`UPDATE user_data SET data = ${rRecompressed}, updated_at = now() WHERE user_id = ${row.linked_user_id}`;
              }
            } catch (recipErr) {
              console.error('[share/mark-fulfilled] recipient update failed:', recipErr.message);
            }
          }
        }
        return res.json({ ok: true, fulfilled: true });
      } catch (e) {
        console.error('[share/mark-fulfilled]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to mark fulfilled.' });
      }
    }

    // ── sender-notify: sender sent a reminder — flag the RECIPIENT's shared entry ──
    // Increments reminderCount + lastActivityAt on the recipient's isShared entry
    // so the 🚩 badge appears on the recipient's Entries page and the item sorts to top.
    if (action === 'sender-notify') {
      const payload = requireAuth(req, res);
      if (!payload) return;
      const { entryId: snEntryId, senderName } = req.body;
      if (!snEntryId) return res.status(400).json({ ok: false, error: 'entryId required' });
      try {
        await ensureTable();
        // Find all share tokens for this entry created by this sender
        const tokens = await sql`
          SELECT token, linked_user_id, entry_data FROM share_tokens
          WHERE entry_id = ${snEntryId} AND user_id = ${payload.id} AND linked_user_id IS NOT NULL
        `;
        let updated = 0;
        for (const tok of tokens) {
          const recipId = tok.linked_user_id;
          if (!recipId || recipId === payload.id) continue; // skip self
          const [blobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${recipId} LIMIT 1`;
          if (!blobRow) continue;
          const recipData = await _decompress(blobRow.data || {});
          // Find the recipient's isShared entry by shareToken
          const recipEntry = (recipData.entries || []).find(e => e.shareToken === tok.token);
          if (recipEntry) {
            recipEntry.reminderCount  = (recipEntry.reminderCount || 0) + 1;
            recipEntry.lastActivityAt = Date.now();
            recipEntry.lastReminderAt = Date.now();
            updated++;
          }
          // Push in-app notification to recipient
          if (!recipData.notifs) recipData.notifs = [];
          recipData.notifs.push({
            id:        'n' + Math.random().toString(36).substr(2, 9),
            userId:    recipId,
            cId:       recipEntry?.cId || null,
            eid:       recipEntry?.id || null,
            shareToken: tok.token,
            type:      'reminder',
            msg:       `${senderName || 'Someone'} sent you a reminder.`,
            channel:   'in-app',
            sent:      true,
            who:       'them',
            sentTo:    '',
            read:      false,
            createdAt: Date.now()
          });
          const recompressed = await _compress(recipData);
          await sql`UPDATE user_data SET data = ${recompressed}, updated_at = now() WHERE user_id = ${recipId}`;
        }
        return res.json({ ok: true, updated });
      } catch (e) {
        console.error('[share/sender-notify]', e.message);
        return res.json({ ok: true, updated: 0 });
      }
    }

    // ── log-reminder: recipient sent a reminder to the original sender ────────
    // Updates the sender's original entry reminderCount + pushes in-app notification.
    // Called by the recipient after successfully emailing the reminder.
    if (action === 'log-reminder') {
      const payload = requireAuth(req, res);
      if (!payload) return;
      const { token: lrToken, recipientName } = req.body;
      if (!lrToken) return res.status(400).json({ ok: false, error: 'token required' });
      try {
        await ensureTable();
        const [tokenRow] = await sql`
          SELECT user_id, entry_id, entry_data FROM share_tokens WHERE token = ${lrToken} LIMIT 1
        `;
        if (!tokenRow) return res.json({ ok: true, updated: false }); // token not found — non-fatal
        const ownerId = tokenRow.user_id;
        const entryId = tokenRow.entry_id;
        const entryData = tokenRow.entry_data;
        // Safety: recipient should not be same as owner (prevents self-flag)
        if (ownerId === payload.id) return res.json({ ok: true, updated: false });
        const [blobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${ownerId} LIMIT 1`;
        if (!blobRow) return res.json({ ok: true, updated: false });
        const ownerData = await _decompress(blobRow.data || {});
        const entry   = (ownerData.entries  || []).find(e => e.id === entryId);
        const contact = entry ? (ownerData.contacts || []).find(c => c.id === entry.cId) : null;
        const remName = recipientName || contact?.name || entryData?.contactName || 'Your contact';
        // Increment reminder count on sender's original entry
        if (entry) {
          entry.reminderCount    = (entry.reminderCount || 0) + 1;
          entry.lastReminderAt   = Date.now();
          entry.lastActivityAt   = Date.now();
        }
        // Push in-app notification to sender
        if (!ownerData.notifs) ownerData.notifs = [];
        ownerData.notifs.push({
          id:        'n' + Math.random().toString(36).substr(2, 9),
          userId:    ownerId,
          cId:       entry?.cId || null,
          eid:       entryId,
          shareToken: lrToken,
          type:      'reminder',
          msg:       `${remName} sent you a reminder about a shared record.`,
          channel:   'in-app',
          sent:      true,
          who:       'them',
          sentTo:    '',
          read:      false,
          createdAt: Date.now()
        });
        const recompressed = await _compress(ownerData);
        await sql`UPDATE user_data SET data = ${recompressed}, updated_at = now() WHERE user_id = ${ownerId}`;
        return res.json({ ok: true, updated: true });
      } catch (e) {
        console.error('[share/log-reminder]', e.message);
        return res.json({ ok: true, updated: false }); // non-fatal — reminder was already sent
      }
    }

    return res.status(400).json({ ok: false, error: 'Invalid action.' });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
