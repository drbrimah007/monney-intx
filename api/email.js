// /api/email — consolidated email handler
//
// POST { action:'send-reminder', recipientEmail, fromName, message?, invoiceNumber?, … }
// POST { action:'send-invoice',  recipientEmail, fromName, invoiceNumber, amount, viewUrl? }

const { requireAuth }                         = require('../lib/auth');
const { sendReminderEmail, sendInvoiceEmail } = require('../lib/email');

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

  return res.status(400).json({ ok: false, error: 'Invalid action. Use send-reminder or send-invoice.' });
};
