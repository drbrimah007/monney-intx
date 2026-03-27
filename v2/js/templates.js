// Money IntX v2 — Templates Module
import { supabase } from './supabase.js';

export async function listTemplates(userId) {
  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[listTemplates]', error.message);
  return data || [];
}

export async function listPublicTemplates() {
  const { data, error } = await supabase
    .from('templates')
    .select('*, creator:users(display_name)')
    .eq('is_public', true)
    .is('archived_at', null)
    .order('created_at', { ascending: false });
  if (error) console.error('[listPublicTemplates]', error.message);
  return data || [];
}

export async function getTemplate(id) {
  const { data, error } = await supabase.from('templates').select('*').eq('id', id).single();
  if (error) console.error('[getTemplate]', error.message);
  return data;
}

export async function createTemplate(userId, {
  name,
  description = '',
  txType = null,
  fields = [],
  invoicePrefix = 'INV-',
  invoiceNextNum = 1,
  currency = ''
} = {}) {
  const { data, error } = await supabase.from('templates').insert({
    user_id: userId,
    name,
    description,
    tx_type: txType,
    fields,
    invoice_prefix: invoicePrefix,
    invoice_next_num: invoiceNextNum,
    currency: currency || ''
  }).select().single();
  if (error) console.error('[createTemplate]', error.message);
  return data;
}

export async function updateTemplate(id, updates) {
  const { data, error } = await supabase
    .from('templates')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) console.error('[updateTemplate]', error.message);
  return data;
}

export async function deleteTemplate(id) {
  const { error } = await supabase.from('templates').delete().eq('id', id);
  return !error;
}

export async function copyPublicTemplate(userId, templateId) {
  const original = await getTemplate(templateId);
  if (!original) return null;
  // Deep-clone fields with new IDs to avoid collisions
  const clonedFields = (original.fields || []).map(f => ({
    ...f,
    id: crypto.randomUUID()
  }));
  return createTemplate(userId, {
    name: original.name + ' (Copy)',
    description: original.description,
    txType: original.tx_type,
    fields: clonedFields,
    invoicePrefix: original.invoice_prefix,
    invoiceNextNum: original.invoice_next_num || 1,
    currency: original.currency || ''
  });
}

export async function togglePublic(id, isPublic) {
  return updateTemplate(id, { is_public: isPublic });
}

export async function archiveTemplate(id) {
  return updateTemplate(id, { archived_at: new Date().toISOString() });
}
