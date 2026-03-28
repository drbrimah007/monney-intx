// Money IntX v2 — Email Module
// Sends transactional emails via /api/send-email (Vercel serverless → Resend)
import { supabase } from './supabase.js';

const TX_LABELS = {
  // v2 categories
  owed_to_me:       'Owed to Me',
  i_owe:            'I Owe',
  invoice_sent:     'Invoice Sent',
  invoice_received: 'Invoice Received',
  bill_sent:        'Bill Sent',
  bill_received:    'Bill Received',
  advance_paid:     'Advance Sent',
  advance_received: 'Advance Received',
  payment_recorded: 'Payment Recorded',
  // legacy
  they_owe_you:  'They Owe You',
  you_owe_them:  'You Owe Them',
  they_paid_you: 'They Settled Up',
  you_paid_them: 'You Settled Up',
  invoice:       'Invoice',
  bill:          'Bill'
};

// ── Brand constants ────────────────────────────────────────────────────────────
const BRAND = {
  name: 'Money IntX',
  color: '#080b53',       // Money IntX navy blue (from logo)
  colorDark: '#14186a',
  bg: '#f8fafc',
  cardBg: '#ffffff',
  text: '#1e293b',
  muted: '#64748b',
  border: '#e2e8f0',
  logoUrl: 'https://moneyintx.com/money.png',
  siteUrl: 'https://moneyintx.com'
};

// ── HTML escape helper ────────────────────────────────────────────────────────
function _escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Shared rich email builder (dark header, V1 style) ─────────────────────────
function _richEmail({ logoUrl, siteName = 'Money IntX', siteUrl = 'https://moneyintx.com',
    heading, subheading, bodyHtml, footerNote = '' }) {
  const validLogo = (logoUrl && /^https?:\/\//.test(logoUrl)) ? logoUrl : `${siteUrl}/money.png`;
  const logoImg   = `<img src="${_escHtml(validLogo)}" alt="${_escHtml(siteName)}" style="max-height:60px;max-width:220px;width:auto;height:auto;object-fit:contain;display:block;margin:0 auto;" onerror="this.style.display='none'">`;
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:0;background:#f9f9f9;">
    <div style="background:#080b53;padding:22px 32px 18px;border-radius:12px 12px 0 0;text-align:center;">
      ${logoImg}
    </div>
    <div style="background:#fff;padding:32px 32px 24px;border-left:1px solid #eee;border-right:1px solid #eee;">
      <h2 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#080b53;">${heading}</h2>
      ${subheading ? `<p style="color:#555;font-size:14px;margin-bottom:20px;line-height:1.6;">${subheading}</p>` : ''}
      ${bodyHtml}
    </div>
    <div style="background:#f0f0f0;padding:16px 32px;border-radius:0 0 12px 12px;border:1px solid #eee;border-top:none;text-align:center;">
      <p style="margin:0 0 4px;font-size:12px;color:#888;">${_escHtml(siteName)} — Making Money Matters Memorable</p>
      <p style="margin:0;font-size:12px;color:#aaa;"><a href="${_escHtml(siteUrl)}" style="color:#080b53;text-decoration:none;">${siteUrl.replace(/^https?:\/\//, '')}</a></p>
      ${footerNote ? `<p style="margin:6px 0 0;font-size:11px;color:#bbb;">${footerNote}</p>` : ''}
    </div>
  </div>`;
}



// ── Base email wrapper ─────────────────────────────────────────────────────────
function baseTemplate({ title, preheader, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    body { margin:0; padding:0; background:${BRAND.bg}; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }
    .wrapper { max-width:580px; margin:32px auto; background:${BRAND.cardBg}; border-radius:12px; border:1px solid ${BRAND.border}; overflow:hidden; }
    .header { background:${BRAND.color}; padding:24px 32px; text-align:center; }
    .header img { max-height:64px; max-width:220px; width:auto; height:auto; border-radius:8px; object-fit:contain; }
    .body { padding:32px; color:${BRAND.text}; font-size:15px; line-height:1.6; }
    .body h2 { margin:0 0 16px; font-size:20px; font-weight:700; color:${BRAND.text}; }
    .amount-box { background:${BRAND.bg}; border:1px solid ${BRAND.border}; border-radius:10px; padding:18px 22px; margin:20px 0; }
    .amount-box .label { font-size:12px; color:${BRAND.muted}; text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px; }
    .amount-box .value { font-size:28px; font-weight:800; color:${BRAND.colorDark}; }
    .detail-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid ${BRAND.border}; font-size:14px; }
    .detail-row:last-child { border-bottom:none; }
    .detail-row .k { color:${BRAND.muted}; }
    .detail-row .v { font-weight:600; color:${BRAND.text}; }
    .message-box { background:#f0fdf4; border-left:4px solid #22c55e; border-radius:0 8px 8px 0; padding:12px 16px; margin:20px 0; font-size:14px; color:#166534; }
    .btn { display:inline-block; background:${BRAND.color}; color:#fff !important; text-decoration:none; padding:12px 28px; border-radius:8px; font-weight:700; font-size:15px; margin:20px 0; }
    .footer { padding:20px 32px; text-align:center; font-size:12px; color:${BRAND.muted}; border-top:1px solid ${BRAND.border}; background:${BRAND.bg}; }
    .footer a { color:${BRAND.color}; text-decoration:none; }
    .badge { display:inline-block; background:${BRAND.color}1a; color:${BRAND.colorDark}; border-radius:20px; padding:3px 12px; font-size:12px; font-weight:700; margin-bottom:12px; }
    @media(max-width:600px) { .wrapper { margin:0; border-radius:0; } .body { padding:20px; } }
  </style>
</head>
<body>
  <!-- preheader hidden text -->
  <span style="display:none;max-height:0;overflow:hidden;">${preheader}</span>

  <div class="wrapper">
    <div class="header">
      <img src="${BRAND.logoUrl}" alt="Money IntX Logo">
    </div>
    <div class="body">
      ${body}
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} Money IntX · Record · Manage · Grow</p>
      <p><a href="${BRAND.siteUrl}">Open App</a> · <a href="${BRAND.siteUrl}?page=settings">Manage Notifications</a></p>
      <p style="margin-top:8px;color:#94a3b8;font-size:11px;">This email was sent because you have an active record in Money IntX. It is not a payment request or financial instrument.</p>
    </div>
  </div>
</body>
</html>`;
}

// ── Store email record in log ──────────────────────────────────────────────────
export async function logEmail(userId, { type, recipient, subject, status = 'sent', error = '', entryId = null }) {
  await supabase.from('email_log').insert({
    user_id: userId, type, recipient, subject, status, error, entry_id: entryId
  });
}

// ── Send via /api/send-email serverless function ───────────────────────────────
async function callSendEmail({ to, subject, html, text }) {
  try {
    const res = await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, html, text })
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('[callSendEmail] Failed:', data.error || 'Unknown error');
    }
    return data;
  } catch (err) {
    console.error('[callSendEmail] Network/parse error:', err);
    return { ok: false, error: 'Network error: ' + err.message };
  }
}

// ── Notification / Reminder email ─────────────────────────────────────────────
export async function sendNotificationEmail(userId, {
  to, fromName, fromEmail, txType, amount, currency = 'USD', message, entryId,
  shareLink, isReminder = false, logoUrl, siteUrl, entryStatus,
  isSelf = false, contactName = ''
}) {
  // Map V2 categories to contact-perspective direction
  const DIR = {
    owed_to_me: 'they_owe_you',      // contact owes sender  → contact sees "I Owe Them"
    i_owe:      'you_owe_them',      // sender owes contact  → contact sees "They Owe Me"
    bill_sent:  'bill',              // contact receives bill
    invoice_sent: 'invoice',         // contact receives invoice
    bill_received: 'you_owe_them',   // sender got bill → contact is creditor
    invoice_received: 'you_owe_them',
    advance_paid: 'advance_to_you',  // sender paid advance to contact
    advance_received: 'advance_from_you',
    payment_recorded: 'they_paid_you',
    // legacy
    they_owe_you: 'they_owe_you', you_owe_them: 'you_owe_them',
    they_paid_you: 'they_paid_you', you_paid_them: 'you_paid_them',
    invoice: 'invoice', bill: 'bill',
  };
  const dir = DIR[txType] || 'they_owe_you';
  const isPartial = entryStatus === 'partially_settled';

  let subject, heading, subheading, amtLabel;
  if (dir === 'you_owe_them') {
    subject    = isReminder ? `Reminder: They Owe Me — from ${fromName}` : `They Owe Me — record from ${fromName}`;
    heading    = isReminder ? 'Reminder — They Owe Me' : 'They Owe Me';
    subheading = `<strong>${fromName}</strong> has recorded that they owe you this amount.`;
    amtLabel   = 'Amount Owed to You';
  } else if (dir === 'you_paid_them') {
    subject    = `They Settled Me — payment from ${fromName}`;
    heading    = 'They Settled Me';
    subheading = `<strong>${fromName}</strong> has recorded making a payment to you.`;
    amtLabel   = 'Amount Paid to You';
  } else if (dir === 'they_paid_you') {
    subject    = `I Settled Them — settlement recorded by ${fromName}`;
    heading    = 'I Settled Them';
    subheading = `<strong>${fromName}</strong> has recorded that you settled a balance with them.`;
    amtLabel   = 'Amount Settled';
  } else if (dir === 'invoice' || dir === 'bill') {
    const doc  = dir === 'invoice' ? 'Invoice' : 'Bill';
    subject    = isReminder ? `Reminder: ${doc} from ${fromName}` : `${doc} from ${fromName}`;
    heading    = isReminder ? `Reminder — ${doc} Due` : `${doc} Due`;
    subheading = `<strong>${fromName}</strong> has sent you a ${doc.toLowerCase()} for the following amount.`;
    amtLabel   = `${doc} Amount Due`;
  } else if (dir === 'advance_to_you') {
    subject    = `Advance Received — from ${fromName}`;
    heading    = 'Advance Received';
    subheading = `<strong>${fromName}</strong> has recorded sending you an advance.`;
    amtLabel   = 'Advance Amount';
  } else if (dir === 'advance_from_you') {
    subject    = `Advance Sent — record from ${fromName}`;
    heading    = 'Advance Sent';
    subheading = `<strong>${fromName}</strong> has recorded receiving an advance from you.`;
    amtLabel   = 'Advance Amount';
  } else {
    // they_owe_you → contact sees "I Owe Them"
    subject    = isReminder
      ? `Reminder: I Owe Them — from ${fromName}`
      : (isPartial ? `Partial balance still due — from ${fromName}` : `I Owe Them — record from ${fromName}`);
    heading    = isReminder ? 'Reminder — I Owe Them' : (isPartial ? 'Balance Still Outstanding' : 'I Owe Them');
    subheading = isPartial
      ? `<strong>${fromName}</strong> has recorded a partial settlement. A balance is still outstanding.`
      : `<strong>${fromName}</strong> has shared a record showing you owe this amount.`;
    amtLabel   = isPartial ? 'Balance Remaining' : 'Amount I Owe';
  }

  // Self-perspective overrides: flip to sender's own POV
  if (isSelf) {
    const cLabel = contactName || fromName;
    if (txType === 'owed_to_me' || dir === 'they_owe_you') {
      heading    = isReminder ? 'Reminder Sent — They Owe Me' : 'They Owe Me';
      subject    = isReminder ? `Reminder Sent — They Owe Me · ${cLabel}` : `They Owe Me — your record for ${cLabel}`;
      subheading = `You have recorded that <strong>${cLabel}</strong> owes you this amount.`;
      amtLabel   = 'Amount Owed to You';
    } else if (txType === 'i_owe' || dir === 'you_owe_them') {
      heading    = isReminder ? 'Reminder Sent — I Owe Them' : 'I Owe Them';
      subject    = isReminder ? `Reminder Sent — I Owe Them · ${cLabel}` : `I Owe Them — your record for ${cLabel}`;
      subheading = `You have recorded that you owe <strong>${cLabel}</strong> this amount.`;
      amtLabel   = 'Amount I Owe';
    } else if (dir === 'invoice' || txType === 'invoice_sent') {
      heading    = 'Invoice Sent';
      subject    = `Invoice Sent — your record for ${cLabel}`;
      subheading = `You have sent an invoice to <strong>${cLabel}</strong>.`;
      amtLabel   = 'Invoice Amount';
    } else if (dir === 'bill' || txType === 'bill_sent') {
      heading    = 'Bill Sent';
      subject    = `Bill Sent — your record for ${cLabel}`;
      subheading = `You have sent a bill to <strong>${cLabel}</strong>.`;
      amtLabel   = 'Bill Amount';
    } else {
      heading    = isReminder ? `Reminder Sent — ${heading}` : heading;
      subject    = isReminder ? `Reminder Sent: ${subject}` : `Sent: ${subject}`;
      subheading = `You have recorded this interaction with <strong>${cLabel}</strong>.`;
    }
  }

  // Format amount using Intl (handles all currencies correctly)
  function _fmt(val) {
    const n = parseFloat(val);
    if (isNaN(n)) return String(val);
    const code = (currency || 'USD').toUpperCase();
    const noDecimals = ['JPY','KRW','VND'].includes(code);
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: code,
        minimumFractionDigits: noDecimals ? 0 : 2,
        maximumFractionDigits: noDecimals ? 0 : 2
      }).format(n);
    } catch (_) {
      return code + ' ' + n.toFixed(noDecimals ? 0 : 2);
    }
  }
  const fmtAmt = typeof amount === 'number' ? _fmt(amount) : (amount || '');

  // Profile logo in header (falls back to default)
  const logoSrc = (logoUrl && /^https?:\/\//i.test(logoUrl)) ? logoUrl : BRAND.logoUrl;

  // Message block
  const msgHtml = message
    ? `<div style="background:#f5f5ff;border-left:4px solid #080b53;border-radius:4px;padding:14px 18px;margin-bottom:18px;font-size:14px;color:#333;line-height:1.6;">${message}</div>`
    : '';

  // Amount block
  const amtHtml = fmtAmt
    ? `<div style="margin-bottom:18px;"><div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">${amtLabel}</div><strong style="font-size:28px;font-weight:800;color:#080b53;">${fmtAmt}</strong></div>`
    : '';

  // Contact reach line (hidden on self-copies — you know your own email)
  const replyHtml = (!isSelf && fromEmail)
    ? `<p style="color:#666;font-size:13px;margin-top:8px;">You can reach them: <a href="mailto:${fromEmail}" style="color:#080b53;">${fromEmail}</a></p>`
    : '';

  const siteName = 'Money IntX';
  const siteBase = siteUrl || BRAND.siteUrl;
  const ctaUrl   = shareLink || siteBase;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f9f9f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;">${fromName} ${isReminder ? 'is following up' : 'sent a record'} — ${fmtAmt}</span>
  <div style="max-width:520px;margin:32px auto;">
    <div style="background:#080b53;padding:22px 32px 18px;border-radius:12px 12px 0 0;text-align:center;">
      <img src="${logoSrc}" alt="${siteName}" style="max-height:60px;max-width:200px;width:auto;height:auto;object-fit:contain;display:block;margin:0 auto;" onerror="this.style.display='none'">
    </div>
    <div style="background:#fff;padding:32px 32px 24px;border-left:1px solid #eee;border-right:1px solid #eee;">
      <h2 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#080b53;">${heading}</h2>
      <p style="color:#555;font-size:14px;margin:0 0 20px;">${subheading}</p>
      ${msgHtml}
      ${amtHtml}
      ${entryId ? `<p style="font-size:13px;color:#888;margin-bottom:16px;">Reference: <strong>#${String(entryId).slice(-6).toUpperCase()}</strong></p>` : ''}
      <div style="text-align:center;margin:24px 0;">
        <a href="${ctaUrl}" style="display:inline-block;padding:13px 32px;background:#080b53;color:#fff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">View on ${siteName} →</a>
      </div>
      ${replyHtml}
      <p style="font-size:12px;color:#94a3b8;margin-top:20px;">Money IntX does not hold or transfer money. This email is for record-keeping purposes only.</p>
    </div>
    <div style="background:#f0f0f0;padding:14px 32px;border-radius:0 0 12px 12px;border:1px solid #eee;border-top:none;text-align:center;">
      <p style="margin:0 0 4px;font-size:12px;color:#888;">${siteName} — Making Money Matters Memorable</p>
      <p style="margin:0;font-size:12px;"><a href="${siteBase}" style="color:#080b53;text-decoration:none;">${siteBase.replace(/^https?:\/\//, '')}</a></p>
    </div>
  </div>
</body>
</html>`;

  const text = `${heading}\n\n${subheading.replace(/<[^>]+>/g,'')}\n\n${amtLabel}: ${fmtAmt}${message ? '\n\nMessage: ' + message : ''}${entryId ? '\nReference: #' + String(entryId).slice(-6).toUpperCase() : ''}\n\nView: ${ctaUrl}\n\n— ${siteName}`;

  const result = await callSendEmail({ to, subject, html, text });
  const status = result.ok ? 'sent' : 'failed';
  await logEmail(userId, { type: isReminder ? 'reminder' : 'notification', recipient: to, subject, status, error: result.error || '', entryId });
  return { ok: result.ok, subject };
}

// ── Invoice email ──────────────────────────────────────────────────────────────
export async function sendInvoiceEmail(userId, {
  to, fromName, invoiceNumber, amount, currency = 'USD',
  companyName, companyEmail, companyAddress, logoUrl,
  dueDate, lineItems = [], message, entryId, shareLink
}) {
  const subject = `Invoice ${invoiceNumber} from ${companyName || fromName}`;

  const lineItemsHtml = lineItems.length
    ? `<div style="margin:16px 0;">
        <div style="font-size:12px;color:${BRAND.muted};text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Items</div>
        ${lineItems.map(item => `
          <div class="detail-row">
            <span class="k">${item.description}</span>
            <span class="v">${currency} ${Number(item.amount).toLocaleString('en-US', {minimumFractionDigits:2})}</span>
          </div>`).join('')}
      </div>`
    : '';

  const senderLogoHtml = logoUrl
    ? `<img src="${logoUrl}" alt="${companyName || fromName}" style="max-height:48px;max-width:140px;border-radius:6px;margin-bottom:8px;">`
    : '';

  const body = `
    <div style="margin-bottom:16px;">
      ${senderLogoHtml}
      <div class="badge">🧾 Invoice</div>
    </div>
    <h2>Invoice from ${companyName || fromName}</h2>

    <div>
      <div class="detail-row"><span class="k">Invoice #</span><span class="v">${invoiceNumber}</span></div>
      <div class="detail-row"><span class="k">From</span><span class="v">${companyName || fromName}${companyEmail ? ` &lt;${companyEmail}&gt;` : ''}</span></div>
      ${companyAddress ? `<div class="detail-row"><span class="k">Address</span><span class="v">${companyAddress}</span></div>` : ''}
      ${dueDate ? `<div class="detail-row"><span class="k">Due Date</span><span class="v">${dueDate}</span></div>` : ''}
    </div>

    ${lineItemsHtml}

    <div class="amount-box">
      <div class="label">Total Amount Due</div>
      <div class="value">${currency} ${Number(amount).toLocaleString('en-US', {minimumFractionDigits:2})}</div>
    </div>

    ${message ? `<div class="message-box"><strong>Note:</strong> ${message}</div>` : ''}

    ${shareLink ? `<a class="btn" href="${shareLink}">View Invoice →</a>` : `<a class="btn" href="${BRAND.siteUrl}">Open Money IntX →</a>`}

    <p style="font-size:12px;color:${BRAND.muted};margin-top:20px;">This is a record-keeping notification. Money IntX does not process payments or hold funds.</p>
  `;

  const html = baseTemplate({
    title: subject,
    preheader: `Invoice ${invoiceNumber} for ${currency} ${amount} from ${companyName || fromName}.`,
    body
  });

  const text = `Invoice ${invoiceNumber} from ${companyName || fromName}\n\nAmount: ${currency} ${Number(amount).toLocaleString('en-US', {minimumFractionDigits:2})}${dueDate ? '\nDue: ' + dueDate : ''}${message ? '\nNote: ' + message : ''}\n\nView at: ${BRAND.siteUrl}`;

  const result = await callSendEmail({ to, subject, html, text });
  const status = result.ok ? 'sent' : 'failed';

  await logEmail(userId, {
    type: 'invoice', recipient: to, subject, status, error: result.error || '', entryId
  });

  return { ok: result.ok, subject };
}

// ── OTP / Locker access email ──────────────────────────────────────────────────
export async function sendOtpEmail(userId, { to, otp, lockerName, logoUrl, siteUrl = 'https://moneyintx.com' }) {
  const subject  = `Your Asset Locker Access Code — Money IntX`;
  const bodyHtml = `
    <p style="color:#555;font-size:14px;margin-bottom:24px;">You requested access to <strong>${_escHtml(lockerName || 'Asset Locker')}</strong> on Money IntX. Enter the code below to unlock your records for this session.</p>
    <div style="text-align:center;margin:0 0 28px;">
      <div style="display:inline-block;background:#f5f5ff;border:2px solid #080b53;border-radius:12px;padding:22px 40px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#080b53;margin-bottom:10px;">Your Access Code</div>
        <div style="font-size:40px;font-weight:800;letter-spacing:10px;color:#080b53;font-family:monospace;">${_escHtml(String(otp))}</div>
        <div style="font-size:11px;color:#999;margin-top:10px;">Expires in 30 minutes</div>
      </div>
    </div>
    <p style="font-size:13px;color:#999;line-height:1.65;margin-bottom:0;">If you did not request this code, someone may be attempting to access your account. Your lockers remain locked — no action is needed unless you made this request.</p>
  `;
  const html = _richEmail({ logoUrl, siteUrl, heading: 'Asset Locker Access Code', bodyHtml });
  const result = await callSendEmail({ to, subject, html, text: `Asset Locker Access Code\n\nYour one-time code: ${otp}\n\nThis code expires in 30 minutes.\n\nIf you did not request this, your lockers remain locked.\n\n— Money IntX` });
  await logEmail(userId, { type: 'otp', recipient: to, subject, status: result.ok ? 'sent' : 'failed', error: result.error || '' });
  return { ok: result.ok, subject };
}

// ── App invite email (from Settings) ─────────────────────────────────────
export async function sendAppInviteEmail(userId, { to, fromName, inviteLink }) {
  const subject = `${fromName} invited you to Money IntX`;

  const body = `
    <div class="badge">📨 Invitation</div>
    <h2>You're invited to Money IntX</h2>
    <p><strong>${fromName}</strong> wants you to join Money IntX — a smart financial record-keeping app for tracking invoices, settlements, and money interactions.</p>

    <div class="amount-box">
      <div class="label">What you can do</div>
      <div class="value" style="font-size:16px;color:${BRAND.text};">Track who owes you · Send invoices · Manage currencies · Record settlements</div>
    </div>

    <a class="btn" href="${inviteLink}">Join Money IntX →</a>

    <p style="font-size:13px;color:${BRAND.muted};">Money IntX is a record-keeping tool. It does not hold or transfer money.</p>
  `;

  const html = baseTemplate({
    title: subject,
    preheader: `${fromName} invited you to join Money IntX — track invoices and financial interactions.`,
    body
  });

  const text = `${fromName} invited you to Money IntX.\n\nJoin here: ${inviteLink}\n\nMoney IntX lets you track invoices, settlements, and financial interactions.`;

  const result = await callSendEmail({ to, subject, html, text });
  await logEmail(userId, { type: 'app_invite', recipient: to, subject, status: result.ok ? 'sent' : 'failed', error: result.error || '' });
  return { ok: result.ok, subject };
}

// ── Group / Investment invite email ───────────────────────────────────────────
export async function sendInviteEmail(userId, {
  to, fromName, groupName, inviteType = 'group', inviteLink, message, logoUrl, siteUrl = 'https://moneyintx.com'
}) {
  const typeLabel = inviteType === 'investment' ? 'Investment Group' : 'Savings Group';
  const subject   = `You're Invited — ${typeLabel}: ${_escHtml(groupName)}`;
  const ctaUrl    = inviteLink || siteUrl;
  const bodyHtml  = `
    <div style="background:#f5f5ff;border-left:4px solid #080b53;border-radius:4px;padding:16px 20px;margin-bottom:20px;">
      <p style="margin:0;font-size:15px;color:#333;line-height:1.6;">${_escHtml(message) || 'Log in to view and participate.'}</p>
    </div>
    <div style="text-align:center;margin:28px 0;">
      <a href="${_escHtml(ctaUrl)}" style="display:inline-block;padding:13px 32px;background:#080b53;color:#fff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">Open Money IntX →</a>
    </div>
  `;
  const subheading = `<strong>${_escHtml(fromName)}</strong> has invited you to join ${typeLabel}: <strong>${_escHtml(groupName)}</strong>.`;
  const html = _richEmail({ logoUrl, siteUrl, heading: "You've Been Invited", subheading, bodyHtml });
  const result = await callSendEmail({ to, subject, html, text: `You've Been Invited\n\n${fromName} invited you to join ${typeLabel}: ${groupName}.\n\n${message || 'Log in to view and participate.'}\n\n${ctaUrl}\n\n— Money IntX` });
  await logEmail(userId, { type: 'invite', recipient: to, subject, status: result.ok ? 'sent' : 'failed', error: result.error || '' });
  return { ok: result.ok, subject };
}

// ── NOK Verification — inform trusted contact they've been designated ──────────
export async function sendNokVerificationEmail(userId, {
  to, recipientName, fromName, relationship, accessLevel, logoUrl, siteUrl = 'https://moneyintx.com'
}) {
  const ACCESS_LABELS = { readonly: 'View Only', notify_only: 'Notify Only', limited_control: 'Limited Control', full_control: 'Full Control', view_only: 'View Only' };
  const accessLabel = ACCESS_LABELS[accessLevel] || 'View Only';
  const subject = `You've been designated as a Trusted Contact — Money IntX`;
  const bodyHtml = `
    <div style="background:#f5f5ff;border-left:4px solid #080b53;border-radius:4px;padding:16px 20px;margin-bottom:20px;">
      <p style="margin:0 0 8px;font-size:14px;color:#333;"><strong>Relationship:</strong> ${_escHtml(relationship || 'Trusted Contact')}</p>
      <p style="margin:0;font-size:14px;color:#333;"><strong>Your Access Level:</strong> ${_escHtml(accessLabel)}</p>
    </div>
    <p style="font-size:13px;color:#777;margin-bottom:20px;line-height:1.6;">No action is required from you right now. You will receive a separate notification if and when your access is activated. This system releases <strong>information only</strong> — not money or legal title.</p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${_escHtml(siteUrl)}" style="display:inline-block;padding:13px 32px;background:#080b53;color:#fff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">Learn More →</a>
    </div>
  `;
  const subheading = `<strong>${_escHtml(fromName)}</strong> has named you as a <strong>Next of Kin / Trusted Contact</strong> on their Money IntX account.`;
  const html = _richEmail({ logoUrl, siteUrl, heading: "You've Been Designated as a Trusted Contact", subheading, bodyHtml, footerNote: 'This is not a legal will and does not transfer money or assign debts.' });
  const result = await callSendEmail({ to, subject, html, text: `You've Been Designated as a Trusted Contact\n\n${fromName} has named you as a Next of Kin / Trusted Contact.\n\nRelationship: ${relationship || 'Trusted Contact'}\nAccess Level: ${accessLabel}\n\nNo action required now.\n\n— Money IntX` });
  await logEmail(userId, { type: 'nok_verification', recipient: to, subject, status: result.ok ? 'sent' : 'failed', error: result.error || '' });
  return { ok: result.ok, subject };
}

// ── NOK Activation — notify trusted contact their access is now live ──────────
export async function sendNokActivationEmail(userId, {
  to, recipientName, fromName, relationship, message, accessLevel, releaseType, triggerReason, logoUrl, siteUrl = 'https://moneyintx.com'
}) {
  const ACCESS_LABELS   = { readonly: 'View Only', notify_only: 'Notify Only', limited_control: 'Limited Control', full_control: 'Full Control', view_only: 'View Only' };
  const RELEASE_LABELS  = { full: 'Full ledger export', summary: 'Summary report only', selected: 'Selected fields', manual: 'On request' };
  const TRIGGER_LABELS  = { manual: 'Manually activated by account owner', inactivity: 'Activated due to account inactivity', emergency: 'Activated via emergency verification' };
  const accessLabel  = ACCESS_LABELS[accessLevel]    || 'View Only';
  const releaseLabel = RELEASE_LABELS[releaseType]   || 'Full export';
  const triggerLabel = TRIGGER_LABELS[triggerReason] || 'Activated by account owner';
  const subject = `Your Trusted Access Has Been Activated — Money IntX`;
  const bodyHtml = `
    <div style="background:#f5f5ff;border-left:4px solid #080b53;border-radius:4px;padding:16px 20px;margin-bottom:20px;">
      <p style="margin:0 0 6px;font-size:14px;color:#333;"><strong>Access Level:</strong> ${_escHtml(accessLabel)}</p>
      <p style="margin:0 0 6px;font-size:14px;color:#333;"><strong>Data Release:</strong> ${_escHtml(releaseLabel)}</p>
      <p style="margin:0;font-size:13px;color:#777;"><strong>Reason:</strong> ${_escHtml(triggerLabel)}</p>
    </div>
    ${message ? `<div style="background:#fffbf0;border:1px solid #f0d080;border-radius:6px;padding:14px 18px;margin-bottom:20px;font-size:14px;color:#555;line-height:1.6;font-style:italic;">"${_escHtml(message)}"</div>` : ''}
    <p style="font-size:12px;color:#999;line-height:1.6;">This system releases information only. It is not a legal will, does not transfer money, and is not legally binding for debt assignment. All access is logged and subject to review.</p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${_escHtml(siteUrl)}" style="display:inline-block;padding:13px 32px;background:#080b53;color:#fff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">Access Money IntX →</a>
    </div>
  `;
  const subheading = `Your Next of Kin access to <strong>${_escHtml(fromName)}'s</strong> account on Money IntX is now active.`;
  const html = _richEmail({ logoUrl, siteUrl, heading: 'Your Trusted Access Has Been Activated', subheading, bodyHtml });
  const result = await callSendEmail({ to, subject, html, text: `Your Trusted Access Has Been Activated\n\n${fromName} has activated your Next of Kin access on Money IntX.\n\nAccess Level: ${accessLabel}\nData Release: ${releaseLabel}\nReason: ${triggerLabel}\n\n${message ? '"' + message + '"\n\n' : ''}${siteUrl}\n\n— Money IntX` });
  await logEmail(userId, { type: 'nok_activation', recipient: to, subject, status: result.ok ? 'sent' : 'failed', error: result.error || '' });
  return { ok: result.ok, subject };
}

// ── Locker Info — send asset details to a designated trustee ──────────────────
export async function sendLockerInfoEmail(userId, {
  to, trusteeName, fromName, lockerTitle, lockerType, lockerLocation, lockerAccess, lockerKey, lockerNotes, logoUrl, siteUrl = 'https://moneyintx.com'
}) {
  const subject = `Asset Locker: ${lockerTitle} — Money IntX`;
  const rows = [
    lockerType     ? ['Type',     lockerType]     : null,
    lockerLocation ? ['Location', lockerLocation] : null,
    lockerAccess   ? ['Access',   lockerAccess]   : null,
    lockerKey      ? ['Key',      lockerKey]      : null,
    lockerNotes    ? ['Notes',    lockerNotes]    : null,
  ].filter(Boolean);
  const tableRows = rows.map(([k, v]) =>
    `<tr><td style="padding:6px 12px 6px 0;font-size:12px;font-weight:700;text-transform:uppercase;color:#999;white-space:nowrap;vertical-align:top;">${_escHtml(k)}</td><td style="padding:6px 0;font-size:14px;color:#333;">${_escHtml(v)}</td></tr>`
  ).join('');
  const bodyHtml = `
    <div style="background:#f5f5ff;border-left:4px solid #080b53;border-radius:4px;padding:16px 20px;margin-bottom:24px;">
      <div style="font-size:18px;font-weight:800;color:#080b53;margin-bottom:12px;">${_escHtml(lockerTitle)}</div>
      <table style="border-collapse:collapse;width:100%;">${tableRows}</table>
    </div>
    <p style="font-size:12px;color:#999;line-height:1.65;">This information is shared for asset location and access purposes only. It does not transfer ownership, constitute a legal instruction, or assign financial liability.</p>
  `;
  const subheading = `This information has been sent to you by <strong>${_escHtml(fromName)}</strong> via Money IntX. You have been designated as a trustee for the following asset.`;
  const html = _richEmail({ logoUrl, siteUrl, heading: 'Asset Locker Information', subheading, bodyHtml });
  const result = await callSendEmail({ to, subject, html, text: `Asset Locker Information\n\nSent by: ${fromName}\nLocker: ${lockerTitle}\n\n${rows.map(([k,v])=>k+': '+v).join('\n')}\n\nThis information does not transfer ownership or constitute a legal instruction.\n\n— Money IntX` });
  await logEmail(userId, { type: 'locker_info', recipient: to, subject, status: result.ok ? 'sent' : 'failed', error: result.error || '' });
  return { ok: result.ok, subject };
}
