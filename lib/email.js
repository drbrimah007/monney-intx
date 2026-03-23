// lib/email.js — Transactional email via Resend (resend.com)
// Free tier: 3,000 emails/month, no credit card required.
// Sign up at https://resend.com → API Keys → create one → add as RESEND_API_KEY env var.

const { Resend } = require('resend');

const FROM_DOMAIN  = process.env.EMAIL_FROM_DOMAIN || 'noreply@moneyintx.com';
const FROM_ADDRESS = process.env.EMAIL_FROM || `Money IntX <${FROM_DOMAIN}>`;

function getResend() {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not set — emails will be skipped.');
    return null;
  }
  return new Resend(process.env.RESEND_API_KEY);
}

// ── Generic send ──────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html, text, from }) {
  const resend = getResend();
  if (!resend) return { ok: false, skipped: true, reason: 'No API key' };
  try {
    const { data, error } = await resend.emails.send({ from: from || FROM_ADDRESS, to, subject, html, text });
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: data?.id };
  } catch (e) {
    console.error('[email] send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Password reset email ──────────────────────────────────────────────────
async function sendPasswordReset({ to, displayName, resetUrl }) {
  return sendEmail({
    to,
    subject: 'Reset your Money IntX password',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h2 style="margin-bottom:8px">Password Reset</h2>
        <p>Hi ${displayName || 'there'},</p>
        <p>Click the button below to reset your password. This link expires in <strong>1 hour</strong>.</p>
        <a href="${resetUrl}"
           style="display:inline-block;margin:20px 0;padding:12px 28px;background:#6c63ff;color:#fff;
                  border-radius:8px;font-weight:700;text-decoration:none;">
          Reset Password
        </a>
        <p style="color:#888;font-size:13px">
          If you didn't request this, ignore this email — your password won't change.
        </p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#aaa;font-size:12px">Money IntX — Making Money Matters Memorable</p>
      </div>`,
    text: `Reset your Money IntX password by visiting: ${resetUrl}\n\nThis link expires in 1 hour.`
  });
}

// ── Invoice notification ──────────────────────────────────────────────────
async function sendInvoiceEmail({ to, fromName, invoiceNumber, amount, viewUrl }) {
  return sendEmail({
    to,
    subject: `Invoice ${invoiceNumber} from ${fromName}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h2 style="margin-bottom:8px">You have a new invoice</h2>
        <p><strong>${fromName}</strong> has sent you invoice <strong>${invoiceNumber}</strong>
           for <strong>${amount}</strong>.</p>
        ${viewUrl ? `<a href="${viewUrl}"
           style="display:inline-block;margin:20px 0;padding:12px 28px;background:#6c63ff;color:#fff;
                  border-radius:8px;font-weight:700;text-decoration:none;">
          View Invoice
        </a>` : ''}
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#aaa;font-size:12px">Money IntX — Making Money Matters Memorable</p>
      </div>`,
    text: `${fromName} sent you invoice ${invoiceNumber} for ${amount}.${viewUrl ? '\n\nView it here: ' + viewUrl : ''}`
  });
}

// ── Payment reminder / record notification ────────────────────────────────
// txType drives the subject + heading so copy matches the actual direction.
async function sendReminderEmail({ to, fromName, fromEmail, message, invoiceNumber, amount, viewUrl, siteUrl, appName, tagline, txType, entryStatus, logoData }) {
  const siteName    = appName  || 'Money IntX';
  const siteTagline = tagline  || 'Making Money Matters Memorable';
  // Use the custom app name as the email sender display name so recipients see "Money IntX" (or custom name)
  const fromAddr    = `${siteName} <${FROM_DOMAIN}>`;
  const siteBase    = siteUrl  || 'https://moneyinteractions.com';
  const ctaUrl      = viewUrl  || siteBase;

  // Direction-aware subject + heading — always written from the RECIPIENT's perspective
  let subject, heading, subheading, amtLabel;
  if (txType === 'you_owe_them') {
    // Sender (fromName) owes the recipient → recipient is owed
    subject    = `You Are Owed — record from ${fromName}`;
    heading    = 'You Are Owed';
    subheading = `<strong>${fromName}</strong> has recorded that they owe you this amount.`;
    amtLabel   = 'Amount You Are Owed';
  } else if (txType === 'you_paid_them') {
    // Sender paid the recipient
    subject    = `${fromName} has recorded a payment to you`;
    heading    = 'Payment Made to You';
    subheading = `<strong>${fromName}</strong> has recorded making a payment to you.`;
    amtLabel   = 'Amount Paid to You';
  } else if (txType === 'they_paid_you') {
    // Recipient settled their balance with sender
    subject    = `${fromName} has recorded your settlement`;
    heading    = 'Settlement Recorded';
    subheading = `<strong>${fromName}</strong> has recorded that you settled a balance with them.`;
    amtLabel   = 'Amount Settled';
  } else {
    // they_owe_you / invoice / bill — recipient owes sender
    const isPartial = (entryStatus === 'partially_settled');
    subject    = isPartial
      ? `Partial balance still due — reminder from ${fromName}`
      : `You Owe — payment reminder from ${fromName}`;
    heading    = 'You Owe';
    subheading = isPartial
      ? `<strong>${fromName}</strong> has recorded a partial settlement. A balance is still outstanding.`
      : `<strong>${fromName}</strong> has shared a record showing you owe this amount.`;
    amtLabel   = isPartial ? 'Balance Remaining' : 'Amount You Owe';
  }

  const amtLine  = amount != null ? `<div style="margin-bottom:14px;"><span style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.05em;">${amtLabel}</span><br><strong style="font-size:24px;color:#1a1a2e;">$${parseFloat(amount).toFixed(2)}</strong></div>` : '';
  const invLine  = invoiceNumber ? `<p style="font-size:15px;color:#444;">Reference: <strong>${invoiceNumber}</strong></p>` : '';
  // Only show a contact line if we have a reply-to address; never claim noreply is replyable
  const replyLine = fromEmail ? `<p style="color:#666;font-size:13px;">You can reach them: <a href="mailto:${fromEmail}" style="color:#6c63ff;">${fromEmail}</a></p>` : '';

  // Logo: data: URIs are blocked by email clients, so fall back to the site's public /money.png
  const validLogoUrl = (logoData && /^https?:\/\//i.test(logoData))
    ? logoData
    : `${siteBase}/money.png`;
  const logoHtml = `<img src="${validLogoUrl}" alt="${siteName}" style="height:48px;max-width:180px;object-fit:contain;display:block;margin:0 auto 8px;" onerror="this.style.display='none'">`;

  return sendEmail({
    to,
    from: fromAddr,
    subject,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:0;background:#f9f9f9;">
        <div style="background:#1a1a2e;padding:20px 32px 16px;border-radius:12px 12px 0 0;text-align:center;">
          ${logoHtml}
        </div>
        <div style="background:#fff;padding:32px 32px 24px;border-left:1px solid #eee;border-right:1px solid #eee;">
          <h2 style="margin:0 0 6px;font-size:22px;color:#1a1a2e;">${heading}</h2>
          <p style="color:#555;font-size:14px;margin-bottom:20px;">${subheading}</p>
          <div style="background:#f5f5ff;border-left:4px solid #6c63ff;border-radius:4px;padding:16px 20px;margin-bottom:20px;">
            <p style="margin:0;font-size:15px;color:#333;line-height:1.6;">${message}</p>
          </div>
          ${amtLine}${invLine}
          <div style="text-align:center;margin:28px 0;">
            <a href="${ctaUrl}" style="display:inline-block;padding:13px 32px;background:#6c63ff;color:#fff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">View on ${siteName} →</a>
          </div>
          ${replyLine}
        </div>
        <div style="background:#f0f0f0;padding:16px 32px;border-radius:0 0 12px 12px;border:1px solid #eee;border-top:none;text-align:center;">
          <p style="margin:0 0 4px;font-size:12px;color:#888;">${siteName} — ${siteTagline}</p>
          <p style="margin:0;font-size:12px;color:#aaa;"><a href="${siteBase}" style="color:#6c63ff;text-decoration:none;">${siteBase.replace(/^https?:\/\//, '')}</a></p>
        </div>
      </div>`,
    text: `${heading}\n${fromName}\n\n${message}\n\n${invoiceNumber ? 'Reference: ' + invoiceNumber + '\n' : ''}${amount != null ? amtLabel + ': $' + parseFloat(amount).toFixed(2) + '\n' : ''}\nView entry: ${ctaUrl}\n\n— ${siteName}`
  });
}

module.exports = { sendEmail, sendPasswordReset, sendInvoiceEmail, sendReminderEmail };
