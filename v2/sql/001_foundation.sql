-- ═══════════════════════════════════════════════════════════════════
-- MONEY INTX v2 — FULL DATABASE SCHEMA
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ═══════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────
-- 1. USERS (extends auth.users)
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email           text NOT NULL,
  display_name    text NOT NULL DEFAULT '',
  username        text UNIQUE,
  phone           text DEFAULT '',
  role            text NOT NULL DEFAULT 'standard' CHECK (role IN ('platform_admin','standard','contact')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned')),
  avatar_url      text DEFAULT '',
  bio             text DEFAULT '',
  city            text DEFAULT '',
  -- Company / branding
  company_name    text DEFAULT '',
  company_email   text DEFAULT '',
  company_phone   text DEFAULT '',
  company_address text DEFAULT '',
  app_name        text DEFAULT 'Money IntX',
  tagline         text DEFAULT 'Making Money Matters Memorable',
  site_url        text DEFAULT '',
  logo_url        text DEFAULT '',
  -- Verification
  verified_email  boolean NOT NULL DEFAULT false,
  verified_phone  boolean NOT NULL DEFAULT false,
  verified_id     boolean NOT NULL DEFAULT false,
  -- Preferences
  default_currency text NOT NULL DEFAULT 'USD',
  timezone        text DEFAULT 'UTC',
  notif_prefs     jsonb NOT NULL DEFAULT '{"inapp":true,"email":true,"sms":false}',
  discoverable    boolean NOT NULL DEFAULT true,
  -- Counters
  entry_counter   int NOT NULL DEFAULT 0,
  -- Timestamps
  last_activity_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_role ON users(role);

-- Auto-create user row on auth signup
CREATE OR REPLACE FUNCTION handle_new_user() RETURNS trigger AS $$
BEGIN
  INSERT INTO users (id, email, display_name, verified_email)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.raw_user_meta_data->>'first_name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.email_confirmed_at IS NOT NULL, false)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- ──────────────────────────────────────────────────────────────────
-- 2. CONTACTS
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  email           text DEFAULT '',
  phone           text DEFAULT '',
  address         text DEFAULT '',
  notes           text DEFAULT '',
  tags            text[] DEFAULT '{}',
  -- Linking to platform user
  linked_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Ledger starting balances (cents)
  start_toy       bigint NOT NULL DEFAULT 0,
  start_yot       bigint NOT NULL DEFAULT 0,
  -- State
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_contacts_user ON contacts(user_id);
CREATE INDEX idx_contacts_linked ON contacts(linked_user_id);
CREATE INDEX idx_contacts_email ON contacts(user_id, email);
CREATE INDEX idx_contacts_name ON contacts(user_id, name);


-- ──────────────────────────────────────────────────────────────────
-- 3. TEMPLATES
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text DEFAULT '',
  tx_type         text,
  fields          jsonb NOT NULL DEFAULT '[]',
  invoice_prefix  text DEFAULT 'INV-',
  invoice_next_num int NOT NULL DEFAULT 1,
  is_public       boolean NOT NULL DEFAULT false,
  copied_from     uuid REFERENCES templates(id) ON DELETE SET NULL,
  copied_from_name text DEFAULT '',
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_templates_user ON templates(user_id);
CREATE INDEX idx_templates_public ON templates(is_public) WHERE is_public = true;


-- ──────────────────────────────────────────────────────────────────
-- 4. ENTRIES (core money records)
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- Type and direction
  tx_type         text NOT NULL CHECK (tx_type IN (
    'they_owe_you','you_owe_them',
    'they_paid_you','you_paid_them',
    'invoice','bill'
  )),
  -- Money (stored as cents — bigint)
  amount          bigint NOT NULL,
  currency        text NOT NULL DEFAULT 'USD',
  -- Settlement tracking
  settled_amount  bigint NOT NULL DEFAULT 0,
  remaining       bigint GENERATED ALWAYS AS (amount - settled_amount) STORED,
  -- Metadata
  note            text DEFAULT '',
  date            date NOT NULL DEFAULT CURRENT_DATE,
  invoice_number  text DEFAULT '',
  entry_number    int,
  -- Status (explicit state machine)
  status          text NOT NULL DEFAULT 'posted' CHECK (status IN (
    'draft','posted','sent','viewed','accepted',
    'partially_settled','settled','fulfilled',
    'overdue','disputed','voided','cancelled','closed'
  )),
  -- Template reference
  template_id     uuid REFERENCES templates(id) ON DELETE SET NULL,
  template_data   jsonb DEFAULT '{}',
  template_snapshot jsonb DEFAULT NULL,
  -- Sharing
  is_shared       boolean NOT NULL DEFAULT false,
  share_token     text,
  from_name       text DEFAULT '',
  from_email      text DEFAULT '',
  from_site_url   text DEFAULT '',
  sender_tx_type  text,
  -- Flags
  no_ledger       boolean NOT NULL DEFAULT false,
  is_receipt      boolean NOT NULL DEFAULT false,
  -- Reminder tracking
  reminder_count  int NOT NULL DEFAULT 0,
  last_reminder_at timestamptz,
  -- Fulfillment
  fulfilled_at    timestamptz,
  fulfillment_note text DEFAULT '',
  -- Soft delete
  archived_at     timestamptz,
  -- Timestamps
  last_activity_at timestamptz,
  last_notified_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_entries_user ON entries(user_id);
CREATE INDEX idx_entries_contact ON entries(contact_id);
CREATE INDEX idx_entries_status ON entries(user_id, status);
CREATE INDEX idx_entries_date ON entries(user_id, date DESC);
CREATE INDEX idx_entries_share_token ON entries(share_token);
CREATE INDEX idx_entries_tx_type ON entries(user_id, tx_type);
CREATE INDEX idx_entries_created ON entries(user_id, created_at DESC);
CREATE INDEX idx_entries_active ON entries(user_id, archived_at) WHERE archived_at IS NULL;


-- ──────────────────────────────────────────────────────────────────
-- 5. ENTRY ATTACHMENTS
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE entry_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id     uuid NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  file_name    text NOT NULL,
  file_type    text NOT NULL,
  file_size    int NOT NULL,
  storage_path text NOT NULL,
  uploaded_by  uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_attachments_entry ON entry_attachments(entry_id);


-- ──────────────────────────────────────────────────────────────────
-- 6. SETTLEMENTS
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE settlements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id     uuid NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  amount       bigint NOT NULL,
  method       text DEFAULT '',
  note         text DEFAULT '',
  proof_url    text DEFAULT '',
  recorded_by  uuid NOT NULL REFERENCES users(id),
  -- Approval
  status       text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending','confirmed','rejected')),
  reviewed_by  uuid REFERENCES users(id),
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_settlements_entry ON settlements(entry_id);
CREATE INDEX idx_settlements_status ON settlements(entry_id, status);

-- Auto-recalculate entry settled_amount + status on settlement change
CREATE OR REPLACE FUNCTION update_entry_settled() RETURNS trigger AS $$
DECLARE
  _entry_id uuid;
  _total_settled bigint;
  _entry_amount bigint;
BEGIN
  _entry_id := COALESCE(NEW.entry_id, OLD.entry_id);

  SELECT COALESCE(SUM(amount), 0) INTO _total_settled
  FROM settlements WHERE entry_id = _entry_id AND status = 'confirmed';

  SELECT amount INTO _entry_amount FROM entries WHERE id = _entry_id;

  UPDATE entries SET
    settled_amount = _total_settled,
    status = CASE
      WHEN _total_settled >= _entry_amount THEN 'settled'
      WHEN _total_settled > 0 THEN 'partially_settled'
      ELSE status
    END,
    updated_at = now()
  WHERE id = _entry_id;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_settlement_update
AFTER INSERT OR UPDATE OR DELETE ON settlements
FOR EACH ROW EXECUTE FUNCTION update_entry_settled();


-- ──────────────────────────────────────────────────────────────────
-- 7. SHARE TOKENS
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE share_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token           text UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  sender_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id        uuid NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  recipient_email text DEFAULT '',
  recipient_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  entry_snapshot  jsonb NOT NULL DEFAULT '{}',
  -- State
  status          text NOT NULL DEFAULT 'created' CHECK (status IN (
    'created','sent','viewed','confirmed','dismissed','expired'
  )),
  confirmed_at    timestamptz,
  viewed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz
);

CREATE INDEX idx_shares_sender ON share_tokens(sender_id);
CREATE INDEX idx_shares_recipient ON share_tokens(recipient_id);
CREATE INDEX idx_shares_entry ON share_tokens(entry_id);
CREATE INDEX idx_shares_token ON share_tokens(token);
CREATE INDEX idx_shares_status ON share_tokens(status);


-- ──────────────────────────────────────────────────────────────────
-- 8. RECURRING RULES
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE recurring_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  template_id     uuid REFERENCES templates(id) ON DELETE SET NULL,
  frequency       text NOT NULL CHECK (frequency IN ('daily','weekly','biweekly','monthly','quarterly','yearly','custom')),
  custom_days     int,
  next_run_at     timestamptz NOT NULL,
  last_run_at     timestamptz,
  tx_type         text NOT NULL,
  amount          bigint NOT NULL,
  currency        text NOT NULL DEFAULT 'USD',
  note            text DEFAULT '',
  auto_notify     boolean NOT NULL DEFAULT false,
  notify_who      text DEFAULT 'them',
  notify_message  text DEFAULT '',
  active          boolean NOT NULL DEFAULT true,
  run_count       int NOT NULL DEFAULT 0,
  max_runs        int,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_recurring_user ON recurring_rules(user_id);
CREATE INDEX idx_recurring_next ON recurring_rules(next_run_at) WHERE active = true;


-- ──────────────────────────────────────────────────────────────────
-- 9. SCHEDULED REMINDERS
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE scheduled_reminders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id     uuid NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  next_send_at timestamptz NOT NULL,
  repeat_days  int NOT NULL DEFAULT 0,
  max_sends    int NOT NULL DEFAULT 1,
  sent_count   int NOT NULL DEFAULT 0,
  notify_who   text NOT NULL DEFAULT 'them',
  message      text NOT NULL DEFAULT '',
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sched_reminders_next ON scheduled_reminders(next_send_at) WHERE active = true;


-- ──────────────────────────────────────────────────────────────────
-- 10. NOTIFICATIONS
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           text NOT NULL,
  entry_id       uuid REFERENCES entries(id) ON DELETE CASCADE,
  contact_id     uuid REFERENCES contacts(id) ON DELETE SET NULL,
  share_token_id uuid REFERENCES share_tokens(id) ON DELETE SET NULL,
  title          text DEFAULT '',
  message        text NOT NULL,
  contact_name   text DEFAULT '',
  amount         bigint,
  currency       text DEFAULT 'USD',
  channel        text NOT NULL DEFAULT 'in-app',
  sent_to        text[] DEFAULT '{}',
  notify_who     text DEFAULT '',
  read           boolean NOT NULL DEFAULT false,
  read_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifs_user ON notifications(user_id);
CREATE INDEX idx_notifs_unread ON notifications(user_id) WHERE read = false;
CREATE INDEX idx_notifs_created ON notifications(user_id, created_at DESC);


-- ──────────────────────────────────────────────────────────────────
-- 11. GROUPS
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE groups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text DEFAULT '',
  amount       bigint NOT NULL DEFAULT 0,
  currency     text NOT NULL DEFAULT 'USD',
  frequency    text DEFAULT 'monthly',
  use_rotation boolean NOT NULL DEFAULT false,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_groups_user ON groups(user_id);


-- ──────────────────────────────────────────────────────────────────
-- 12. GROUP MEMBERS
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE group_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  name       text NOT NULL,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','pending','removed')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(group_id, user_id)
);

CREATE INDEX idx_gmembers_group ON group_members(group_id);
CREATE INDEX idx_gmembers_user ON group_members(user_id);


-- ──────────────────────────────────────────────────────────────────
-- 13. GROUP ROUNDS
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE group_rounds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  round_number int NOT NULL,
  collector_id uuid REFERENCES group_members(id),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_grounds_group ON group_rounds(group_id);


-- ──────────────────────────────────────────────────────────────────
-- 14. GROUP CONTRIBUTIONS
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE group_contributions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id   uuid NOT NULL REFERENCES group_rounds(id) ON DELETE CASCADE,
  member_id  uuid NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
  amount     bigint NOT NULL DEFAULT 0,
  paid       boolean NOT NULL DEFAULT false,
  paid_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_gcontrib_round ON group_contributions(round_id);


-- ──────────────────────────────────────────────────────────────────
-- 15. INVESTMENTS
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE investments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text DEFAULT '',
  type            text DEFAULT 'general' CHECK (type IN ('general','stocks','realestate','business','crypto','other')),
  venture_type    text NOT NULL DEFAULT 'personal' CHECK (venture_type IN ('personal','shared')),
  access_mode     text NOT NULL DEFAULT 'private' CHECK (access_mode IN ('private','members_only','members_invite')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','matured','closed','lost')),
  initial_amount  bigint NOT NULL DEFAULT 0,
  currency        text NOT NULL DEFAULT 'USD',
  expected_return numeric(5,2),
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_investments_user ON investments(user_id);


-- ──────────────────────────────────────────────────────────────────
-- 16. INVESTMENT MEMBERS
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE investment_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id uuid NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  contact_id    uuid REFERENCES contacts(id) ON DELETE SET NULL,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  name          text NOT NULL,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE(investment_id, user_id)
);

CREATE INDEX idx_imembers_investment ON investment_members(investment_id);


-- ──────────────────────────────────────────────────────────────────
-- 17. INVESTMENT TRANSACTIONS
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE investment_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id uuid NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN (
    'deposit','withdrawal','dividend','return',
    'capital_contribution','expense','revenue','profit_distribution','adjustment'
  )),
  amount        bigint NOT NULL,
  note          text DEFAULT '',
  recorded_by   uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_itx_investment ON investment_transactions(investment_id);


-- ──────────────────────────────────────────────────────────────────
-- 18. NOTICE BOARD
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE notice_board (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      uuid REFERENCES groups(id) ON DELETE CASCADE,
  investment_id uuid REFERENCES investments(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  user_name     text NOT NULL,
  message       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT one_parent CHECK (
    (group_id IS NOT NULL AND investment_id IS NULL) OR
    (group_id IS NULL AND investment_id IS NOT NULL)
  )
);

CREATE INDEX idx_noticeboard_group ON notice_board(group_id);
CREATE INDEX idx_noticeboard_investment ON notice_board(investment_id);


-- ──────────────────────────────────────────────────────────────────
-- 19. NOK TRUSTEES (Trusted Access)
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE nok_trustees (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trustee_name      text NOT NULL,
  trustee_email     text NOT NULL,
  relationship      text DEFAULT '',
  access_level      text NOT NULL DEFAULT 'readonly' CHECK (access_level IN ('readonly','full','custom')),
  release_type      text NOT NULL DEFAULT 'manual' CHECK (release_type IN ('manual','inactivity','death','custom')),
  inactivity_days   int DEFAULT 90,
  verified          boolean NOT NULL DEFAULT false,
  verified_at       timestamptz,
  verification_code text,
  activated         boolean NOT NULL DEFAULT false,
  activated_at      timestamptz,
  activation_reason text DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_nok_user ON nok_trustees(user_id);


-- ──────────────────────────────────────────────────────────────────
-- 20. EMAIL LOG
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE email_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         text NOT NULL,
  recipient    text NOT NULL,
  subject      text DEFAULT '',
  status       text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed','bounced')),
  error        text DEFAULT '',
  entry_id     uuid REFERENCES entries(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_log_user ON email_log(user_id, created_at DESC);


-- ──────────────────────────────────────────────────────────────────
-- 21. AUDIT LOG
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action      text NOT NULL,
  entity_type text,
  entity_id   uuid,
  details     jsonb DEFAULT '{}',
  ip_address  text DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_user ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);


-- ══════════════════════════════════════════════════════════════════
-- COMPUTED VIEWS
-- ══════════════════════════════════════════════════════════════════

-- Ledger summary per contact
CREATE OR REPLACE VIEW ledger_summary AS
SELECT
  e.user_id,
  e.contact_id,
  c.name AS contact_name,
  c.start_toy,
  c.start_yot,
  c.start_toy + COALESCE(SUM(CASE
    WHEN e.tx_type IN ('they_owe_you','invoice','bill')
    AND e.status NOT IN ('voided','cancelled')
    AND NOT e.no_ledger
    THEN e.amount ELSE 0 END), 0)
  - COALESCE(SUM(CASE
    WHEN e.tx_type = 'they_paid_you'
    AND e.status NOT IN ('voided','cancelled')
    AND NOT e.no_ledger
    THEN e.amount ELSE 0 END), 0) AS they_owe_me,
  c.start_yot + COALESCE(SUM(CASE
    WHEN e.tx_type = 'you_owe_them'
    AND e.status NOT IN ('voided','cancelled')
    AND NOT e.no_ledger
    THEN e.amount ELSE 0 END), 0)
  - COALESCE(SUM(CASE
    WHEN e.tx_type = 'you_paid_them'
    AND e.status NOT IN ('voided','cancelled')
    AND NOT e.no_ledger
    THEN e.amount ELSE 0 END), 0) AS i_owe_them
FROM entries e
JOIN contacts c ON c.id = e.contact_id
WHERE e.archived_at IS NULL
GROUP BY e.user_id, e.contact_id, c.name, c.start_toy, c.start_yot;

-- Dashboard totals
CREATE OR REPLACE VIEW dashboard_totals AS
SELECT
  user_id,
  SUM(GREATEST(they_owe_me, 0)) AS total_they_owe_me,
  SUM(GREATEST(i_owe_them, 0)) AS total_i_owe_them,
  SUM(they_owe_me - i_owe_them) AS total_net
FROM ledger_summary
GROUP BY user_id;

-- Investment summary
CREATE OR REPLACE VIEW investment_summary AS
SELECT
  i.id AS investment_id,
  i.user_id,
  i.name,
  i.initial_amount,
  COALESCE(SUM(CASE WHEN t.type IN ('deposit','capital_contribution') THEN t.amount ELSE 0 END), 0) AS total_deposits,
  COALESCE(SUM(CASE WHEN t.type IN ('withdrawal','profit_distribution') THEN t.amount ELSE 0 END), 0) AS total_withdrawals,
  COALESCE(SUM(CASE WHEN t.type IN ('dividend','return','revenue') THEN t.amount ELSE 0 END), 0) AS total_returns,
  COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) AS total_expenses
FROM investments i
LEFT JOIN investment_transactions t ON t.investment_id = i.id
WHERE i.archived_at IS NULL
GROUP BY i.id, i.user_id, i.name, i.initial_amount;


-- ══════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE entry_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE investments ENABLE ROW LEVEL SECURITY;
ALTER TABLE investment_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE investment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notice_board ENABLE ROW LEVEL SECURITY;
ALTER TABLE nok_trustees ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Users: read own + admin reads all
CREATE POLICY users_own ON users FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY users_admin ON users FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'platform_admin'));
CREATE POLICY users_update ON users FOR UPDATE TO authenticated USING (auth.uid() = id);

-- Contacts: own only
CREATE POLICY contacts_all ON contacts FOR ALL TO authenticated USING (auth.uid() = user_id);

-- Entries: own + shared with me
CREATE POLICY entries_select ON entries FOR SELECT TO authenticated USING (
  auth.uid() = user_id OR
  id IN (SELECT entry_id FROM share_tokens WHERE recipient_id = auth.uid() AND status = 'confirmed')
);
CREATE POLICY entries_insert ON entries FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY entries_update ON entries FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY entries_delete ON entries FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Attachments: entry owner
CREATE POLICY attachments_select ON entry_attachments FOR SELECT TO authenticated USING (
  entry_id IN (SELECT id FROM entries WHERE user_id = auth.uid())
);
CREATE POLICY attachments_insert ON entry_attachments FOR INSERT TO authenticated WITH CHECK (auth.uid() = uploaded_by);

-- Settlements: entry owner or recorder
CREATE POLICY settlements_select ON settlements FOR SELECT TO authenticated USING (
  recorded_by = auth.uid() OR
  entry_id IN (SELECT id FROM entries WHERE user_id = auth.uid())
);
CREATE POLICY settlements_insert ON settlements FOR INSERT TO authenticated WITH CHECK (auth.uid() = recorded_by);
CREATE POLICY settlements_update ON settlements FOR UPDATE TO authenticated USING (
  entry_id IN (SELECT id FROM entries WHERE user_id = auth.uid())
);

-- Share tokens: sender or recipient
CREATE POLICY shares_select ON share_tokens FOR SELECT TO authenticated USING (
  sender_id = auth.uid() OR recipient_id = auth.uid()
);
CREATE POLICY shares_insert ON share_tokens FOR INSERT TO authenticated WITH CHECK (auth.uid() = sender_id);
CREATE POLICY shares_update ON share_tokens FOR UPDATE TO authenticated USING (
  sender_id = auth.uid() OR recipient_id = auth.uid()
);

-- Templates: own + public readable
CREATE POLICY templates_select ON templates FOR SELECT TO authenticated USING (
  user_id = auth.uid() OR is_public = true
);
CREATE POLICY templates_modify ON templates FOR ALL TO authenticated USING (auth.uid() = user_id);

-- Recurring: own only
CREATE POLICY recurring_all ON recurring_rules FOR ALL TO authenticated USING (auth.uid() = user_id);

-- Scheduled reminders: own only
CREATE POLICY sched_rem_all ON scheduled_reminders FOR ALL TO authenticated USING (auth.uid() = user_id);

-- Notifications: own only
CREATE POLICY notifs_all ON notifications FOR ALL TO authenticated USING (auth.uid() = user_id);

-- Groups: own or member
CREATE POLICY groups_select ON groups FOR SELECT TO authenticated USING (
  user_id = auth.uid() OR
  id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND status = 'active')
);
CREATE POLICY groups_insert ON groups FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY groups_update ON groups FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY groups_delete ON groups FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Group members: group owner/admin or self
CREATE POLICY gmembers_select ON group_members FOR SELECT TO authenticated USING (
  user_id = auth.uid() OR
  group_id IN (SELECT id FROM groups WHERE user_id = auth.uid()) OR
  group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
);
CREATE POLICY gmembers_insert ON group_members FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY gmembers_update ON group_members FOR UPDATE TO authenticated USING (
  user_id = auth.uid() OR
  group_id IN (SELECT id FROM groups WHERE user_id = auth.uid())
);
CREATE POLICY gmembers_delete ON group_members FOR DELETE TO authenticated USING (
  user_id = auth.uid() OR
  group_id IN (SELECT id FROM groups WHERE user_id = auth.uid())
);

-- Group rounds/contributions: group members
CREATE POLICY grounds_select ON group_rounds FOR SELECT TO authenticated USING (
  group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
);
CREATE POLICY grounds_insert ON group_rounds FOR INSERT TO authenticated WITH CHECK (
  group_id IN (SELECT id FROM groups WHERE user_id = auth.uid())
);
CREATE POLICY gcontrib_select ON group_contributions FOR SELECT TO authenticated USING (
  round_id IN (SELECT id FROM group_rounds WHERE group_id IN
    (SELECT group_id FROM group_members WHERE user_id = auth.uid()))
);
CREATE POLICY gcontrib_modify ON group_contributions FOR ALL TO authenticated USING (
  round_id IN (SELECT id FROM group_rounds WHERE group_id IN
    (SELECT id FROM groups WHERE user_id = auth.uid()))
);

-- Investments: own or member
CREATE POLICY investments_select ON investments FOR SELECT TO authenticated USING (
  user_id = auth.uid() OR
  id IN (SELECT investment_id FROM investment_members WHERE user_id = auth.uid())
);
CREATE POLICY investments_modify ON investments FOR ALL TO authenticated USING (auth.uid() = user_id);

-- Investment members/transactions: investment owner or member
CREATE POLICY imembers_select ON investment_members FOR SELECT TO authenticated USING (
  user_id = auth.uid() OR
  investment_id IN (SELECT id FROM investments WHERE user_id = auth.uid())
);
CREATE POLICY imembers_modify ON investment_members FOR ALL TO authenticated USING (
  investment_id IN (SELECT id FROM investments WHERE user_id = auth.uid())
);
CREATE POLICY itx_select ON investment_transactions FOR SELECT TO authenticated USING (
  investment_id IN (SELECT id FROM investments WHERE user_id = auth.uid()) OR
  investment_id IN (SELECT investment_id FROM investment_members WHERE user_id = auth.uid())
);
CREATE POLICY itx_insert ON investment_transactions FOR INSERT TO authenticated WITH CHECK (auth.uid() = recorded_by);

-- Notice board: group/investment member
CREATE POLICY noticeboard_select ON notice_board FOR SELECT TO authenticated USING (
  (group_id IS NOT NULL AND group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())) OR
  (investment_id IS NOT NULL AND (
    investment_id IN (SELECT id FROM investments WHERE user_id = auth.uid()) OR
    investment_id IN (SELECT investment_id FROM investment_members WHERE user_id = auth.uid())
  ))
);
CREATE POLICY noticeboard_insert ON notice_board FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- NOK: own only
CREATE POLICY nok_all ON nok_trustees FOR ALL TO authenticated USING (auth.uid() = user_id);

-- Email log: own only
CREATE POLICY email_log_all ON email_log FOR ALL TO authenticated USING (auth.uid() = user_id);

-- Audit log: own only + admin reads all
CREATE POLICY audit_own ON audit_log FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY audit_admin ON audit_log FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'platform_admin'));
CREATE POLICY audit_insert ON audit_log FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);


-- ══════════════════════════════════════════════════════════════════
-- STORAGE BUCKETS (run separately in Supabase Dashboard → Storage)
-- ══════════════════════════════════════════════════════════════════
-- Create these buckets manually in the dashboard:
-- 1. "documents" — receipts, invoices, BOLs, proof of payment
-- 2. "avatars" — profile photos and company logos
-- Set both to private (authenticated access only)
