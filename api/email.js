// /api/email — consolidated email handler
//
// POST { action:'send-reminder', recipientEmail, fromName, message?, invoiceNumber?, … }
// POST { action:'send-invoice',  recipientEmail, fromName, invoiceNumber, amount, viewUrl? }

const { requireAuth }                                        = require('../lib/auth');
const { sendReminderEmail, sendInvoiceEmail, sendInviteEmail, sendNokVerificationEmail, sendNokActivationEmail, sendLockerOtpEmail, sendLockerInfoEmail } = require('../lib/email');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  const { action } = req.body || {};

  if (action === 'send-reminder') {
    const { recipientEmail, fromName, fromEmail, message, invoiceNumber, amount, totalAmt, paidAmt, txType, entryStatus, currency, viewUrl, siteUrl, appName, tagline, logoData } = req.body;
    if (!recipientEmail) return res.status(400).json({ ok: false, error: 'recipientEmail is required.' });
    const result = await sendReminderEmail({ to: recipientEmail, fromName, fromEmail, message, invoiceNumber, amount, totalAmt, paidAmt, txType, entryStatus, currency, viewUrl, siteUrl, appName, tagline, logoData });
    return res.json(result);
  }

  if (action === 'send-invoice') {
    const { recipientEmail, fromName, invoiceNumber, amount, viewUrl } = req.body;
    if (!recipientEmail || !invoiceNumber) {
      return res.status(400).json({ ok: false, error: 'recipientEmail and invoiceNumber are required.' });
    }
    const result = await sendInvoiceEmail({ to: recipientEmail, fromName, invoiceNumber, amount, viewUrl });
    return res.json(result);
  }

  if (action === 'send-invite') {
    const { recipientEmail, fromName, itemName, itemType, message, siteUrl, appName, tagline, logoData } = req.body;
    if (!recipientEmail) return res.status(400).json({ ok: false, error: 'recipientEmail is required.' });
    const result = await sendInviteEmail({ to: recipientEmail, fromName, itemName, itemType, message, siteUrl, appName, tagline, logoData });
    return res.json(result);
  }

  if (action === 'send-nok-verification') {
    const { recipientEmail, recipientName, fromName, relationship, accessLevel, siteUrl, appName, tagline, logoData } = req.body;
    if (!recipientEmail) return res.status(400).json({ ok: false, error: 'recipientEmail is required.' });
    const result = await sendNokVerificationEmail({ to: recipientEmail, recipientName, fromName, relationship, accessLevel, siteUrl, appName, tagline, logoData });
    return res.json(result);
  }

  if (action === 'send-nok-activation') {
    const { recipientEmail, recipientName, fromName, relationship, message, accessLevel, releaseType, triggerReason, siteUrl, appName, tagline, logoData } = req.body;
    if (!recipientEmail) return res.status(400).json({ ok: false, error: 'recipientEmail is required.' });
    const result = await sendNokActivationEmail({ to: recipientEmail, recipientName, fromName, relationship, message, accessLevel, releaseType, triggerReason, siteUrl, appName, tagline, logoData });
    return res.json(result);
  }

  if (action === 'send-locker-otp') {
    const { recipientEmail, fromName, code, siteUrl, appName, tagline, logoData } = req.body;
    if (!recipientEmail || !code) return res.status(400).json({ ok: false, error: 'recipientEmail and code are required.' });
    const result = await sendLockerOtpEmail({ to: recipientEmail, fromName, code, siteUrl, appName, tagline, logoData });
    return res.json(result);
  }

  if (action === 'send-locker-info') {
    const { recipientEmail, trusteeName, fromName, lockerTitle, lockerType, lockerLocation, lockerAccess, lockerKey, lockerNotes, siteUrl, appName, tagline, logoData } = req.body;
    if (!recipientEmail || !lockerTitle) return res.status(400).json({ ok: false, error: 'recipientEmail and lockerTitle are required.' });
    const result = await sendLockerInfoEmail({ to: recipientEmail, trusteeName, fromName, lockerTitle, lockerType, lockerLocation, lockerAccess, lockerKey, lockerNotes, siteUrl, appName, tagline, logoData });
    return res.json(result);
  }

  return res.status(400).json({ ok: false, error: 'Invalid action.' });
};
