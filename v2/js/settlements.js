// Money IntX v2 — Settlements Module
import { supabase } from './supabase.js';
import { toCents } from './entries.js';

// ── List settlements for an entry ─────────────────────────────────
export async function listSettlements(entryId) {
  const { data, error } = await supabase
    .from('settlements')
    .select('*')
    .eq('entry_id', entryId)
    .order('created_at', { ascending: false });
  if (error) console.error('[listSettlements]', error.message);
  return data || [];
}

// ── Record a settlement ───────────────────────────────────────────
export async function createSettlement(entryId, { amount, method = '', note = '', proofUrl = '', recordedBy, status = 'confirmed' }) {
  const { data, error } = await supabase
    .from('settlements')
    .insert({
      entry_id: entryId,
      amount: toCents(amount),
      method,
      note,
      proof_url: proofUrl,
      recorded_by: recordedBy,
      status
    })
    .select()
    .single();
  if (error) console.error('[createSettlement]', error.message);
  // DB trigger auto-updates entry.settled_amount and status
  return data;
}

// ── Approve/reject a pending settlement ───────────────────────────
export async function reviewSettlement(id, { status, reviewedBy }) {
  const { data, error } = await supabase
    .from('settlements')
    .update({
      status,
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .single();
  if (error) console.error('[reviewSettlement]', error.message);
  return data;
}

// ── Delete a settlement ───────────────────────────────────────────
export async function deleteSettlement(id) {
  const { error } = await supabase.from('settlements').delete().eq('id', id);
  if (error) console.error('[deleteSettlement]', error.message);
  return !error;
}

// ── Upload proof of payment ───────────────────────────────────────
export async function uploadProof(file, userId) {
  const ext = file.name.split('.').pop();
  const path = `${userId}/proofs/${Date.now()}.${ext}`;
  const { data, error } = await supabase.storage
    .from('documents')
    .upload(path, file);
  if (error) {
    console.error('[uploadProof]', error.message);
    return null;
  }
  const { data: { publicUrl } } = supabase.storage.from('documents').getPublicUrl(path);
  return publicUrl;
}
