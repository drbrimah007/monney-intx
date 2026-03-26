// Money IntX v2 — Admin Module
import { supabase } from './supabase.js';

// ── List all users (admin only) ───────────────────────────────────
export async function listAllUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) console.error('[listAllUsers]', error.message);
  return data || [];
}

// ── Update user role/status ───────────────────────────────────────
export async function updateUserRole(userId, role) {
  const { error } = await supabase.from('users').update({ role }).eq('id', userId);
  if (error) console.error('[updateUserRole]', error.message);
  return !error;
}

export async function updateUserStatus(userId, status) {
  const { error } = await supabase.from('users').update({ status }).eq('id', userId);
  if (error) console.error('[updateUserStatus]', error.message);
  return !error;
}

// ── Audit log ─────────────────────────────────────────────────────
export async function getAuditLog({ userId, limit = 100 } = {}) {
  let query = supabase.from('audit_log').select('*, user:users(display_name)').order('created_at', { ascending: false }).limit(limit);
  if (userId) query = query.eq('user_id', userId);
  const { data, error } = await query;
  if (error) console.error('[getAuditLog]', error.message);
  return data || [];
}

export async function logAudit(userId, action, { entityType, entityId, details = {} } = {}) {
  await supabase.from('audit_log').insert({
    user_id: userId, action, entity_type: entityType || null,
    entity_id: entityId || null, details
  });
}

// ── Email log ─────────────────────────────────────────────────────
export async function getEmailLog(userId, { limit = 50 } = {}) {
  const { data, error } = await supabase
    .from('email_log')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) console.error('[getEmailLog]', error.message);
  return data || [];
}

// ── Platform stats ────────────────────────────────────────────────
export async function getPlatformStats() {
  const [users, entries, contacts, groups, investments] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact', head: true }),
    supabase.from('entries').select('id', { count: 'exact', head: true }),
    supabase.from('contacts').select('id', { count: 'exact', head: true }),
    supabase.from('groups').select('id', { count: 'exact', head: true }),
    supabase.from('investments').select('id', { count: 'exact', head: true }),
  ]);
  return {
    userCount: users.count || 0,
    entryCount: entries.count || 0,
    contactCount: contacts.count || 0,
    groupCount: groups.count || 0,
    investmentCount: investments.count || 0
  };
}
