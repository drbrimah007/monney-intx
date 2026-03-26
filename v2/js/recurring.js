// Money IntX v2 — Recurring Rules Module
import { supabase } from './supabase.js';
import { toCents, createEntry } from './entries.js';

export async function listRecurring(userId) {
  const { data, error } = await supabase
    .from('recurring_rules')
    .select('*, contact:contacts(id, name), template:templates(id, name)')
    .eq('user_id', userId)
    .order('next_run_at');
  if (error) console.error('[listRecurring]', error.message);
  return data || [];
}

export async function createRecurring(userId, { contactId, templateId, frequency, customDays, nextRunAt, txType, amount, currency = 'USD', note = '', autoNotify = false, notifyWho = 'them', notifyMessage = '', maxRuns }) {
  const { data, error } = await supabase.from('recurring_rules').insert({
    user_id: userId, contact_id: contactId, template_id: templateId,
    frequency, custom_days: customDays || null,
    next_run_at: nextRunAt, tx_type: txType, amount: toCents(amount),
    currency, note, auto_notify: autoNotify, notify_who: notifyWho,
    notify_message: notifyMessage, max_runs: maxRuns || null
  }).select().single();
  if (error) console.error('[createRecurring]', error.message);
  return data;
}

export async function updateRecurring(id, updates) {
  if (updates.amount !== undefined) updates.amount = toCents(updates.amount);
  const { data, error } = await supabase.from('recurring_rules')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error) console.error('[updateRecurring]', error.message);
  return data;
}

export async function deleteRecurring(id) {
  const { error } = await supabase.from('recurring_rules').delete().eq('id', id);
  return !error;
}

export async function toggleRecurring(id, active) {
  return updateRecurring(id, { active });
}

export async function processDueRecurring(userId) {
  const now = new Date().toISOString();
  const { data: due } = await supabase.from('recurring_rules')
    .select('*')
    .eq('user_id', userId)
    .eq('active', true)
    .lte('next_run_at', now);
  if (!due?.length) return [];

  const processed = [];
  for (const rule of due) {
    if (rule.max_runs && rule.run_count >= rule.max_runs) {
      await supabase.from('recurring_rules').update({ active: false }).eq('id', rule.id);
      continue;
    }
    // Create the entry
    await createEntry(userId, {
      contactId: rule.contact_id, txType: rule.tx_type,
      amount: rule.amount / 100, currency: rule.currency,
      note: rule.note, templateId: rule.template_id
    });
    // Calculate next run
    const freq = { daily: 1, weekly: 7, biweekly: 14, monthly: 30, quarterly: 90, yearly: 365, custom: rule.custom_days || 30 };
    const days = freq[rule.frequency] || 30;
    const nextRun = new Date(Date.now() + days * 86400000).toISOString();
    await supabase.from('recurring_rules').update({
      next_run_at: nextRun, last_run_at: now, run_count: rule.run_count + 1
    }).eq('id', rule.id);
    processed.push(rule);
  }
  return processed;
}

export const FREQUENCIES = {
  daily: 'Daily', weekly: 'Weekly', biweekly: 'Bi-weekly',
  monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly', custom: 'Custom'
};
