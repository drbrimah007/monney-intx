// POST /api/email/send-reminder
// Body: { recipientEmail, fromName, message?, invoiceNumber? }

const { requireAuth }       = require('../../lib/auth');
const { sendReminderEmail } = require('../../lib/email');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  const { recipientEmail, fromName, message, invoiceNumber } = req.body || {};
  if (!recipientEmail) {
    return res.status(400).json({ ok: false, error: 'recipientEmail is required.' });
  }

  const result = await sendReminderEmail({ to: recipientEmail, fromName, message, invoiceNumber });
  return res.json(result);
};
