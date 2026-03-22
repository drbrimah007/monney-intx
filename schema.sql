-- Money Intx — Database Schema
-- Run this once in your Neon SQL editor (neon.tech → your project → SQL Editor)

-- ── USERS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  TEXT        NOT NULL,
  username      TEXT        UNIQUE NOT NULL,
  email         TEXT        UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'standard',  -- 'admin' | 'standard'
  status        TEXT        NOT NULL DEFAULT 'active',    -- 'active' | 'suspended'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── USER DATA BLOB ────────────────────────────────────────────────────────
-- Stores the entire app db as JSONB per user.
-- This lets us ship real persistence without rewriting every CRUD endpoint.
-- Replace individual fields with normalized tables progressively later.
CREATE TABLE IF NOT EXISTS user_data (
  user_id    UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       JSONB       NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── PASSWORD RESET TOKENS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_resets (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast token lookups
CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token);

-- ── APP SETTINGS (global, admin-only) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT 'null',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Default admin account (change password immediately after first login!)
-- Password: admin  (bcrypt hash below = bcrypt('admin', 10))
INSERT INTO users (display_name, username, email, password_hash, role)
VALUES (
  'Admin',
  'admin',
  'admin@moneyintx.local',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', -- "password" placeholder
  'admin'
)
ON CONFLICT (email) DO NOTHING;

-- ── SHARE TOKENS ──────────────────────────────────────────────────────────
-- Stores public shareable links for entries. No auth required to view.
CREATE TABLE IF NOT EXISTS share_tokens (
  token            TEXT        PRIMARY KEY,
  user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id         TEXT        NOT NULL,
  entry_data       JSONB       NOT NULL,
  acknowledged     BOOLEAN     NOT NULL DEFAULT false,
  acknowledged_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_share_tokens_entry ON share_tokens(entry_id, user_id);

-- NOTE: The hash above is a placeholder. After deploying, use the /api/auth/signup
-- endpoint to create your real admin account, or update the hash using:
--   node -e "console.log(require('bcryptjs').hashSync('yourpassword', 10))"
