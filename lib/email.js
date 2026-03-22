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
async function sendReminderEmail({ to, fromName, message, invoiceNumber }) {
  return sendEmail({
    to,
    subject: `Payment reminder from ${fromName}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h2 style="margin-bottom:8px">Payment Reminder</h2>
        <p>${message || `${fromName} has sent you a payment reminder${invoiceNumber ? ' regarding invoice ' + invoiceNumber : ''}.`}</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#aaa;font-size:12px">Money Intx — Making Money Matters Memorable</p>
      </div>`,
    text: message || `Payment reminder from ${fromName}${invoiceNumber ? ' regarding invoice ' + invoiceNumber : ''}.`
  });
}

module.exports = { sendEmail, sendPasswordReset, sendInvoiceEmail, sendReminderEmail };
