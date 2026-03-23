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

    // GET ?linked=1 — return all records shared with the current user (auth)
    if (req.query.linked) {
      const payload = requireAuth(req, res);
      if (!payload) return;
      try {
        await ensureTable();
        const rows = await sql`
          SELECT token, entry_data, acknowledged, acknowledged_at, linked_at, created_at,
                 recipient_closed, confirmed
          FROM share_tokens
          WHERE linked_user_id = ${payload.id}
          ORDER BY linked_at DESC NULLS LAST
        `;
        return res.json({ ok: true, shared: rows.map(r => ({
          token:           r.token,
          entry:           r.entry_data,
          acknowledged:    r.acknowledged,
          acknowledgedAt:  r.acknowledged_at,
          linkedAt:        r.linked_at,
          sharedAt:        r.created_at,
          recipientClosed: r.recipient_closed,
          confirmed:       r.confirmed
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
      if (!row.viewed) {
        await sql`
          UPDATE share_tokens SET viewed = true, viewed_at = now()
          WHERE token = ${token}
        `;
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
            // Re-compress before writing back
            const recompressed = await _compress(ownerData);
            await sql`UPDATE user_data SET data = ${recompressed}, updated_at = now() WHERE user_id = ${ownerId}`;
          }
        } catch (innerErr) {
          console.error('[share/view] notif push failed:', innerErr.message);
        }
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
        return res.json({ ok: true });
      } catch (e) {
        console.error('[share/confirm-shared]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to confirm record.' });
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
        const fromName = payload.displayName || payload.email || appName;

        let created = 0;
        for (const e of entries) {
          if (e.status === 'voided') continue;
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
          SELECT token, entry_data FROM share_tokens
          WHERE entry_id = ${entryId} AND user_id = ${payload.id}
        `;
        for (const row of rows) {
          const updated = { ...row.entry_data, status };
          if (amount     !== undefined) updated.amount    = amount;
          if (settledAt  !== undefined) updated.settledAt = settledAt;
          if (settledAmt !== undefined) updated.settledAmt = settledAmt;
          if (remaining  !== undefined) updated.remaining  = remaining;
          // Mark that a new settlement is pending recipient confirmation
          if (settledAmt !== undefined && settledAmt > 0) {
            updated.settlementPending = true;
            updated.settlementConfirmed = updated.settlementConfirmed || false;
          }
          await sql`UPDATE share_tokens SET entry_data = ${updated} WHERE token = ${row.token}`;
        }
        return res.json({ ok: true, synced: rows.length });
      } catch (e) {
        console.error('[share/sync-status]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to sync status.' });
      }
    }

    // ── confirm-settlement: recipient acknowledges a settlement ──────────────
    if (action === 'confirm-settlement') {
      const { token: cToken } = req.body;
      if (!cToken) return res.status(400).json({ ok: false, error: 'token required' });
      try {
        await ensureTable();
        const rows = await sql`SELECT token, entry_data FROM share_tokens WHERE token = ${cToken}`;
        if (!rows.length) return res.status(404).json({ ok: false, error: 'Token not found' });
        const updated = { ...rows[0].entry_data, settlementConfirmed: true, settlementPending: false };
        await sql`UPDATE share_tokens SET entry_data = ${updated} WHERE token = ${cToken}`;
        return res.json({ ok: true });
      } catch (e) {
        console.error('[share/confirm-settlement]', e.message);
        return res.status(500).json({ ok: false, error: 'Failed to confirm settlement.' });
      }
    }

    return res.status(400).json({ ok: false, error: 'Invalid action.' });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
