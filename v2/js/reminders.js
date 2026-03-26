// Money IntX v2 — Reminders Module
import { supabase } from './supabase.js';

// ── Create scheduled reminder ─────────────────────────────────────
export async function createScheduledReminder(userId, entryId, {
  nextSendAt, repeatDays = 0, maxSends = 1, notifyWho = 'them', message = ''
}) {
  const { data, error } = await supabase
    .from('scheduled_reminders')
    .insert({
      user_id: userId,
      entry_id: entryId,
      next_send_at: nextSendAt,
      repeat_days: repeatDays,
      max_sends: maxSends,
      notify_who: notifyWho,
      message,
      active: true
    })
    .select()
    .single();
  if (error) console.error('[createScheduledReminder]', error.message);
  return data;
}

// ── List active reminders for user ────────────────────────────────
export async function listActiveReminders(userId) {
  const { data, error } = await supabase
    .from('scheduled_reminders')
    .select('*, entry:entries(id, amount, currency, tx_type, contact:contacts(id, name))')
    .eq('user_id', userId)
    .eq('active', true)
    .order('next_send_at');
  if (error) console.error('[listActiveReminders]', error.message);
  return data || [];
}

// ── List all reminders for entry ──────────────────────────────────
export async function listEntryReminders(entryId) {
  const { data, error } = await supabase
    .from('scheduled_reminders')
    .select('*')
    .eq('entry_id', entryId)
    .order('created_at', { ascending: false });
  if (error) console.error('[listEntryReminders]', error.message);
  return data || [];
}

// ── Cancel reminder ───────────────────────────────────────────────
export async function cancelReminder(id) {
  const { error } = await supabase
    .from('scheduled_reminders')
    .update({ active: false })
    .eq('id', id);
  if (error) console.error('[cancelReminder]', error.message);
  return !error;
}

// ── Process due reminders (call on interval) ──────────────────────
export async function processDueReminders(userId) {
  const now = new Date().toISOString();
  const { data: due, error } = await supabase
    .from('scheduled_reminders')
    .select('*, entry:entries(id, amount, currency, tx_type, status, contact:contacts(id, name, linked_user_id))')
    .eq('user_id', userId)
    .eq('active', true)
    .lte('next_send_at', now);
  if (error || !due?.length) return [];

  const processed = [];
  for (const rem of due) {
    // Skip if entry is settled/voided
    const st = rem.entry?.status;
    if (['settled', 'voided', 'fulfilled', 'cancelled'].includes(st)) {
      await supabase.from('scheduled_reminders').update({ active: false }).eq('id', rem.id);
      continue;
    }
    // Check max sends
    if (rem.max_sends > 0 && rem.sent_count >= rem.max_sends) {
      await supabase.from('scheduled_reminders').update({ active: false }).eq('id', rem.id);
      continue;
    }
    // Create notification for recipient
    const contactName = rem.entry?.contact?.name || 'Someone';
    const linkedUserId = rem.entry?.contact?.linked_user_id;
    if (linkedUserId) {
      await supabase.from('notifications').insert({
        user_id: linkedUserId,
        type: 'reminder',
        message: rem.message || `Reminder from ${contactName}`,
        entry_id: rem.entry_id,
        contact_name: contactName,
        amount: rem.entry?.amount,
        currency: rem.entry?.currency
      });
    }
    // Self notification
    await supabase.from('notifications').insert({
      user_id: userId,
      type: 'reminder',
      message: `Reminder sent to ${contactName}: ${rem.message || 'Payment reminder'}`,
      entry_id: rem.entry_id,
      contact_name: contactName,
      amount: rem.entry?.amount,
      currency: rem.entry?.currency
    });
    // Increment reminder count on entry
    await supabase.from('entries').update({
      reminder_count: (rem.entry?.reminder_count || 0) + 1,
      last_reminder_at: now
    }).eq('id', rem.entry_id);
    // Update reminder: increment sent_count, schedule next or deactivate
    const newCount = rem.sent_count + 1;
    const updates = { sent_count: newCount };
    if (rem.repeat_days > 0 && (rem.max_sends === 0 || newCount < rem.max_sends)) {
      updates.next_send_at = new Date(Date.now() + rem.repeat_days * 86400000).toISOString();
    } else {
      updates.active = false;
    }
    await supabase.from('scheduled_reminders').update(updates).eq('id', rem.id);
    processed.push(rem);
  }
  return processed;
}
