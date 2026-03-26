// Money IntX v2 — Investments Module
import { supabase } from './supabase.js';
import { toCents, fmtMoney } from './entries.js';

export async function listInvestments(userId) {
  const { data, error } = await supabase
    .from('investments')
    .select('*, members:investment_members(*), transactions:investment_transactions(*)')
    .or(`user_id.eq.${userId},id.in.(${await memberInvIds(userId)})`)
    .is('archived_at', null)
    .order('created_at', { ascending: false });
  if (error) console.error('[listInvestments]', error.message);
  return data || [];
}

async function memberInvIds(userId) {
  const { data } = await supabase.from('investment_members').select('investment_id').eq('user_id', userId);
  return (data || []).map(r => r.investment_id).join(',') || '00000000-0000-0000-0000-000000000000';
}

export async function getInvestment(id) {
  const { data, error } = await supabase
    .from('investments')
    .select('*, members:investment_members(*), transactions:investment_transactions(*)')
    .eq('id', id).single();
  if (error) console.error('[getInvestment]', error.message);
  return data;
}

export async function createInvestment(userId, { name, description = '', type = 'general', ventureType = 'personal', accessMode = 'private', initialAmount = 0, currency = 'USD', expectedReturn }) {
  const { data, error } = await supabase.from('investments').insert({
    user_id: userId, name, description, type, venture_type: ventureType,
    access_mode: accessMode, initial_amount: toCents(initialAmount),
    currency, expected_return: expectedReturn || null
  }).select().single();
  if (error) console.error('[createInvestment]', error.message);
  if (data) {
    const { data: profile } = await supabase.from('users').select('display_name').eq('id', userId).single();
    await supabase.from('investment_members').insert({
      investment_id: data.id, user_id: userId, name: profile?.display_name || 'Owner', role: 'owner'
    });
  }
  return data;
}

export async function updateInvestment(id, updates) {
  if (updates.initial_amount !== undefined) updates.initial_amount = toCents(updates.initial_amount);
  const { data, error } = await supabase.from('investments')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error) console.error('[updateInvestment]', error.message);
  return data;
}

export async function deleteInvestment(id) {
  const { error } = await supabase.from('investments').delete().eq('id', id);
  return !error;
}

export async function addInvestmentMember(investmentId, { userId = null, contactId = null, name, role = 'member' }) {
  const { data, error } = await supabase.from('investment_members').insert({
    investment_id: investmentId, user_id: userId, contact_id: contactId, name, role
  }).select().single();
  if (error) console.error('[addInvestmentMember]', error.message);
  return data;
}

export async function addInvestmentTransaction(investmentId, { type, amount, note = '', recordedBy }) {
  const { data, error } = await supabase.from('investment_transactions').insert({
    investment_id: investmentId, type, amount: toCents(amount), note, recorded_by: recordedBy
  }).select().single();
  if (error) console.error('[addInvestmentTransaction]', error.message);
  return data;
}

export async function getInvestmentSummary(userId) {
  const { data, error } = await supabase.from('investment_summary').select('*').eq('user_id', userId);
  if (error) console.error('[getInvestmentSummary]', error.message);
  return data || [];
}

export function calcInvestmentStats(inv) {
  const txs = inv.transactions || [];
  const deposits = txs.filter(t => ['deposit','capital_contribution'].includes(t.type)).reduce((s, t) => s + t.amount, 0);
  const withdrawals = txs.filter(t => ['withdrawal','profit_distribution'].includes(t.type)).reduce((s, t) => s + t.amount, 0);
  const returns = txs.filter(t => ['dividend','return','revenue'].includes(t.type)).reduce((s, t) => s + t.amount, 0);
  const expenses = txs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const invested = (inv.initial_amount || 0) + deposits;
  const currentVal = invested - withdrawals + returns - expenses;
  const gl = currentVal - invested;
  const roi = invested > 0 ? ((gl / invested) * 100).toFixed(1) : '0.0';
  return { invested, currentVal, gl, roi, deposits, withdrawals, returns, expenses, memberCount: (inv.members || []).length };
}

export const INV_TYPES = { general: 'General', stocks: 'Stocks', realestate: 'Real Estate', business: 'Business', crypto: 'Crypto', other: 'Other' };
export const INV_STATUSES = { active: 'Active', matured: 'Matured', closed: 'Closed', lost: 'Lost' };
