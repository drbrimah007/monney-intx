// POST /api/email/send-invoice
// Body: { recipientEmail, fromName, invoiceNumber, amount, viewUrl? }

const { requireAuth }      = require('../../lib/auth');
const { sendInvoiceEmail } = require('../../lib/email');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  const { recipientEmail, fromName, invoiceNumber, amount, viewUrl } = req.body || {};
  if (!recipientEmail || !invoiceNumber) {
    return res.status(400).json({ ok: false, error: 'recipientEmail and invoiceNumber are required.' });
  }

  const result = await sendInvoiceEmail({ to: recipientEmail, fromName, invoiceNumber, amount, viewUrl });
  return res.json(result);
};
