// Money IntX v2 — Notifications Module
import { supabase } from './supabase.js';

export async function listNotifications(userId, { unreadOnly = false, limit = 50 } = {}) {
  let query = supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (unreadOnly) query = query.eq('read', false);
  const { data, error } = await query;
  if (error) console.error('[listNotifications]', error.message);
  return data || [];
}

export async function getUnreadCount(userId) {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('read', false);
  if (error) console.error('[getUnreadCount]', error.message);
  return count || 0;
}

export async function markRead(id) {
  const { error } = await supabase
    .from('notifications')
    .update({ read: true, read_at: new Date().toISOString() })
    .eq('id', id);
  if (error) console.error('[markRead]', error.message);
  return !error;
}

export async function markAllRead(userId) {
  const { error } = await supabase
    .from('notifications')
    .update({ read: true, read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('read', false);
  if (error) console.error('[markAllRead]', error.message);
  return !error;
}

export async function deleteNotification(id) {
  const { error } = await supabase.from('notifications').delete().eq('id', id);
  if (error) console.error('[deleteNotification]', error.message);
  return !error;
}

export async function createNotification(userId, { type, message, title = '', entryId = null, contactId = null, contactName = '', amount = null, currency = 'USD' }) {
  const { data, error } = await supabase
    .from('notifications')
    .insert({
      user_id: userId,
      type,
      message,
      title,
      entry_id: entryId,
      contact_id: contactId,
      contact_name: contactName,
      amount,
      currency
    })
    .select()
    .single();
  if (error) console.error('[createNotification]', error.message);
  return data;
}

// ── Realtime subscription ─────────────────────────────────────────
export function subscribeToNotifications(userId, onNew) {
  return supabase
    .channel('notifications:' + userId)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'notifications',
      filter: 'user_id=eq.' + userId
    }, payload => {
      onNew(payload.new);
    })
    .subscribe();
}
