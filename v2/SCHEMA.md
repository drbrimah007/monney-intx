# Money IntX v2 — Database Schema

## Design Principles

1. Every entity is a row in a table — never a JSON blob
2. State machines are explicit (enum columns with defined transitions)
3. Permissions are row-level (Postgres RLS)
4. Files go in storage, metadata goes in tables
5. Audit trail is automatic (triggers on key tables)
6. All monetary amounts stored as `bigint` (cents) to avoid floating point errors
7. All timestamps are `timestamptz` (UTC)
8. UUIDs for all primary keys
9. Soft delete where needed (`archived_at` column, not physical delete)

---

## State Machines

### Entry Status
```
draft → posted → sent → viewed → accepted → partially_settled → settled
                                           → disputed
                                           → overdue
                                → rejected
posted → voided (terminal)
any → cancelled (terminal)
```

### Invoice Status
```
draft → offered → sent → viewed → due → partially_settled → settled → fulfilled
                                      → overdue
offered → voided (terminal)
any → cancelled (terminal)
```

### Membership Status
```
invited → pending → active → removed
                  → rejected
none → requested → accepted (→ active)
                 → rejected
```

### Share Status
```
created → sent → viewed → confirmed → tracked
                        → dismissed
                        → expired
```

### Notification Status
```
created → delivered → read → archived
```

---

## Tables

### 1. users

Core identity. Extends Supabase `auth.users`.

```sql
CREATE TABLE users (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         text NOT NULL,
  display_name  text NOT NULL DEFAULT '',
  username      text UNIQUE,
  phone         text DEFAULT '',
  role          text NOT NULL DEFAULT 'standard' CHECK (role IN ('admin','standard','contact')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned')),
  avatar_url    text DEFAULT '',
  bio           text DEFAULT '',
  city          text DEFAULT '',
  company_name  text DEFAULT '',
  company_email text DEFAULT '',
  company_phone text DEFAULT '',
  company_address text DEFAULT '',
  timezone      text DEFAULT 'UTC',
  default_currency text NOT NULL DEFAULT 'USD',
  -- Verification
  verified_email  boolean NOT NULL DEFAULT false,
  verified_phone  boolean NOT NULL DEFAULT false,
  verified_id     boolean NOT NULL DEFAULT false,
  -- Branding (admin only)
  app_name      text DEFAULT 'Money IntX',
  tagline       text DEFAULT 'Making Money Matters Memorable',
  site_url      text DEFAULT '',
  logo_url      text DEFAULT '',
  -- Preferences
  notif_prefs   jsonb NOT NULL DEFAULT '{"inapp":true,"email":true,"sms":false}',
  discoverable  boolean NOT NULL DEFAULT true,
  -- Timestamps
  last_activity_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_role ON users(role);
```

---

### 2. contacts

A user's address book. Each user has their own contacts.

```sql
CREATE TABLE contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  email           text DEFAULT '',
  phone           text DEFAULT '',
  address         text DEFAULT '',
  notes           text DEFAULT '',
  tags            text[] DEFAULT '{}',
  -- Linking
  linked_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Ledger starting balances
  start_toy       bigint NOT NULL DEFAULT 0,  -- "they owe you" starting balance (cents)
  start_yot       bigint NOT NULL DEFAULT 0,  -- "you owe them" starting balance (cents)
  -- State
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_contacts_user ON contacts(user_id);
CREATE INDEX idx_contacts_linked ON contacts(linked_user_id);
CREATE INDEX idx_contacts_email ON contacts(user_id, email);
```

---

### 3. entries

The core transaction/record table. Every financial record is a row.

```sql
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
  -- Money (stored as cents to avoid float errors)
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
  -- Status
  status          text NOT NULL DEFAULT 'posted' CHECK (status IN (
    'draft','posted','sent','viewed','accepted',
    'partially_settled','settled','fulfilled',
    'overdue','disputed','voided','cancelled','closed'
  )),
  -- Template reference
  template_id     uuid REFERENCES templates(id) ON DELETE SET NULL,
  template_data   jsonb DEFAULT '{}',
  -- Sharing
  is_shared       boolean NOT NULL DEFAULT false,
  share_token     text,
  from_name       text DEFAULT '',
  from_email      text DEFAULT '',
  from_site_url   text DEFAULT '',
  sender_tx_type  text,  -- original sender's tx_type before flip
  -- Flags
  no_ledger       boolean NOT NULL DEFAULT false,
  is_receipt       boolean NOT NULL DEFAULT false,
  -- Reminder tracking
  reminder_count   int NOT NULL DEFAULT 0,
  last_reminder_at timestamptz,
  -- Fulfillment
  fulfilled_at     timestamptz,
  fulfillment_note text DEFAULT '',
  -- Soft delete
  archived_at     timestamptz,
  -- Timestamps
  last_activity_at timestamptz,
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
```

---

### 4. entry_attachments

Files attached to entries. Metadata here, files in storage.

```sql
CREATE TABLE entry_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    uuid NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  file_name   text NOT NULL,
  file_type   text NOT NULL,
  file_size   int NOT NULL,
  storage_path text NOT NULL,  -- path in Supabase Storage
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_attachments_entry ON entry_attachments(entry_id);
```

---

### 5. settlements

Each settlement payment against an entry is its own row.
No more patching amounts on the parent entry.

```sql
CREATE TABLE settlements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id        uuid NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  amount          bigint NOT NULL,  -- cents
  method          text DEFAULT '',  -- cash, bank, etc.
  note            text DEFAULT '',
  proof_url       text DEFAULT '',  -- storage path for receipt
  -- Who recorded it
  recorded_by     uuid NOT NULL REFERENCES users(id),
  -- Approval workflow
  status          text NOT NULL DEFAULT 'confirmed' CHECK (status IN (
    'pending','confirmed','rejected'
  )),
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  -- Timestamps
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_settlements_entry ON settlements(entry_id);
CREATE INDEX idx_settlements_status ON settlements(entry_id, status);

-- Trigger: after insert/update on settlements, recalculate entries.settled_amount
CREATE OR REPLACE FUNCTION update_entry_settled() RETURNS trigger AS $$
BEGIN
  UPDATE entries SET
    settled_amount = COALESCE((
      SELECT SUM(amount) FROM settlements
      WHERE entry_id = COALESCE(NEW.entry_id, OLD.entry_id)
      AND status = 'confirmed'
    ), 0),
    status = CASE
      WHEN COALESCE((
        SELECT SUM(amount) FROM settlements
        WHERE entry_id = COALESCE(NEW.entry_id, OLD.entry_id)
        AND status = 'confirmed'
      ), 0) >= amount THEN 'settled'
      WHEN COALESCE((
        SELECT SUM(amount) FROM settlements
        WHERE entry_id = COALESCE(NEW.entry_id, OLD.entry_id)
        AND status = 'confirmed'
      ), 0) > 0 THEN 'partially_settled'
      ELSE status
    END,
    updated_at = now()
  WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_settlement_update
AFTER INSERT OR UPDATE OR DELETE ON settlements
FOR EACH ROW EXECUTE FUNCTION update_entry_settled();
```

---

### 6. share_tokens

Tracks shared records between users. Replaces the current share_tokens table
with proper state management.

```sql
CREATE TABLE share_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token           text UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  -- Who shared and what
  sender_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id        uuid NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  -- Recipient
  recipient_email text DEFAULT '',
  recipient_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Snapshot of entry at share time
  entry_snapshot  jsonb NOT NULL DEFAULT '{}',
  -- State
  status          text NOT NULL DEFAULT 'created' CHECK (status IN (
    'created','sent','viewed','confirmed','dismissed','expired'
  )),
  confirmed_at    timestamptz,
  viewed_at       timestamptz,
  -- Timestamps
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz
);

CREATE INDEX idx_shares_sender ON share_tokens(sender_id);
CREATE INDEX idx_shares_recipient ON share_tokens(recipient_id);
CREATE INDEX idx_shares_entry ON share_tokens(entry_id);
CREATE INDEX idx_shares_token ON share_tokens(token);
CREATE INDEX idx_shares_status ON share_tokens(status);
```

---

### 7. templates

Reusable entry templates with field definitions.

```sql
CREATE TABLE templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text DEFAULT '',
  tx_type         text,
  -- Field definitions
  fields          jsonb NOT NULL DEFAULT '[]',
  -- Invoice numbering
  invoice_prefix  text DEFAULT 'INV-',
  invoice_next_num int NOT NULL DEFAULT 1,
  -- Public sharing
  is_public       boolean NOT NULL DEFAULT false,
  -- State
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_templates_user ON templates(user_id);
CREATE INDEX idx_templates_public ON templates(is_public) WHERE is_public = true;
```

---

### 8. recurring_rules

Scheduled recurring entries.

```sql
CREATE TABLE recurring_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  template_id     uuid REFERENCES templates(id) ON DELETE SET NULL,
  -- Schedule
  frequency       text NOT NULL CHECK (frequency IN ('daily','weekly','biweekly','monthly','quarterly','yearly','custom')),
  custom_days     int,
  next_run_at     timestamptz NOT NULL,
  last_run_at     timestamptz,
  -- Entry defaults
  tx_type         text NOT NULL,
  amount          bigint NOT NULL,
  currency        text NOT NULL DEFAULT 'USD',
  note            text DEFAULT '',
  -- Notification
  auto_notify     boolean NOT NULL DEFAULT false,
  notify_who      text DEFAULT 'them',
  notify_message  text DEFAULT '',
  -- State
  active          boolean NOT NULL DEFAULT true,
  run_count       int NOT NULL DEFAULT 0,
  max_runs        int DEFAULT NULL,  -- NULL = unlimited
  -- Timestamps
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_recurring_user ON recurring_rules(user_id);
CREATE INDEX idx_recurring_next ON recurring_rules(next_run_at) WHERE active = true;
```

---

### 9. scheduled_reminders

Timed/repeating reminder sends.

```sql
CREATE TABLE scheduled_reminders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id        uuid NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  -- Schedule
  next_send_at    timestamptz NOT NULL,
  repeat_days     int NOT NULL DEFAULT 0,  -- 0 = no repeat
  max_sends       int NOT NULL DEFAULT 1,
  sent_count      int NOT NULL DEFAULT 0,
  -- Content
  notify_who      text NOT NULL DEFAULT 'them',
  message         text NOT NULL DEFAULT '',
  -- State
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sched_reminders_next ON scheduled_reminders(next_send_at) WHERE active = true;
```

---

### 10. notifications

All in-app notifications. Each is a row, not stuffed in a blob.

```sql
CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Context
  type            text NOT NULL,  -- 'reminder','notification','viewed','confirmed','settlement_pending', etc.
  entry_id        uuid REFERENCES entries(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  share_token_id  uuid REFERENCES share_tokens(id) ON DELETE SET NULL,
  -- Content
  title           text DEFAULT '',
  message         text NOT NULL,
  -- Delivery
  channel         text NOT NULL DEFAULT 'in-app',  -- 'in-app','email','sms'
  sent_to         text[] DEFAULT '{}',
  -- State
  read            boolean NOT NULL DEFAULT false,
  read_at         timestamptz,
  -- Timestamps
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifs_user ON notifications(user_id);
CREATE INDEX idx_notifs_unread ON notifications(user_id, read) WHERE read = false;
CREATE INDEX idx_notifs_created ON notifications(user_id, created_at DESC);
```

---

### 11. groups

Group savings / contribution circles.

```sql
CREATE TABLE groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text DEFAULT '',
  -- Configuration
  amount          bigint NOT NULL DEFAULT 0,  -- contribution amount (cents)
  currency        text NOT NULL DEFAULT 'USD',
  frequency       text DEFAULT 'monthly',
  use_rotation    boolean NOT NULL DEFAULT false,
  -- State
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_groups_user ON groups(user_id);
```

---

### 12. group_members

```sql
CREATE TABLE group_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  contact_id  uuid REFERENCES contacts(id) ON DELETE SET NULL,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  name        text NOT NULL,
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','pending','removed')),
  joined_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_gmembers_group ON group_members(group_id);
CREATE INDEX idx_gmembers_user ON group_members(user_id);
```

---

### 13. group_rounds

Tracks each contribution round in a group.

```sql
CREATE TABLE group_rounds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  round_number    int NOT NULL,
  collector_id    uuid REFERENCES group_members(id),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_grounds_group ON group_rounds(group_id);
```

---

### 14. group_contributions

Individual contributions within a round.

```sql
CREATE TABLE group_contributions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id        uuid NOT NULL REFERENCES group_rounds(id) ON DELETE CASCADE,
  member_id       uuid NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
  amount          bigint NOT NULL DEFAULT 0,
  paid            boolean NOT NULL DEFAULT false,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_gcontrib_round ON group_contributions(round_id);
```

---

### 15. investments

Investment/venture tracking.

```sql
CREATE TABLE investments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text DEFAULT '',
  type            text DEFAULT 'general' CHECK (type IN ('general','stocks','realestate','business','crypto','other')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','matured','closed','lost')),
  initial_amount  bigint NOT NULL DEFAULT 0,
  currency        text NOT NULL DEFAULT 'USD',
  expected_return numeric(5,2),
  -- State
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_investments_user ON investments(user_id);
```

---

### 16. investment_members

```sql
CREATE TABLE investment_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id   uuid NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  name            text NOT NULL,
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  joined_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_imembers_investment ON investment_members(investment_id);
```

---

### 17. investment_transactions

```sql
CREATE TABLE investment_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id   uuid NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('deposit','withdrawal','dividend','return')),
  amount          bigint NOT NULL,
  note            text DEFAULT '',
  recorded_by     uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_itx_investment ON investment_transactions(investment_id);
```

---

### 18. notice_board

Comments/discussion on groups and investments.

```sql
CREATE TABLE notice_board (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Polymorphic: either group or investment
  group_id        uuid REFERENCES groups(id) ON DELETE CASCADE,
  investment_id   uuid REFERENCES investments(id) ON DELETE CASCADE,
  -- Content
  user_id         uuid NOT NULL REFERENCES users(id),
  user_name       text NOT NULL,
  message         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Constraint: must reference exactly one parent
  CONSTRAINT one_parent CHECK (
    (group_id IS NOT NULL AND investment_id IS NULL) OR
    (group_id IS NULL AND investment_id IS NOT NULL)
  )
);

CREATE INDEX idx_noticeboard_group ON notice_board(group_id);
CREATE INDEX idx_noticeboard_investment ON notice_board(investment_id);
```

---

### 19. nok_trustees (Next of Kin / Trusted Access)

```sql
CREATE TABLE nok_trustees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trustee_name    text NOT NULL,
  trustee_email   text NOT NULL,
  relationship    text DEFAULT '',
  access_level    text NOT NULL DEFAULT 'readonly' CHECK (access_level IN ('readonly','full','custom')),
  -- Activation
  release_type    text NOT NULL DEFAULT 'manual' CHECK (release_type IN ('manual','inactivity','death','custom')),
  inactivity_days int DEFAULT 90,
  -- Verification
  verified        boolean NOT NULL DEFAULT false,
  verified_at     timestamptz,
  verification_code text,
  -- State
  activated       boolean NOT NULL DEFAULT false,
  activated_at    timestamptz,
  activation_reason text DEFAULT '',
  -- Timestamps
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_nok_user ON nok_trustees(user_id);
```

---

### 20. email_log

Tracks all sent emails for debugging and audit.

```sql
CREATE TABLE email_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            text NOT NULL,  -- 'notification','reminder','invoice','reset', etc.
  recipient       text NOT NULL,
  subject         text DEFAULT '',
  status          text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed','bounced')),
  error           text DEFAULT '',
  entry_id        uuid REFERENCES entries(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_log_user ON email_log(user_id, created_at DESC);
```

---

### 21. audit_log

Automatic audit trail for key actions.

```sql
CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action      text NOT NULL,  -- 'add_entry','edit_entry','delete_entry','send_reminder', etc.
  entity_type text,           -- 'entry','contact','group','investment', etc.
  entity_id   uuid,
  details     jsonb DEFAULT '{}',
  ip_address  text DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_user ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
```

---

## Row Level Security (RLS) Policies

```sql
-- Enable RLS on all tables
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

-- Users: read own, update own
CREATE POLICY users_select ON users FOR SELECT USING (auth.uid() = id);
CREATE POLICY users_update ON users FOR UPDATE USING (auth.uid() = id);

-- Admin: read all users
CREATE POLICY users_admin_select ON users FOR SELECT
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

-- Contacts: own only
CREATE POLICY contacts_all ON contacts FOR ALL USING (auth.uid() = user_id);

-- Entries: own + shared with me
CREATE POLICY entries_select ON entries FOR SELECT USING (
  auth.uid() = user_id OR
  id IN (SELECT entry_id FROM share_tokens WHERE recipient_id = auth.uid() AND status = 'confirmed')
);
CREATE POLICY entries_insert ON entries FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY entries_update ON entries FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY entries_delete ON entries FOR DELETE USING (auth.uid() = user_id);

-- Settlements: entry owner or recorder
CREATE POLICY settlements_select ON settlements FOR SELECT USING (
  recorded_by = auth.uid() OR
  entry_id IN (SELECT id FROM entries WHERE user_id = auth.uid())
);
CREATE POLICY settlements_insert ON settlements FOR INSERT WITH CHECK (auth.uid() = recorded_by);

-- Share tokens: sender or recipient
CREATE POLICY shares_select ON share_tokens FOR SELECT USING (
  sender_id = auth.uid() OR recipient_id = auth.uid()
);
CREATE POLICY shares_insert ON share_tokens FOR INSERT WITH CHECK (auth.uid() = sender_id);
CREATE POLICY shares_update ON share_tokens FOR UPDATE USING (
  sender_id = auth.uid() OR recipient_id = auth.uid()
);

-- Templates: own + public readable
CREATE POLICY templates_select ON templates FOR SELECT USING (
  user_id = auth.uid() OR is_public = true
);
CREATE POLICY templates_modify ON templates FOR ALL USING (auth.uid() = user_id);

-- Notifications: own only
CREATE POLICY notifs_all ON notifications FOR ALL USING (auth.uid() = user_id);

-- Groups: own or member
CREATE POLICY groups_select ON groups FOR SELECT USING (
  user_id = auth.uid() OR
  id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND status = 'active')
);
CREATE POLICY groups_insert ON groups FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY groups_update ON groups FOR UPDATE USING (auth.uid() = user_id);

-- Group members: group owner or self
CREATE POLICY gmembers_select ON group_members FOR SELECT USING (
  group_id IN (SELECT id FROM groups WHERE user_id = auth.uid()) OR
  user_id = auth.uid()
);

-- Investments: same pattern as groups
CREATE POLICY investments_select ON investments FOR SELECT USING (
  user_id = auth.uid() OR
  id IN (SELECT investment_id FROM investment_members WHERE user_id = auth.uid())
);
CREATE POLICY investments_modify ON investments FOR ALL USING (auth.uid() = user_id);

-- Audit log: own only
CREATE POLICY audit_select ON audit_log FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (auth.uid() = user_id);
```

---

## Computed Views (for dashboard stats)

```sql
-- Ledger summary per contact
CREATE VIEW ledger_summary AS
SELECT
  e.user_id,
  e.contact_id,
  c.name AS contact_name,
  SUM(CASE WHEN e.tx_type IN ('they_owe_you','invoice','bill') AND e.status NOT IN ('voided','cancelled')
           AND NOT e.no_ledger THEN e.remaining ELSE 0 END) AS they_owe_me,
  SUM(CASE WHEN e.tx_type = 'you_owe_them' AND e.status NOT IN ('voided','cancelled')
           AND NOT e.no_ledger THEN e.remaining ELSE 0 END) AS i_owe_them,
  SUM(CASE WHEN e.tx_type IN ('they_owe_you','invoice','bill') AND e.status NOT IN ('voided','cancelled')
           AND NOT e.no_ledger THEN e.remaining ELSE 0 END) -
  SUM(CASE WHEN e.tx_type = 'you_owe_them' AND e.status NOT IN ('voided','cancelled')
           AND NOT e.no_ledger THEN e.remaining ELSE 0 END) AS net
FROM entries e
JOIN contacts c ON c.id = e.contact_id
WHERE e.archived_at IS NULL
GROUP BY e.user_id, e.contact_id, c.name;

-- Dashboard totals
CREATE VIEW dashboard_totals AS
SELECT
  user_id,
  COUNT(DISTINCT contact_id) FILTER (WHERE contact_id IS NOT NULL) AS contact_count,
  SUM(they_owe_me) AS total_they_owe_me,
  SUM(i_owe_them) AS total_i_owe_them,
  SUM(net) AS total_net
FROM ledger_summary
GROUP BY user_id;
```

---

## Migration Mapping (v1 blob → v2 tables)

| v1 blob field | v2 table | Notes |
|---|---|---|
| `db.users[]` | `users` | One row per user |
| `db.contacts[]` | `contacts` | user_id from parent blob |
| `db.entries[]` | `entries` | amount × 100 for cents |
| `db.entries[].responses[]` | `settlements` | Each response = settlement row |
| `db.templates[]` | `templates` | fields stays as jsonb |
| `db.recurring[]` | `recurring_rules` | |
| `db.notifs[]` | `notifications` | |
| `db.groups[]` | `groups` + `group_members` + `group_rounds` + `group_contributions` | Denormalize |
| `db.investments[]` | `investments` + `investment_members` + `investment_transactions` | Denormalize |
| `db.audit[]` | `audit_log` | |
| `db.emailLog[]` | `email_log` | |
| `db.settings` | `users` columns | Flatten into user row |
| `db.settings.logoData` | Supabase Storage | Upload, store URL |
| Entry attachments | `entry_attachments` + Storage | Upload, store path |

---

## What This Eliminates

Every issue from today's session:

| Issue | Why it happened | How v2 prevents it |
|---|---|---|
| Zombie entries after delete | Blob merge re-added them | `DELETE FROM entries` — row gone |
| Stale dashboard data | Blob overwrite race | Query always returns current rows |
| Notification spam | Status re-detection on blob reload | Status is one column, updated atomically |
| Cross-device conflicts | Last-write-wins blob | Each row updated independently |
| Entries growing on refresh | Migration re-created from tokens | No migration — entries are rows |
| Freshness polling needed | Can't detect blob changes | Supabase Realtime pushes changes |
| 10M user scaling | One blob per user = 10M JSON parses | Indexed queries in microseconds |
