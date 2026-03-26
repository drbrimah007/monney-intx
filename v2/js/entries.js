// Money IntX v2 — Entries Module
import { supabase } from './supabase.js';

// Amount helpers: UI works in dollars, DB stores cents
export function toCents(dollars) { return Math.round(parseFloat(dollars) * 100); }
export function toDollars(cents) { return (cents / 100).toFixed(2); }
export function fmtMoney(cents, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency,
      minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(cents / 100);
  } catch (_) {
    return '$' + (cents / 100).toFixed(2);
  }
}

// ── List entries ──────────────────────────────────────────────────
export async function listEntries(userId, { status, txType, contactId, limit = 50, offset = 0, orderBy = 'created_at', ascending = false } = {}) {
  let query = supabase
    .from('entries')
    .select('*, contact:contacts(id, name, email)')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order(orderBy, { ascending })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);
  if (txType) query = query.eq('tx_type', txType);
  if (contactId) query = query.eq('contact_id', contactId);

  const { data, error, count } = await query;
  if (error) console.error('[listEntries]', error.message);
  return data || [];
}

// ── Recent entries (dashboard) ────────────────────────────────────
export async function recentEntries(userId, limit = 10) {
  const { data, error } = await supabase
    .from('entries')
    .select('*, contact:contacts(id, name, email)')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) console.error('[recentEntries]', error.message);
  return data || [];
}

// ── Get single entry ──────────────────────────────────────────────
export async function getEntry(id) {
  const { data, error } = await supabase
    .from('entries')
    .select('*, contact:contacts(id, name, email), settlements(*)')
    .eq('id', id)
    .single();
  if (error) console.error('[getEntry]', error.message);
  return data;
}

// ── Create entry ──────────────────────────────────────────────────
export async function createEntry(userId, {
  contactId, txType, amount, currency = 'USD', note = '',
  date, invoiceNumber = '', templateId = null, templateData = {},
  status = 'posted'
}) {
  // Increment entry counter
  const { data: user } = await supabase
    .from('users')
    .select('entry_counter')
    .eq('id', userId)
    .single();
  const nextNum = (user?.entry_counter || 0) + 1;
  await supabase.from('users').update({ entry_counter: nextNum }).eq('id', userId);

  const { data, error } = await supabase
    .from('entries')
    .insert({
      user_id: userId,
      contact_id: contactId,
      tx_type: txType,
      amount: toCents(amount),
      currency,
      note,
      date: date || new Date().toISOString().slice(0, 10),
      invoice_number: invoiceNumber,
      entry_number: nextNum,
      template_id: templateId,
      template_data: templateData,
      status
    })
    .select('*, contact:contacts(id, name, email)')
    .single();
  if (error) console.error('[createEntry]', error.message);
  return data;
}

// ── Update entry ──────────────────────────────────────────────────
export async function updateEntry(id, updates) {
  // Convert amount to cents if provided
  if (updates.amount !== undefined) updates.amount = toCents(updates.amount);
  const { data, error } = await supabase
    .from('entries')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*, contact:contacts(id, name, email)')
    .single();
  if (error) console.error('[updateEntry]', error.message);
  return data;
}

// ── Delete entry ──────────────────────────────────────────────────
export async function deleteEntry(id) {
  const { error } = await supabase.from('entries').delete().eq('id', id);
  if (error) console.error('[deleteEntry]', error.message);
  return !error;
}

// ── Archive / Unarchive ───────────────────────────────────────────
export async function archiveEntry(id) {
  return updateEntry(id, { archived_at: new Date().toISOString() });
}
export async function unarchiveEntry(id) {
  return updateEntry(id, { archived_at: null });
}

// ── Void entry ────────────────────────────────────────────────────
export async function voidEntry(id) {
  return updateEntry(id, { status: 'voided' });
}

// ── Record settlement ─────────────────────────────────────────────
export async function recordSettlement(entryId, { amount, method = '', note = '', proofUrl = '', recordedBy }) {
  const { data, error } = await supabase
    .from('settlements')
    .insert({
      entry_id: entryId,
      amount: toCents(amount),
      method,
      note,
      proof_url: proofUrl,
      recorded_by: recordedBy
    })
    .select()
    .single();
  if (error) console.error('[recordSettlement]', error.message);
  // The DB trigger auto-updates entry.settled_amount and status
  return data;
}

// ── Get settlements for entry ─────────────────────────────────────
export async function getSettlements(entryId) {
  const { data, error } = await supabase
    .from('settlements')
    .select('*')
    .eq('entry_id', entryId)
    .order('created_at', { ascending: false });
  if (error) console.error('[getSettlements]', error.message);
  return data || [];
}

// ── Dashboard totals ──────────────────────────────────────────────
export async function getDashboardTotals(userId) {
  const { data, error } = await supabase
    .from('dashboard_totals')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error && error.code !== 'PGRST116') console.error('[getDashboardTotals]', error.message);
  return data || { total_they_owe_me: 0, total_i_owe_them: 0, total_net: 0 };
}

// ── Ledger per contact ────────────────────────────────────────────
export async function getLedgerSummary(userId) {
  const { data, error } = await supabase
    .from('ledger_summary')
    .select('*')
    .eq('user_id', userId);
  if (error) console.error('[getLedgerSummary]', error.message);
  return data || [];
}
