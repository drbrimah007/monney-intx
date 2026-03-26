// Money IntX v2 — Groups Module
import { supabase } from './supabase.js';
import { toCents, fmtMoney } from './entries.js';

// ── List groups ───────────────────────────────────────────────────
export async function listGroups(userId) {
  const { data, error } = await supabase
    .from('groups')
    .select('*, members:group_members(*), rounds:group_rounds(*, contributions:group_contributions(*))')
    .or(`user_id.eq.${userId},id.in.(${await memberGroupIds(userId)})`)
    .is('archived_at', null)
    .order('created_at', { ascending: false });
  if (error) console.error('[listGroups]', error.message);
  return data || [];
}

async function memberGroupIds(userId) {
  const { data } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId)
    .eq('status', 'active');
  return (data || []).map(r => r.group_id).join(',') || '00000000-0000-0000-0000-000000000000';
}

// ── Get single group ──────────────────────────────────────────────
export async function getGroup(id) {
  const { data, error } = await supabase
    .from('groups')
    .select('*, members:group_members(*), rounds:group_rounds(*, contributions:group_contributions(*))')
    .eq('id', id)
    .single();
  if (error) console.error('[getGroup]', error.message);
  return data;
}

// ── Create group ──────────────────────────────────────────────────
export async function createGroup(userId, { name, description = '', amount = 0, currency = 'USD', frequency = 'monthly', useRotation = false }) {
  const { data, error } = await supabase
    .from('groups')
    .insert({
      user_id: userId,
      name,
      description,
      amount: toCents(amount),
      currency,
      frequency,
      use_rotation: useRotation
    })
    .select()
    .single();
  if (error) console.error('[createGroup]', error.message);
  // Add creator as owner member
  if (data) {
    const { data: profile } = await supabase.from('users').select('display_name').eq('id', userId).single();
    await supabase.from('group_members').insert({
      group_id: data.id,
      user_id: userId,
      name: profile?.display_name || 'Owner',
      role: 'owner',
      status: 'active'
    });
  }
  return data;
}

// ── Update group ──────────────────────────────────────────────────
export async function updateGroup(id, updates) {
  if (updates.amount !== undefined) updates.amount = toCents(updates.amount);
  const { data, error } = await supabase
    .from('groups')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) console.error('[updateGroup]', error.message);
  return data;
}

// ── Delete group ──────────────────────────────────────────────────
export async function deleteGroup(id) {
  const { error } = await supabase.from('groups').delete().eq('id', id);
  if (error) console.error('[deleteGroup]', error.message);
  return !error;
}

// ── Archive group ─────────────────────────────────────────────────
export async function archiveGroup(id) {
  return updateGroup(id, { archived_at: new Date().toISOString() });
}

// ── Add member ────────────────────────────────────────────────────
export async function addGroupMember(groupId, { userId = null, contactId = null, name, role = 'member' }) {
  const { data, error } = await supabase
    .from('group_members')
    .insert({
      group_id: groupId,
      user_id: userId,
      contact_id: contactId,
      name,
      role,
      status: 'active'
    })
    .select()
    .single();
  if (error) console.error('[addGroupMember]', error.message);
  return data;
}

// ── Remove member ─────────────────────────────────────────────────
export async function removeGroupMember(memberId) {
  const { error } = await supabase
    .from('group_members')
    .update({ status: 'removed' })
    .eq('id', memberId);
  if (error) console.error('[removeGroupMember]', error.message);
  return !error;
}

// ── Update member role ────────────────────────────────────────────
export async function updateMemberRole(memberId, role) {
  const { error } = await supabase
    .from('group_members')
    .update({ role })
    .eq('id', memberId);
  if (error) console.error('[updateMemberRole]', error.message);
  return !error;
}

// ── Create round ──────────────────────────────────────────────────
export async function createRound(groupId, { collectorId = null } = {}) {
  // Get next round number
  const { data: rounds } = await supabase
    .from('group_rounds')
    .select('round_number')
    .eq('group_id', groupId)
    .order('round_number', { ascending: false })
    .limit(1);
  const nextNum = (rounds?.[0]?.round_number || 0) + 1;

  const { data: round, error } = await supabase
    .from('group_rounds')
    .insert({
      group_id: groupId,
      round_number: nextNum,
      collector_id: collectorId
    })
    .select()
    .single();
  if (error) console.error('[createRound]', error.message);

  // Create contribution rows for all active members
  if (round) {
    const { data: members } = await supabase
      .from('group_members')
      .select('id')
      .eq('group_id', groupId)
      .eq('status', 'active');
    const { data: group } = await supabase.from('groups').select('amount').eq('id', groupId).single();
    if (members?.length) {
      const rows = members.map(m => ({
        round_id: round.id,
        member_id: m.id,
        amount: group?.amount || 0
      }));
      await supabase.from('group_contributions').insert(rows);
    }
  }
  return round;
}

// ── Mark contribution paid ────────────────────────────────────────
export async function markContributionPaid(contributionId) {
  const { error } = await supabase
    .from('group_contributions')
    .update({ paid: true, paid_at: new Date().toISOString() })
    .eq('id', contributionId);
  if (error) console.error('[markContributionPaid]', error.message);
  return !error;
}

// ── Complete round ────────────────────────────────────────────────
export async function completeRound(roundId) {
  const { error } = await supabase
    .from('group_rounds')
    .update({ status: 'completed' })
    .eq('id', roundId);
  if (error) console.error('[completeRound]', error.message);
  return !error;
}

// ── Notice board ──────────────────────────────────────────────────
export async function getNoticeBoard(groupId) {
  const { data, error } = await supabase
    .from('notice_board')
    .select('*')
    .eq('group_id', groupId)
    .order('created_at', { ascending: false });
  if (error) console.error('[getNoticeBoard]', error.message);
  return data || [];
}

export async function postNotice(groupId, userId, userName, message) {
  const { data, error } = await supabase
    .from('notice_board')
    .insert({ group_id: groupId, user_id: userId, user_name: userName, message })
    .select()
    .single();
  if (error) console.error('[postNotice]', error.message);
  return data;
}

// ── Group stats ───────────────────────────────────────────────────
export function calcGroupStats(group) {
  const members = (group.members || []).filter(m => m.status === 'active');
  const rounds = group.rounds || [];
  const totalCollected = rounds.reduce((sum, r) =>
    sum + (r.contributions || []).filter(c => c.paid).reduce((s, c) => s + (c.amount || 0), 0), 0);
  const currentRound = rounds.find(r => r.status === 'active');
  const paidInRound = currentRound ? (currentRound.contributions || []).filter(c => c.paid).length : 0;
  return { memberCount: members.length, roundCount: rounds.length, totalCollected, currentRound, paidInRound };
}
