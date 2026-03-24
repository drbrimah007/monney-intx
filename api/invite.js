// /api/invite — email invite system
//
// POST { action:'create', email, name, contactId }  → send invite (auth)
// GET  ?action=check&token=TOKEN                     → validate invite token (public)
// POST { action:'accept', token }                    → accept invite after signup (auth)
// GET  ?action=list                                  → list sent invites (auth)
// POST { action:'resend', token }                    → resend pending invite (auth)
// POST { action:'cancel', token }                    → cancel pending invite (auth)

const { sql }         = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { sendEmail }   = require('../lib/email');
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
      console.error('[invite] decompress failed:', e.message);
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

const INVITE_EXPIRY_DAYS = 7;
const MAX_INVITES_PER_DAY = 10;
const APP_URL = process.env.SITE_URL || process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://moneyinteractions.com';

function getSiteUrl() {
  return process.env.SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://moneyinteractions.com');
}

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function isExpired(createdAt) {
  const created = new Date(createdAt);
  const now = new Date();
  const diffDays = (now - created) / (1000 * 60 * 60 * 24);
  return diffDays > INVITE_EXPIRY_DAYS;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET routes ─────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const action = req.query.action;

    // GET ?action=check&token=TOKEN — public, no auth
    if (action === 'check') {
      const token = req.query.token;
      if (!token) return res.status(400).json({ ok: false, error: 'Token required.' });

      try {
        const rows = await sql`
          SELECT it.email, it.name, it.status, it.created_at, it.inviter_id,
                 u.display_name AS inviter_name
          FROM invite_tokens it
          JOIN users u ON u.id = it.inviter_id
          WHERE it.token = ${token}
          LIMIT 1
        `;
        if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Invite not found.' });

        const row = rows[0];
        if (row.status !== 'pending') return res.status(410).json({ ok: false, error: 'This invite has already been used or cancelled.' });
        if (isExpired(row.created_at)) return res.status(410).json({ ok: false, error: 'This invite has expired.' });

        return res.json({
          ok: true,
          inviterName: row.inviter_name,
          email: row.email,
          name: row.name || ''
        });
      } catch (e) {
        console.error('[invite/check]', e.message);
        return res.status(500).json({ ok: false, error: e.message });
      }
    }

    // GET ?action=list — list sent invites (auth)
    if (action === 'list') {
      const payload = requireAuth(req, res);
      if (!payload) return;

      try {
        const rows = await sql`
          SELECT token, email, name, status, created_at, accepted_at, accepted_by
          FROM invite_tokens
          WHERE inviter_id = ${payload.id}
          ORDER BY created_at DESC
          LIMIT 50
        `;
        const invites = rows.map(r => ({
          token: r.token,
          email: r.email,
          name: r.name || '',
          status: isExpired(r.created_at) && r.status === 'pending' ? 'expired' : r.status,
          createdAt: r.created_at,
          acceptedAt: r.accepted_at
        }));
        return res.json({ ok: true, invites });
      } catch (e) {
        console.error('[invite/list]', e.message);
        return res.status(500).json({ ok: false, error: e.message });
      }
    }

    return res.status(400).json({ ok: false, error: 'Invalid action.' });
  }

  // ── POST routes ────────────────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const { action } = req.body || {};

  // ── POST action=create ─────────────────────────────────────────────────
  if (action === 'create') {
    const payload = requireAuth(req, res);
    if (!payload) return;

    const { email, name, contactId } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ ok: false, error: 'A valid email is required.' });

    const normalizedEmail = email.trim().toLowerCase();

    // Can't invite yourself
    if (normalizedEmail === payload.email?.toLowerCase()) {
      return res.status(400).json({ ok: false, error: 'You cannot invite yourself.' });
    }

    try {
      // Rate limit: max 10 invites per user per day
      const [countRow] = await sql`
        SELECT COUNT(*) AS cnt FROM invite_tokens
        WHERE inviter_id = ${payload.id}
          AND created_at > now() - interval '1 day'
      `;
      if (parseInt(countRow.cnt) >= MAX_INVITES_PER_DAY) {
        return res.status(429).json({ ok: false, error: 'Daily invite limit reached (max 10). Try again tomorrow.' });
      }

      // Check if email already belongs to a registered user
      const [existingUser] = await sql`
        SELECT id, display_name FROM users WHERE LOWER(email) = ${normalizedEmail} LIMIT 1
      `;

      if (existingUser) {
        // Auto-link the contact instead of sending invite
        if (contactId) {
          const [blobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${payload.id} LIMIT 1`;
          if (blobRow) {
            const data = await _decompress(blobRow.data || {});
            const contact = (data.contacts || []).find(c => c.id === contactId);
            if (contact) {
              contact.linkedUserId = existingUser.id;
              const compressed = await _compress(data);
              await sql`UPDATE user_data SET data = ${compressed}, updated_at = now() WHERE user_id = ${payload.id}`;
            }
          }
        }
        return res.json({ ok: true, alreadyRegistered: true, linkedName: existingUser.display_name });
      }

      // Check for duplicate pending invite to same email from same user
      const [existingInvite] = await sql`
        SELECT token FROM invite_tokens
        WHERE inviter_id = ${payload.id}
          AND LOWER(email) = ${normalizedEmail}
          AND status = 'pending'
        LIMIT 1
      `;
      if (existingInvite && !isExpired(existingInvite.created_at)) {
        return res.status(409).json({ ok: false, error: 'An invite to this email is already pending.' });
      }

      // Generate token and store
      const token = generateToken();
      await sql`
        INSERT INTO invite_tokens (token, inviter_id, inviter_contact_id, email, name, status)
        VALUES (${token}, ${payload.id}, ${contactId || null}, ${normalizedEmail}, ${name || null}, 'pending')
      `;

      // Get inviter display name
      const [inviterRow] = await sql`SELECT display_name FROM users WHERE id = ${payload.id} LIMIT 1`;
      const inviterName = inviterRow?.display_name || 'Someone';
      const siteUrl = getSiteUrl();
      const inviteLink = `${siteUrl}?invite=${token}`;

      // Send invite email
      const emailResult = await sendEmail({
        to: normalizedEmail,
        subject: `${inviterName} invited you to Money IntX`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:0;background:#f9f9f9;">
            <div style="background:#1a1a2e;padding:20px 32px 16px;border-radius:12px 12px 0 0;text-align:center;">
              <img src="${siteUrl}/money.png" alt="Money IntX" style="height:48px;max-width:180px;object-fit:contain;display:block;margin:0 auto 8px;" onerror="this.style.display='none'">
            </div>
            <div style="background:#fff;padding:32px 32px 24px;border-left:1px solid #eee;border-right:1px solid #eee;">
              <h2 style="margin:0 0 6px;font-size:22px;color:#1a1a2e;">You're Invited!</h2>
              <p style="color:#555;font-size:14px;margin-bottom:20px;">
                <strong>${inviterName}</strong> has invited you to join <strong>Money IntX</strong> to track financial interactions together.
              </p>
              ${name ? `<p style="color:#666;font-size:14px;">They've added you as <strong>${name}</strong> in their contacts.</p>` : ''}
              <div style="text-align:center;margin:28px 0;">
                <a href="${inviteLink}"
                   style="display:inline-block;padding:13px 32px;background:#6c63ff;color:#fff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">
                  Create Your Account
                </a>
              </div>
              <p style="color:#888;font-size:13px;">
                This invite expires in 7 days. Click the button above to sign up and get connected with ${inviterName}.
              </p>
            </div>
            <div style="background:#f0f0f0;padding:16px 32px;border-radius:0 0 12px 12px;border:1px solid #eee;border-top:none;text-align:center;">
              <p style="margin:0 0 4px;font-size:12px;color:#888;">Money IntX — Making Money Matters Memorable</p>
              <p style="margin:0;font-size:12px;color:#aaa;"><a href="${siteUrl}" style="color:#6c63ff;text-decoration:none;">${siteUrl.replace(/^https?:\/\//, '')}</a></p>
            </div>
          </div>`,
        text: `${inviterName} has invited you to join Money IntX to track financial interactions.\n\nCreate your account: ${inviteLink}\n\nThis invite expires in 7 days.\n\n— Money IntX`
      });

      return res.json({ ok: true, token, emailSent: emailResult.ok });

    } catch (e) {
      console.error('[invite/create]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── POST action=accept ─────────────────────────────────────────────────
  if (action === 'accept') {
    const payload = requireAuth(req, res);
    if (!payload) return;

    const { token } = req.body;
    if (!token) return res.status(400).json({ ok: false, error: 'Token required.' });

    try {
      const rows = await sql`
        SELECT it.token, it.inviter_id, it.inviter_contact_id, it.email, it.name, it.status, it.created_at,
               u.display_name AS inviter_name, u.email AS inviter_email
        FROM invite_tokens it
        JOIN users u ON u.id = it.inviter_id
        WHERE it.token = ${token}
        LIMIT 1
      `;
      if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Invite not found.' });

      const invite = rows[0];
      if (invite.status !== 'pending') return res.status(410).json({ ok: false, error: 'This invite has already been used.' });
      if (isExpired(invite.created_at)) return res.status(410).json({ ok: false, error: 'This invite has expired.' });

      // Mark invite as accepted
      await sql`
        UPDATE invite_tokens
        SET status = 'accepted', accepted_at = now(), accepted_by = ${payload.id}
        WHERE token = ${token}
      `;

      // ── Auto-link inviter's contact to new user ──────────────────────
      const inviterId = invite.inviter_id;
      const contactId = invite.inviter_contact_id;

      if (contactId) {
        const [blobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${inviterId} LIMIT 1`;
        if (blobRow) {
          const data = await _decompress(blobRow.data || {});
          const contact = (data.contacts || []).find(c => c.id === contactId);
          if (contact) {
            contact.linkedUserId = payload.id;
            const compressed = await _compress(data);
            await sql`UPDATE user_data SET data = ${compressed}, updated_at = now() WHERE user_id = ${inviterId}`;
          }
        }
      }

      // ── Auto-link reciprocal: create/update contact for inviter in new user's data ──
      const [newUserBlobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${payload.id} LIMIT 1`;
      if (newUserBlobRow) {
        const newUserData = await _decompress(newUserBlobRow.data || {});
        if (!newUserData.contacts) newUserData.contacts = [];

        // Look for existing contact by inviter email
        const inviterEmailLower = (invite.inviter_email || '').toLowerCase();
        let recipContact = newUserData.contacts.find(c =>
          (c.email || '').toLowerCase() === inviterEmailLower
        );

        if (recipContact) {
          // Update existing contact with linkedUserId
          recipContact.linkedUserId = inviterId;
        } else {
          // Create new contact for the inviter
          const newContactId = 'c' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
          recipContact = {
            id: newContactId,
            name: invite.inviter_name || 'Unknown',
            email: invite.inviter_email || '',
            phone: '',
            address: '',
            notes: '',
            tags: [],
            linkedUserId: inviterId,
            createdAt: Date.now()
          };
          newUserData.contacts.push(recipContact);
        }

        const compressed = await _compress(newUserData);
        await sql`UPDATE user_data SET data = ${compressed}, updated_at = now() WHERE user_id = ${payload.id}`;
      }

      // Push in-app notification to inviter
      try {
        const [inviterBlobRow] = await sql`SELECT data FROM user_data WHERE user_id = ${inviterId} LIMIT 1`;
        if (inviterBlobRow) {
          const inviterData = await _decompress(inviterBlobRow.data || {});
          if (!inviterData.notifs) inviterData.notifs = [];
          inviterData.notifs.push({
            id:        'n' + Math.random().toString(36).substr(2, 9),
            userId:    inviterId,
            type:      'invite_accepted',
            msg:       `${payload.displayName || invite.email} accepted your invite and joined the platform!`,
            channel:   'in-app',
            sent:      true,
            read:      false,
            createdAt: Date.now()
          });
          const compressed = await _compress(inviterData);
          await sql`UPDATE user_data SET data = ${compressed}, updated_at = now() WHERE user_id = ${inviterId}`;
        }
      } catch (notifErr) {
        console.error('[invite/accept] notification push failed:', notifErr.message);
      }

      return res.json({ ok: true, inviterName: invite.inviter_name });

    } catch (e) {
      console.error('[invite/accept]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── POST action=resend ─────────────────────────────────────────────────
  if (action === 'resend') {
    const payload = requireAuth(req, res);
    if (!payload) return;

    const { token } = req.body;
    if (!token) return res.status(400).json({ ok: false, error: 'Token required.' });

    try {
      const [row] = await sql`
        SELECT token, email, name, status, created_at, inviter_id, inviter_contact_id
        FROM invite_tokens WHERE token = ${token} AND inviter_id = ${payload.id} LIMIT 1
      `;
      if (!row) return res.status(404).json({ ok: false, error: 'Invite not found.' });
      if (row.status !== 'pending') return res.status(400).json({ ok: false, error: 'Can only resend pending invites.' });

      // If expired, create a new token instead
      let activeToken = token;
      let inviteEmail = row.email;
      if (isExpired(row.created_at)) {
        // Mark old as expired, create fresh token
        await sql`UPDATE invite_tokens SET status = 'expired' WHERE token = ${token}`;
        activeToken = generateToken();
        await sql`
          INSERT INTO invite_tokens (token, inviter_id, inviter_contact_id, email, name, status)
          VALUES (${activeToken}, ${payload.id}, ${row.inviter_contact_id || null}, ${row.email}, ${row.name || null}, 'pending')
        `;
      }

      const [inviterRow] = await sql`SELECT display_name FROM users WHERE id = ${payload.id} LIMIT 1`;
      const inviterName = inviterRow?.display_name || 'Someone';
      const siteUrl = getSiteUrl();
      const inviteLink = `${siteUrl}?invite=${activeToken}`;

      const emailResult = await sendEmail({
        to: inviteEmail,
        subject: `Reminder: ${inviterName} invited you to Money IntX`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:0;background:#f9f9f9;">
            <div style="background:#1a1a2e;padding:20px 32px 16px;border-radius:12px 12px 0 0;text-align:center;">
              <img src="${siteUrl}/money.png" alt="Money IntX" style="height:48px;max-width:180px;object-fit:contain;display:block;margin:0 auto 8px;" onerror="this.style.display='none'">
            </div>
            <div style="background:#fff;padding:32px 32px 24px;border-left:1px solid #eee;border-right:1px solid #eee;">
              <h2 style="margin:0 0 6px;font-size:22px;color:#1a1a2e;">Reminder: You're Invited!</h2>
              <p style="color:#555;font-size:14px;margin-bottom:20px;">
                <strong>${inviterName}</strong> is waiting for you on <strong>Money IntX</strong> to track financial interactions together.
              </p>
              <div style="text-align:center;margin:28px 0;">
                <a href="${inviteLink}"
                   style="display:inline-block;padding:13px 32px;background:#6c63ff;color:#fff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">
                  Create Your Account
                </a>
              </div>
              <p style="color:#888;font-size:13px;">This invite expires in 7 days.</p>
            </div>
            <div style="background:#f0f0f0;padding:16px 32px;border-radius:0 0 12px 12px;border:1px solid #eee;border-top:none;text-align:center;">
              <p style="margin:0 0 4px;font-size:12px;color:#888;">Money IntX — Making Money Matters Memorable</p>
            </div>
          </div>`,
        text: `Reminder: ${inviterName} invited you to Money IntX.\n\nCreate your account: ${inviteLink}\n\n— Money IntX`
      });

      return res.json({ ok: true, emailSent: emailResult.ok, newToken: activeToken !== token ? activeToken : undefined });

    } catch (e) {
      console.error('[invite/resend]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── POST action=cancel ─────────────────────────────────────────────────
  if (action === 'cancel') {
    const payload = requireAuth(req, res);
    if (!payload) return;

    const { token } = req.body;
    if (!token) return res.status(400).json({ ok: false, error: 'Token required.' });

    try {
      const result = await sql`
        UPDATE invite_tokens SET status = 'cancelled'
        WHERE token = ${token} AND inviter_id = ${payload.id} AND status = 'pending'
      `;
      return res.json({ ok: true });
    } catch (e) {
      console.error('[invite/cancel]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  return res.status(400).json({ ok: false, error: 'Invalid action. Use create, accept, resend, or cancel.' });
};
