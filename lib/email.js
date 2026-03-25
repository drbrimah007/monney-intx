// lib/email.js — Transactional email via Resend (resend.com)
// Free tier: 3,000 emails/month, no credit card required.
// Sign up at https://resend.com → API Keys → create one → add as RESEND_API_KEY env var.

const { Resend } = require('resend');

const FROM_DOMAIN  = process.env.EMAIL_FROM_DOMAIN || 'noreply@moneyintx.com';
const FROM_ADDRESS = process.env.EMAIL_FROM || `Money IntX <${FROM_DOMAIN}>`;

function _escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _fmtEmail(n, currency) {
  const code = currency || 'USD';
  const val = parseFloat(n);
  if (isNaN(val)) return '';
  const noDecimals = ['JPY', 'KRW', 'VND'].includes(code);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: code,
      minimumFractionDigits: noDecimals ? 0 : 2,
      maximumFractionDigits: noDecimals ? 0 : 2
    }).format(val);
  } catch (_) {
    return '$' + val.toFixed(noDecimals ? 0 : 2);
  }
}

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
async function sendReminderEmail({ to, fromName, fromEmail, message, invoiceNumber, amount, totalAmt, paidAmt, viewUrl, siteUrl, appName, tagline, txType, entryStatus, logoData, currency }) {
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
  } else if (txType === 'invoice' || txType === 'bill') {
    // invoice / bill — formal record, recipient owes sender
    const docType = txType === 'invoice' ? 'Invoice' : 'Bill';
    const isPartial = (entryStatus === 'partially_settled');
    subject    = isPartial
      ? `${docType}: partial balance still due — from ${fromName}`
      : `${docType} from ${fromName}`;
    heading    = `${docType} Due`;
    subheading = isPartial
      ? `<strong>${fromName}</strong> has recorded a partial settlement. A balance is still outstanding.`
      : `<strong>${fromName}</strong> has sent you a ${docType.toLowerCase()} for the following amount.`;
    amtLabel   = isPartial ? 'Balance Remaining' : `${docType} Amount Due`;
  } else {
    // they_owe_you — personal record, recipient owes sender
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

  // Amount block — shows breakdown when settled amount is available
  const hasBreakdown = (paidAmt != null && parseFloat(paidAmt) > 0 && totalAmt != null);
  let amtLine = '';
  if (amount != null) {
    if (hasBreakdown) {
      const _totalFmt = _fmtEmail(totalAmt, currency);
      const _paidFmt  = _fmtEmail(paidAmt, currency);
      const _balFmt   = _fmtEmail(amount, currency);
      amtLine = `
        <div style="margin-bottom:14px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <div style="background:#f9fafb;padding:10px 16px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;">
            <span style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.05em;">Original Amount</span>
            <span style="font-size:14px;font-weight:600;color:#555;">${_totalFmt}</span>
          </div>
          <div style="background:#f0fdf4;padding:10px 16px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;">
            <span style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.05em;">Settled</span>
            <span style="font-size:14px;font-weight:600;color:#16a34a;">− ${_paidFmt}</span>
          </div>
          <div style="background:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.05em;">${amtLabel}</span>
            <strong style="font-size:22px;color:#1a1a2e;">${_balFmt}</strong>
          </div>
        </div>`;
    } else {
      amtLine = `<div style="margin-bottom:14px;"><span style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.05em;">${amtLabel}</span><br><strong style="font-size:24px;color:#1a1a2e;">${_fmtEmail(amount, currency)}</strong></div>`;
    }
  }
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
            <p style="margin:0;font-size:15px;color:#333;line-height:1.6;">${_escHtml(message)}</p>
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
    text: `${heading}\n${fromName}\n\n${message}\n\n${invoiceNumber ? 'Reference: ' + invoiceNumber + '\n' : ''}${hasBreakdown ? 'Original: ' + _fmtEmail(totalAmt, currency) + '\nSettled: ' + _fmtEmail(paidAmt, currency) + '\n' + amtLabel + ': ' + _fmtEmail(amount, currency) + '\n' : (amount != null ? amtLabel + ': ' + _fmtEmail(amount, currency) + '\n' : '')}\nView entry: ${ctaUrl}\n\n— ${siteName}`
  });
}

// ── Group / Investment invitation ─────────────────────────────────────────
async function sendInviteEmail({ to, fromName, itemName, itemType, message, siteUrl, appName, tagline, logoData }) {
  const siteName    = appName  || 'Money IntX';
  const siteTagline = tagline  || 'Making Money Matters Memorable';
  const fromAddr    = `${siteName} <${FROM_DOMAIN}>`;
  const siteBase    = siteUrl  || 'https://moneyinteractions.com';
  const ctaUrl      = siteBase;

  const subject  = `You're Invited - ${itemType}: ${itemName}`;
  const heading  = "You've Been Invited";
  const subheading = `<strong>${fromName}</strong> has invited you to join ${itemType}: <strong>${itemName}</strong>.`;

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
            <p style="margin:0;font-size:15px;color:#333;line-height:1.6;">${_escHtml(message) || 'Log in to view and participate.'}</p>
          </div>
          <div style="text-align:center;margin:28px 0;">
            <a href="${ctaUrl}" style="display:inline-block;padding:13px 32px;background:#6c63ff;color:#fff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">Open ${siteName} →</a>
          </div>
        </div>
        <div style="background:#f0f0f0;padding:16px 32px;border-radius:0 0 12px 12px;border:1px solid #eee;border-top:none;text-align:center;">
          <p style="margin:0 0 4px;font-size:12px;color:#888;">${siteName} — ${siteTagline}</p>
          <p style="margin:0;font-size:12px;color:#aaa;"><a href="${siteBase}" style="color:#6c63ff;text-decoration:none;">${siteBase.replace(/^https?:\/\//, '')}</a></p>
        </div>
      </div>`,
    text: `${heading}\n\n${fromName} invited you to ${itemType}: ${itemName}.\n\n${message || 'Log in to view and participate.'}\n\n${ctaUrl}\n\n— ${siteName}`
  });
}

// ── NOK Verification (inform the trusted contact they've been designated) ──
async function sendNokVerificationEmail({ to, recipientName, fromName, relationship, accessLevel, siteUrl, appName, tagline, logoData }) {
  const siteName    = appName  || 'Money IntX';
  const siteTagline = tagline  || 'Making Money Matters Memorable';
  const siteBase    = siteUrl  || 'https://moneyinteractions.com';
  const fromAddr    = `${siteName} <${FROM_DOMAIN}>`;
  const ACCESS_LABELS = { view_only:'View Only', notify_only:'Notify Only', limited_control:'Limited Control', full_control:'Full Control' };
  const accessLabel = ACCESS_LABELS[accessLevel] || 'View Only';
  const validLogoUrl = (logoData && /^https?:\/\//i.test(logoData)) ? logoData : `${siteBase}/money.png`;
  return sendEmail({
    to, from: fromAddr,
    subject: `You've been designated as a Trusted Contact — ${siteName}`,
    html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#f9f9f9;">
      <div style="background:#080b53;padding:20px 32px 16px;border-radius:12px 12px 0 0;text-align:center;">
        <img src="${_escHtml(validLogoUrl)}" alt="${_escHtml(siteName)}" style="height:48px;max-width:180px;object-fit:contain;display:block;margin:0 auto 8px;" onerror="this.style.display='none'">
      </div>
      <div style="background:#fff;padding:32px 32px 24px;border-left:1px solid #eee;border-right:1px solid #eee;">
        <h2 style="margin:0 0 6px;font-size:22px;color:#080b53;">You've Been Designated as a Trusted Contact</h2>
        <p style="color:#555;font-size:14px;margin-bottom:20px;"><strong>${_escHtml(fromName)}</strong> has named you as a <strong>Next of Kin / Trusted Contact</strong> on their ${_escHtml(siteName)} account.</p>
        <div style="background:#f5f5ff;border-left:4px solid #6c63ff;border-radius:4px;padding:16px 20px;margin-bottom:20px;">
          <p style="margin:0 0 8px;font-size:14px;color:#333;"><strong>Relationship:</strong> ${_escHtml(relationship)}</p>
          <p style="margin:0;font-size:14px;color:#333;"><strong>Your Access Level:</strong> ${_escHtml(accessLabel)}</p>
        </div>
        <p style="font-size:13px;color:#777;margin-bottom:20px;line-height:1.6;">No action is required from you right now. You will receive a separate notification if and when your access is activated. This system releases <strong>information only</strong> — not money or legal title.</p>
        <div style="text-align:center;margin:28px 0;">
          <a href="${_escHtml(siteBase)}" style="display:inline-block;padding:13px 32px;background:#6c63ff;color:#fff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">Learn More →</a>
        </div>
      </div>
      <div style="background:#f0f0f0;padding:16px 32px;border-radius:0 0 12px 12px;border:1px solid #eee;border-top:none;text-align:center;">
        <p style="margin:0 0 4px;font-size:12px;color:#888;">${_escHtml(siteName)} — ${_escHtml(siteTagline)}</p>
        <p style="margin:0;font-size:11px;color:#bbb;">This is not a legal will and does not transfer money or assign debts.</p>
      </div>
    </div>`,
    text: `You've Been Designated as a Trusted Contact\n\n${fromName} has named you as a Next of Kin / Trusted Contact on their ${siteName} account.\n\nRelationship: ${relationship}\nAccess Level: ${accessLabel}\n\nNo action required now. You'll be notified if your access is activated.\n\n${siteBase}\n\n— ${siteName}`
  });
}

// ── NOK Activation (notify the trusted contact their access is now live) ─────
async function sendNokActivationEmail({ to, recipientName, fromName, relationship, message, accessLevel, releaseType, triggerReason, siteUrl, appName, tagline, logoData }) {
  const siteName    = appName  || 'Money IntX';
  const siteTagline = tagline  || 'Making Money Matters Memorable';
  const siteBase    = siteUrl  || 'https://moneyinteractions.com';
  const fromAddr    = `${siteName} <${FROM_DOMAIN}>`;
  const ACCESS_LABELS = { view_only:'View Only', notify_only:'Notify Only', limited_control:'Limited Control', full_control:'Full Control' };
  const RELEASE_LABELS = { full:'Full ledger export', summary:'Summary report only', selected:'Selected fields' };
  const TRIGGER_LABELS = { manual:'Manually activated by account owner', inactivity:'Activated due to account inactivity', emergency:'Activated via emergency verification' };
  const accessLabel   = ACCESS_LABELS[accessLevel]   || 'View Only';
  const releaseLabel  = RELEASE_LABELS[releaseType]  || 'Full export';
  const triggerLabel  = TRIGGER_LABELS[triggerReason] || 'Activated by account owner';
  const validLogoUrl  = (logoData && /^https?:\/\//i.test(logoData)) ? logoData : `${siteBase}/money.png`;
  return sendEmail({
    to, from: fromAddr,
    subject: `Your Trusted Access Has Been Activated — ${siteName}`,
    html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#f9f9f9;">
      <div style="background:#080b53;padding:20px 32px 16px;border-radius:12px 12px 0 0;text-align:center;">
        <img src="${_escHtml(validLogoUrl)}" alt="${_escHtml(siteName)}" style="height:48px;max-width:180px;object-fit:contain;display:block;margin:0 auto 8px;" onerror="this.style.display='none'">
      </div>
      <div style="background:#fff;padding:32px 32px 24px;border-left:1px solid #eee;border-right:1px solid #eee;">
        <h2 style="margin:0 0 6px;font-size:22px;color:#080b53;">Your Trusted Access Has Been Activated</h2>
        <p style="color:#555;font-size:14px;margin-bottom:20px;">Your Next of Kin access to <strong>${_escHtml(fromName)}'s</strong> account on ${_escHtml(siteName)} is now active.</p>
        <div style="background:#f5f5ff;border-left:4px solid #6c63ff;border-radius:4px;padding:16px 20px;margin-bottom:20px;">
          <p style="margin:0 0 6px;font-size:14px;color:#333;"><strong>Access Level:</strong> ${_escHtml(accessLabel)}</p>
          <p style="margin:0 0 6px;font-size:14px;color:#333;"><strong>Data Release:</strong> ${_escHtml(releaseLabel)}</p>
          <p style="margin:0;font-size:13px;color:#777;"><strong>Reason:</strong> ${_escHtml(triggerLabel)}</p>
        </div>
        ${message ? `<div style="background:#fffbf0;border:1px solid #f0d080;border-radius:6px;padding:14px 18px;margin-bottom:20px;font-size:14px;color:#555;line-height:1.6;font-style:italic;">"${_escHtml(message)}"</div>` : ''}
        <p style="font-size:12px;color:#999;line-height:1.6;">This system releases information only. It is not a legal will, does not transfer money, and is not legally binding for debt assignment. All access is logged and subject to review.</p>
        <div style="text-align:center;margin:28px 0;">
          <a href="${_escHtml(siteBase)}" style="display:inline-block;padding:13px 32px;background:#6c63ff;color:#fff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">Access ${_escHtml(siteName)} →</a>
        </div>
      </div>
      <div style="background:#f0f0f0;padding:16px 32px;border-radius:0 0 12px 12px;border:1px solid #eee;border-top:none;text-align:center;">
        <p style="margin:0 0 4px;font-size:12px;color:#888;">${_escHtml(siteName)} — ${_escHtml(siteTagline)}</p>
      </div>
    </div>`,
    text: `Your Trusted Access Has Been Activated\n\n${fromName} has activated your Next of Kin access on ${siteName}.\n\nAccess Level: ${accessLabel}\nData Release: ${releaseLabel}\nReason: ${triggerLabel}\n\n${message ? '"' + message + '"\n\n' : ''}${siteBase}\n\n— ${siteName}`
  });
}

module.exports = { sendEmail, sendPasswordReset, sendInvoiceEmail, sendReminderEmail, sendInviteEmail, sendNokVerificationEmail, sendNokActivationEmail };
