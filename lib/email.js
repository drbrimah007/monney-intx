// lib/email.js — Transactional email via Resend (resend.com)
// Free tier: 3,000 emails/month, no credit card required.
// Sign up at https://resend.com → API Keys → create one → add as RESEND_API_KEY env var.

const { Resend } = require('resend');

const FROM_ADDRESS = process.env.EMAIL_FROM || 'Money Intx <noreply@moneyintx.com>';

function getResend() {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not set — emails will be skipped.');
    return null;
  }
  return new Resend(process.env.RESEND_API_KEY);
}

// ── Generic send ──────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html, text }) {
  const resend = getResend();
  if (!resend) return { ok: false, skipped: true, reason: 'No API key' };
  try {
    const { data, error } = await resend.emails.send({ from: FROM_ADDRESS, to, subject, html, text });
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
    subject: 'Reset your Money Intx password',
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
        <p style="color:#aaa;font-size:12px">Money Intx — Making Money Matters Memorable</p>
      </div>`,
    text: `Reset your Money Intx password by visiting: ${resetUrl}\n\nThis link expires in 1 hour.`
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
        <p style="color:#aaa;font-size:12px">Money Intx — Making Money Matters Memorable</p>
      </div>`,
    text: `${fromName} sent you invoice ${invoiceNumber} for ${amount}.${viewUrl ? '\n\nView it here: ' + viewUrl : ''}`
  });
}

// ── Payment reminder ──────────────────────────────────────────────────────
async function sendReminderEmail({ to, fromName, fromEmail, message, invoiceNumber, amount, viewUrl, siteUrl, appName }) {
  const siteName = appName || 'Money Intx';
  const siteBase = siteUrl || 'https://moneyinteractions.com';
  const ctaUrl   = viewUrl || siteBase;   // deep link to specific entry when available
  const amtLine  = amount != null ? `<p style="font-size:15px;color:#444;">Amount: <strong>$${parseFloat(amount).toFixed(2)}</strong></p>` : '';
  const invLine  = invoiceNumber ? `<p style="font-size:15px;color:#444;">Reference: <strong>${invoiceNumber}</strong></p>` : '';
  const replyLine = fromEmail ? `<p style="color:#666;font-size:13px;">You can reply to this email or contact <a href="mailto:${fromEmail}" style="color:#6c63ff;">${fromEmail}</a> directly.</p>` : '';

  return sendEmail({
    to,
    subject: `Payment reminder from ${fromName}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:0;background:#f9f9f9;">
        <!-- Header -->
        <div style="background:#1a1a2e;padding:24px 32px;border-radius:12px 12px 0 0;text-align:center;">
          <span style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.5px;">${siteName}</span>
        </div>
        <!-- Body -->
        <div style="background:#fff;padding:32px 32px 24px;border-left:1px solid #eee;border-right:1px solid #eee;">
          <h2 style="margin:0 0 6px;font-size:22px;color:#1a1a2e;">Payment Reminder</h2>
          <p style="color:#555;font-size:14px;margin-bottom:20px;">From <strong>${fromName}</strong></p>
          <div style="background:#f5f5ff;border-left:4px solid #6c63ff;border-radius:4px;padding:16px 20px;margin-bottom:20px;">
            <p style="margin:0;font-size:15px;color:#333;line-height:1.6;">${message}</p>
          </div>
          ${amtLine}${invLine}
          <div style="text-align:center;margin:28px 0;">
            <a href="${ctaUrl}" style="display:inline-block;padding:13px 32px;background:#6c63ff;color:#fff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">View on ${siteName} →</a>
          </div>
          ${replyLine}
        </div>
        <!-- Footer -->
        <div style="background:#f0f0f0;padding:16px 32px;border-radius:0 0 12px 12px;border:1px solid #eee;border-top:none;text-align:center;">
          <p style="margin:0 0 4px;font-size:12px;color:#888;">${siteName} — Making Money Matters Memorable</p>
          <p style="margin:0;font-size:12px;color:#aaa;"><a href="${siteBase}" style="color:#6c63ff;text-decoration:none;">${siteBase.replace(/^https?:\/\//, '')}</a></p>
        </div>
      </div>`,
    text: `${message}\n\n${invoiceNumber ? 'Reference: ' + invoiceNumber + '\n' : ''}${amount != null ? 'Amount: $' + parseFloat(amount).toFixed(2) + '\n' : ''}\nView entry: ${ctaUrl}\n\n— ${siteName}`
  });
}

module.exports = { sendEmail, sendPasswordReset, sendInvoiceEmail, sendReminderEmail };
