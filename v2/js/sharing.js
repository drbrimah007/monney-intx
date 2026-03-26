// Money IntX v2 — Sharing Module
import { supabase } from './supabase.js';
import { toCents } from './entries.js';

// ── Create share token ────────────────────────────────────────────
export async function createShareToken(senderId, entryId, { recipientEmail = '', entrySnapshot = {} } = {}) {
  const { data, error } = await supabase
    .from('share_tokens')
    .insert({
      sender_id: senderId,
      entry_id: entryId,
      recipient_email: recipientEmail,
      entry_snapshot: entrySnapshot,
      status: 'created'
    })
    .select()
    .single();
  if (error) console.error('[createShareToken]', error.message);
  return data;
}

// ── Get share token by token string ───────────────────────────────
export async function getShareByToken(token) {
  const { data, error } = await supabase
    .from('share_tokens')
    .select('*, entry:entries(*, contact:contacts(id, name, email))')
    .eq('token', token)
    .single();
  if (error) console.error('[getShareByToken]', error.message);
  return data;
}

// ── List shares I sent ────────────────────────────────────────────
export async function listSentShares(senderId) {
  const { data, error } = await supabase
    .from('share_tokens')
    .select('*, entry:entries(id, amount, currency, tx_type, status, date, contact:contacts(id, name))')
    .eq('sender_id', senderId)
    .order('created_at', { ascending: false });
  if (error) console.error('[listSentShares]', error.message);
  return data || [];
}

// ── List shares sent to me ────────────────────────────────────────
export async function listReceivedShares(recipientId) {
  const { data, error } = await supabase
    .from('share_tokens')
    .select('*, entry:entries(id, amount, currency, tx_type, status, date)')
    .eq('recipient_id', recipientId)
    .neq('status', 'expired')
    .neq('status', 'dismissed')
    .order('created_at', { ascending: false });
  if (error) console.error('[listReceivedShares]', error.message);
  return data || [];
}

// ── Update share status ───────────────────────────────────────────
export async function updateShareStatus(tokenId, status) {
  const updates = { status };
  if (status === 'viewed') updates.viewed_at = new Date().toISOString();
  if (status === 'confirmed') updates.confirmed_at = new Date().toISOString();
  const { data, error } = await supabase
    .from('share_tokens')
    .update(updates)
    .eq('id', tokenId)
    .select()
    .single();
  if (error) console.error('[updateShareStatus]', error.message);
  return data;
}

// ── Link share to recipient user ──────────────────────────────────
export async function linkShareToUser(tokenId, recipientId) {
  const { data, error } = await supabase
    .from('share_tokens')
    .update({ recipient_id: recipientId })
    .eq('id', tokenId)
    .select()
    .single();
  if (error) console.error('[linkShareToUser]', error.message);
  return data;
}

// ── Confirm shared record (recipient accepts) ─────────────────────
export async function confirmShare(tokenId, recipientId) {
  // Update token status
  await updateShareStatus(tokenId, 'confirmed');
  await linkShareToUser(tokenId, recipientId);

  // Get the share token with entry details
  const { data: token } = await supabase
    .from('share_tokens')
    .select('*, entry:entries(id, amount, currency, tx_type, date, note, invoice_number, user_id)')
    .eq('id', tokenId)
    .single();
  if (!token?.entry) return null;

  // Flip tx_type for recipient perspective
  const FLIP = {
    'they_owe_you': 'you_owe_them',
    'you_owe_them': 'they_owe_you',
    'they_paid_you': 'you_paid_them',
    'you_paid_them': 'they_paid_you',
    'invoice': 'invoice',
    'bill': 'bill'
  };
  const flippedType = FLIP[token.entry.tx_type] || token.entry.tx_type;

  // Create entry in recipient's records
  const { data: newEntry, error } = await supabase
    .from('entries')
    .insert({
      user_id: recipientId,
      tx_type: flippedType,
      sender_tx_type: token.entry.tx_type,
      amount: token.entry.amount,
      currency: token.entry.currency,
      date: token.entry.date,
      note: token.entry.note || '',
      invoice_number: token.entry.invoice_number || '',
      is_shared: true,
      share_token: token.token,
      from_name: '', // will be resolved by caller
      from_email: '',
      status: 'accepted'
    })
    .select()
    .single();
  if (error) console.error('[confirmShare]', error.message);
  return newEntry;
}

// ── Dismiss share ─────────────────────────────────────────────────
export async function dismissShare(tokenId) {
  return updateShareStatus(tokenId, 'dismissed');
}

// ── Expire share ──────────────────────────────────────────────────
export async function expireShare(tokenId) {
  return updateShareStatus(tokenId, 'expired');
}

// ── Generate share URL ────────────────────────────────────────────
export function getShareUrl(token) {
  return window.location.origin + '/v2/view?t=' + token;
}
