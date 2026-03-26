// Money IntX v2 — Contacts Module
import { supabase } from './supabase.js';

export async function listContacts(userId, { archived = false } = {}) {
  let query = supabase
    .from('contacts')
    .select('*')
    .eq('user_id', userId)
    .order('name');
  if (!archived) query = query.is('archived_at', null);
  const { data, error } = await query;
  if (error) console.error('[listContacts]', error.message);
  return data || [];
}

export async function getContact(id) {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', id)
    .single();
  if (error) console.error('[getContact]', error.message);
  return data;
}

export async function createContact(userId, { name, email, phone, address, notes, tags }) {
  const { data, error } = await supabase
    .from('contacts')
    .insert({
      user_id: userId,
      name,
      email: email || '',
      phone: phone || '',
      address: address || '',
      notes: notes || '',
      tags: tags || []
    })
    .select()
    .single();
  if (error) console.error('[createContact]', error.message);
  return data;
}

export async function updateContact(id, updates) {
  const { data, error } = await supabase
    .from('contacts')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) console.error('[updateContact]', error.message);
  return data;
}

export async function deleteContact(id) {
  const { error } = await supabase
    .from('contacts')
    .delete()
    .eq('id', id);
  if (error) console.error('[deleteContact]', error.message);
  return !error;
}

export async function archiveContact(id) {
  return updateContact(id, { archived_at: new Date().toISOString() });
}

export async function unarchiveContact(id) {
  return updateContact(id, { archived_at: null });
}
