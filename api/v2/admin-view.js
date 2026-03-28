// GET /api/v2/admin-view?userId=<uuid>
// Admin-only: returns a full data snapshot of any user, bypassing RLS.
// Requires SUPABASE_SERVICE_KEY in Vercel environment variables.
// Used by the V2 impersonation ("View As") feature in the Admin panel.

const SUPABASE_URL     = 'https://nczneamvffmzdbeuvloo.supabase.co';
const SUPABASE_ANON    = 'sb_publishable_fzv-ZnSvv6p-Udo8ygJN9g_VekzqguV';
const SERVICE_KEY      = process.env.SUPABASE_SERVICE_KEY;

// ── Helpers ────────────────────────────────────────────────────────────────────
function svcHeaders() {
  return {
    'apikey':        SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
    'Accept':        'application/json',
    'Content-Type':  'application/json'
  };
}

async function svcGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: svcHeaders() });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}

// ── Handler ────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // ── Service key check ──────────────────────────────────────────────────────
  if (!SERVICE_KEY) {
    return res.status(503).json({
      ok: false,
      error: 'SUPABASE_SERVICE_KEY is not configured.',
      setup: 'Go to Vercel → your project → Settings → Environment Variables → add SUPABASE_SERVICE_KEY with your Supabase service_role key (from Supabase → Project Settings → API → service_role secret). Then redeploy.'
    });
  }

  // ── Verify caller is authenticated ─────────────────────────────────────────
  const jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return res.status(401).json({ ok: false, error: 'Authorization header required' });

  let callerId;
  try {
    const authRes  = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPABASE_ANON, 'Authorization': `Bearer ${jwt}` }
    });
    const authData = await authRes.json();
    callerId = authData?.id;
    if (!callerId) throw new Error('invalid JWT');
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }

  // ── Verify caller is platform_admin ────────────────────────────────────────
  let callerRole;
  try {
    const rows = await svcGet(`users?id=eq.${callerId}&select=role&limit=1`);
    callerRole = rows?.[0]?.role;
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Could not verify caller role: ' + e.message });
  }
  if (callerRole !== 'platform_admin') {
    return res.status(403).json({ ok: false, error: 'platform_admin role required' });
  }

  // ── Validate target user ID ────────────────────────────────────────────────
  const { userId } = req.query;
  if (!userId || !/^[0-9a-f-]{36}$/.test(userId)) {
    return res.status(400).json({ ok: false, error: 'Valid userId (UUID) required' });
  }

  // ── Fetch target user's full data snapshot ─────────────────────────────────
  try {
    const enc = encodeURIComponent;
    const [users, entries, contacts, notifications, groups, settlements] = await Promise.all([
      svcGet(`users?id=eq.${userId}&limit=1`),
      svcGet(`entries?user_id=eq.${userId}&select=*,contact:contacts(id,name,email,linked_user_id)&order=created_at.desc&limit=300`),
      svcGet(`contacts?user_id=eq.${userId}&select=*&order=name`),
      svcGet(`notifications?user_id=eq.${userId}&select=*&order=created_at.desc&limit=100`),
      svcGet(`groups?select=*,members:group_members(*)&or=(user_id.eq.${userId},members.user_id.eq.${userId})`).catch(() => []),
      svcGet(`settlements?select=*&limit=200`).catch(() => [])
    ]);

    return res.json({
      ok: true,
      user:          users?.[0]   || null,
      entries:       Array.isArray(entries)       ? entries       : [],
      contacts:      Array.isArray(contacts)      ? contacts      : [],
      notifications: Array.isArray(notifications) ? notifications : [],
      groups:        Array.isArray(groups)        ? groups        : [],
      settlements:   Array.isArray(settlements)   ? settlements   : []
    });
  } catch (e) {
    console.error('[admin-view]', e.message);
    return res.status(500).json({ ok: false, error: 'Failed to fetch user data: ' + e.message });
  }
};
