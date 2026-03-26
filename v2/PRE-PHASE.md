# Money IntX v2 — Pre-Phase Definitions (LOCKED)

These are non-negotiable. All code must respect these definitions.

---

## 1. ROLES

| Role | Description | Permissions |
|------|-------------|-------------|
| **Owner** | Created the workspace/venture/group | Full CRUD, manage members, manage roles, delete |
| **Admin** | Elevated member | CRUD entries, manage members, cannot delete workspace |
| **Member** | Standard participant | View, create entries assigned to them, comment |
| **Viewer** | Read-only access | View only, no create/edit/delete |

Roles are per-workspace/group, not global. A user can be Owner of one group and Member of another.

Global roles: `platform_admin` (site-wide admin) and `user` (everyone else).

---

## 2. CORE STATE MACHINES

### Invoice States
```
draft → sent → viewed → due → partially_settled → settled → fulfilled
                             → overdue
       → cancelled (terminal from any non-settled state)
       → voided (terminal from any state)
```

### Entry States
```
draft → posted → sent → viewed → accepted → partially_settled → settled
                                           → disputed
       → voided (terminal)
       → cancelled (terminal)
```

### Membership States
```
invited → pending → active → removed
                  → rejected
(or)
none → requested → accepted (→ active)
                 → rejected
```

### Group Join States
```
not_joined → requested → accepted → joined
                       → rejected
not_joined → joined (free join mode, immediate)
joined → removed (by admin/owner)
joined → left (by self)
```

### Share States
```
created → sent → viewed → confirmed → tracked
                        → dismissed
                        → expired
```

---

## 3. MONEY ENTRY TYPES

| Type | Direction | Ledger Effect |
|------|-----------|---------------|
| **they_owe_you** | They owe me | +TOY (they owe you) |
| **you_owe_them** | I owe them | +YOT (you owe them) |
| **invoice** | Formal — they owe me | +TOY |
| **bill** | Formal — I owe them | +TOY |
| **they_paid_you** | They settled me | -TOY (credit) |
| **you_paid_them** | I settled them | -YOT (credit) |

### Venture/Investment Entry Types
| Type | Description |
|------|-------------|
| **capital_contribution** | Money put into the venture |
| **expense** | Money spent by the venture |
| **revenue** | Money earned by the venture |
| **profit_distribution** | Money paid out to members |
| **adjustment** | Correction entry |
| **withdrawal** | Money taken out |

---

## 4. DATA BOUNDARIES

### Database (Postgres tables)
- users / profiles
- contacts
- entries (money records)
- settlements
- invoices
- templates
- recurring rules
- scheduled reminders
- notifications
- groups + members + rounds + contributions
- investments + members + transactions
- share tokens
- audit log
- email log
- reports
- NOK/trusted access

### Storage (Supabase Storage / S3)
- Profile photos
- Company logos
- Receipt images
- Invoice PDFs
- Proof of payment files
- Document attachments
- BOLs (bills of lading)

### NEVER in storage
- Transaction state
- Ledger balances
- User permissions
- Workflow state
- Notification state
- Membership roles

---

## 5. MIGRATION MAPPING (v1 → v2)

### Transformation Rules

| v1 Source | v2 Target | Transform |
|-----------|-----------|-----------|
| `db.entries[].amount` | `entries.amount` | Multiply by 100 (dollars → cents as bigint) |
| `db.entries[].status` | `entries.status` | Map to valid enum value |
| `db.entries[].txType` | `entries.tx_type` | Direct map (camelCase → snake_case) |
| `db.entries[].isShared` | `entries.is_shared` | Boolean |
| `db.contacts[].startToy` | `contacts.start_toy` | Multiply by 100 |
| `db.contacts[].startYot` | `contacts.start_yot` | Multiply by 100 |
| `db.settings.logoData` | Upload to Storage | Store URL in `users.logo_url` |
| `db.entries[].attachments[]` | Upload to Storage | Store path in `entry_attachments` |
| `db.groups[].rounds[]` | `group_rounds` + `group_contributions` | Flatten nested arrays |
| `db.investments[].transactions[]` | `investment_transactions` | Flatten |
| `db.notifs[]` | `notifications` | Map type/msg fields |
| `db.audit[]` | `audit_log` | Map action/details |

### Cleanup Rules

1. **Duplicate entries**: Deduplicate by (user_id, contact_id, amount, date, tx_type)
2. **Orphan entries**: Entries with no valid contact_id → create placeholder contact
3. **Invalid statuses**: Map any unknown status to 'posted'
4. **Null amounts**: Skip or set to 0
5. **isShared entries without shareToken**: Mark as regular entries
6. **Zombie entries** (in _deletedEntryIds): Do NOT migrate
7. **Empty notifications**: Skip
8. **Base64 logo/attachments**: Upload to Storage, replace with URL

### Migration Order

1. Users (from auth.users + db.users)
2. Contacts (from db.contacts, per user)
3. Templates (from db.templates)
4. Entries (from db.entries, with amount conversion)
5. Settlements (from entry responses/settlement data)
6. Share tokens (from existing share_tokens table)
7. Groups → members → rounds → contributions
8. Investments → members → transactions
9. Notifications (from db.notifs)
10. Audit log (from db.audit)
11. Email log (from db.emailLog)
12. NOK trustees (from db.nok)
13. Attachments → Storage upload + entry_attachments rows

---

## 6. VENTURE TYPES (Phase 5)

| Type | Description | Features |
|------|-------------|----------|
| **Personal** | Solo business/investment tracking | Private ledger, notes, no members |
| **Shared** | Collaborative venture | Members, roles, notice board, shared ledger |

### Access Modes (Shared only)
| Mode | Description |
|------|-------------|
| **Private** | Owner + explicitly added members only |
| **Members Only** | Members can see, owner controls membership |
| **Members + Invite Link** | Anyone with link can request/join |

---

## 7. NON-NEGOTIABLE RULES

1. No structured data in blob/storage
2. All permissions enforced at DB level (RLS)
3. State transitions must be explicit (no implicit status changes)
4. UI must reflect real backend state (no local-only state)
5. Personal and shared flows must not conflict
6. Amounts stored as bigint (cents) — no floating point
7. Every table has created_at and appropriate indexes
8. Soft delete (archived_at) where users might want to recover
9. Hard delete only for truly transient data (old notifications)
10. Audit trail for all money-related operations
