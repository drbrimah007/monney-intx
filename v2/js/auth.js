// Money IntX v2 — Auth Module
import { supabase, getProfile } from './supabase.js';
import { toast, navigate } from './ui.js';

// ── Sign Up ───────────────────────────────────────────────────────
export async function signUp({ email, password, displayName }) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName }
    }
  });
  if (error) {
    toast(error.message, 'error');
    return null;
  }
  // Update the users table with display name
  if (data.user) {
    await supabase.from('users').update({
      display_name: displayName,
      verified_email: !!data.user.email_confirmed_at
    }).eq('id', data.user.id);
  }
  toast('Account created! Check your email to verify.', 'success');
  return data.user;
}

// ── Log In ────────────────────────────────────────────────────────
export async function logIn({ email, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });
  if (error) {
    toast(error.message, 'error');
    return null;
  }
  return data.user;
}

// ── Log Out ───────────────────────────────────────────────────────
export async function logOut() {
  const { error } = await supabase.auth.signOut();
  if (error) toast(error.message, 'error');
  navigate('landing');
}

// ── Password Reset ────────────────────────────────────────────────
export async function resetPassword(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + '/reset'
  });
  if (error) {
    toast(error.message, 'error');
    return false;
  }
  toast('Password reset email sent.', 'success');
  return true;
}

// ── Update Password ───────────────────────────────────────────────
export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    toast(error.message, 'error');
    return false;
  }
  toast('Password updated.', 'success');
  return true;
}

// ── Session Listener ──────────────────────────────────────────────
export function onAuthChange(callback) {
  supabase.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
}
