// Money IntX v2 — NOK / Trusted Access Module
import { supabase } from './supabase.js';

export async function listTrustees(userId) {
  const { data, error } = await supabase
    .from('nok_trustees')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[listTrustees]', error.message);
  return data || [];
}

export async function createTrustee(userId, { trusteeName, trusteeEmail, relationship = '', accessLevel = 'readonly', releaseType = 'manual', inactivityDays = 90 }) {
  const code = Math.random().toString(36).substr(2, 8).toUpperCase();
  const { data, error } = await supabase.from('nok_trustees').insert({
    user_id: userId, trustee_name: trusteeName, trustee_email: trusteeEmail,
    relationship, access_level: accessLevel, release_type: releaseType,
    inactivity_days: inactivityDays, verification_code: code
  }).select().single();
  if (error) console.error('[createTrustee]', error.message);
  return data;
}

export async function updateTrustee(id, updates) {
  const { data, error } = await supabase.from('nok_trustees')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error) console.error('[updateTrustee]', error.message);
  return data;
}

export async function deleteTrustee(id) {
  const { error } = await supabase.from('nok_trustees').delete().eq('id', id);
  return !error;
}

export async function verifyTrustee(id) {
  return updateTrustee(id, { verified: true, verified_at: new Date().toISOString() });
}

export async function activateTrustee(id, reason = '') {
  return updateTrustee(id, { activated: true, activated_at: new Date().toISOString(), activation_reason: reason });
}
