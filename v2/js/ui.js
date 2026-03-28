// Money IntX v2 — UI Helpers
// Shared utilities used across all pages

// ── Escape HTML ───────────────────────────────────────────────────
export function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// ── Toast notifications ───────────────────────────────────────────
export function toast(msg, type = 'info', duration = 3000) {
  const el = document.createElement('div');
  const colors = {
    info: 'background:#1a1a2e;color:#fff;',
    success: 'background:#16a34a;color:#fff;',
    error: 'background:#dc2626;color:#fff;',
    warning: 'background:#d97706;color:#fff;'
  };
  el.style.cssText = `
    position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
    ${colors[type] || colors.info}
    padding:12px 24px;border-radius:12px;font-size:14px;font-weight:500;
    box-shadow:0 8px 24px rgba(0,0,0,0.15);z-index:9999;
    animation:slideUp 0.25s ease;max-width:90vw;text-align:center;
  `;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ── Navigation ────────────────────────────────────────────────────
let _currentPage = 'landing';
const _pageHandlers = {};

export function registerPage(name, handler) {
  _pageHandlers[name] = handler;
}

export function navigate(page, params = {}) {
  _currentPage = page;
  if (_pageHandlers[page]) {
    _pageHandlers[page](params);
  }
  if (page !== 'landing') {
    history.replaceState(null, '', '#' + page);
  }
}

export function getCurrentPage() { return _currentPage; }

// ── Modal helpers ─────────────────────────────────────────────────
export function openModal(html, { maxWidth = '520px', id = 'modal' } = {}) {
  closeModal(id);
  const wrap = document.createElement('div');
  wrap.id = id;
  wrap.style.cssText = `
    position:fixed;inset:0;z-index:200;
    background:rgba(0,0,0,0.4);backdrop-filter:blur(4px);
    display:flex;align-items:center;justify-content:center;
    padding:20px;animation:fadeIn 0.2s ease;
  `;
  wrap.innerHTML = `
    <div style="background:var(--bg);border-radius:16px;padding:28px;
      max-width:${maxWidth};width:100%;max-height:90vh;overflow-y:auto;
      box-shadow:0 20px 40px rgba(0,0,0,0.15);animation:slideUp 0.25s ease;"
      onclick="event.stopPropagation()">
      ${html}
    </div>
  `;
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) closeModal(id);
  });
  document.body.appendChild(wrap);
  return wrap;
}

export function closeModal(id = 'modal') {
  document.getElementById(id)?.remove();
}

// ── Format helpers ────────────────────────────────────────────────
export function fmtDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString();
}

export function fmtRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + 'd ago';
  return fmtDate(ts);
}

// ── Status badge ──────────────────────────────────────────────────
const STATUS_COLORS = {
  draft:             { bg: 'rgba(107,114,128,.18)', color: '#9ca3af', border: 'rgba(107,114,128,.3)' },
  posted:            { bg: 'rgba(96,165,250,.14)',  color: '#60a5fa', border: 'rgba(96,165,250,.3)' },
  sent:              { bg: 'rgba(139,92,246,.16)',  color: '#a78bfa', border: 'rgba(139,92,246,.3)' },
  viewed:            { bg: 'rgba(167,139,250,.14)', color: '#c4b5fd', border: 'rgba(167,139,250,.28)' },
  accepted:          { bg: 'rgba(52,211,153,.14)',  color: '#34d399', border: 'rgba(52,211,153,.28)' },
  due:               { bg: 'rgba(251,191,36,.14)',  color: '#fbbf24', border: 'rgba(251,191,36,.3)' },
  partially_settled: { bg: 'rgba(251,191,36,.14)',  color: '#fbbf24', border: 'rgba(251,191,36,.3)' },
  settled:           { bg: 'rgba(74,222,128,.14)',  color: '#4ade80', border: 'rgba(74,222,128,.28)' },
  fulfilled:         { bg: 'rgba(74,222,128,.14)',  color: '#4ade80', border: 'rgba(74,222,128,.28)' },
  overdue:           { bg: 'rgba(248,113,113,.14)', color: '#f87171', border: 'rgba(248,113,113,.3)' },
  disputed:          { bg: 'rgba(248,113,113,.14)', color: '#f87171', border: 'rgba(248,113,113,.3)' },
  voided:            { bg: 'rgba(107,114,128,.12)', color: '#6b7280', border: 'rgba(107,114,128,.22)' },
  cancelled:         { bg: 'rgba(107,114,128,.12)', color: '#6b7280', border: 'rgba(107,114,128,.22)' },
  closed:            { bg: 'rgba(107,114,128,.12)', color: '#6b7280', border: 'rgba(107,114,128,.22)' },
  payment:           { bg: 'rgba(52,211,153,.14)',  color: '#34d399', border: 'rgba(52,211,153,.28)' },
};

const STATUS_LABELS = {
  draft: 'Draft', posted: 'Posted', sent: 'Sent', viewed: 'Viewed',
  accepted: 'Accepted', due: 'Due', partially_settled: 'Partial',
  settled: 'Settled', fulfilled: 'Fulfilled', overdue: 'Overdue',
  disputed: 'Disputed', voided: 'Voided', cancelled: 'Cancelled',
  closed: 'Closed', payment: 'Payment'
};

export function statusBadge(status) {
  const s = STATUS_COLORS[status] || STATUS_COLORS.posted;
  const label = STATUS_LABELS[status] || status;
  return `<span style="display:inline-block;background:${s.bg};color:${s.color};border:1px solid ${s.border || s.bg};
    border-radius:8px;padding:3px 10px;font-size:11px;font-weight:700;
    text-transform:uppercase;letter-spacing:0.05em;">${esc(label)}</span>`;
}

// ── TX Category labels (ledger = past tense; canonical enums per handoff spec) ─
// Internal enums are permanent. UI copy may change.
export const TX_LABELS = {
  // ── New canonical categories (v2) ──────────────────────────────
  owed_to_me:        'Owed to Me',
  bill_sent:         'Bill Sent',
  invoice_sent:      'Invoice Sent',
  i_owe:             'I Owe',
  bill_received:     'Bill Received',
  invoice_received:  'Invoice Received',
  advance_paid:      'Advance Paid',
  advance_received:  'Advance Received',
  payment_recorded:  'Payment',
  // ── Legacy tx_type aliases (backward compat for un-migrated rows) ──
  they_owe_you:  'Owed to Me',
  you_owe_them:  'I Owe',
  they_paid_you: 'Payment',
  you_paid_them: 'Payment',
  invoice:       'Invoice Sent',
  bill:          'Bill Sent'
};

// UI tab labels (present tense, user-facing) — create actions
export const TX_CREATE_LABELS = {
  owed_to_me:       'They owe me',
  bill_sent:        'Send a bill',
  invoice_sent:     'Send an invoice',
  i_owe:            'I owe them',
  bill_received:    'Receive a bill',
  invoice_received: 'Receive an invoice',
  advance_paid:     'Pay in advance',
  advance_received: 'Receive advance payment'
};

export const TX_COLORS = {
  // Green = receivable / owed to me  (V1 dark theme --green: #4ade80)
  owed_to_me:       '#4ade80',
  invoice_sent:     '#4ade80',
  bill_sent:        '#4ade80',
  they_owe_you:     '#4ade80',
  they_paid_you:    '#4ade80',
  // Red = payable / I owe  (V1 dark theme --red: #f87171)
  i_owe:            '#f87171',
  invoice_received: '#f87171',
  bill_received:    '#f87171',
  you_owe_them:     '#f87171',
  you_paid_them:    '#f87171',
  // Purple = neutral invoice/bill  (V1 --accent #6c63ff, lightened for readability)
  invoice:          '#818cf8',
  bill:             '#818cf8',
  // Teal = payment recorded (neutral settlement)
  payment_recorded: '#2dd4bf',
  // Amber / sky for advances
  advance_paid:     '#fb923c',
  advance_received: '#60a5fa'
};

// Direction sign per category (canonical source of truth for new entries)
export const DIRECTION_SIGN = {
  owed_to_me:       1,
  bill_sent:        1,
  invoice_sent:     1,
  i_owe:           -1,
  bill_received:   -1,
  invoice_received:-1,
  advance_paid:    -1,
  advance_received: 1,
  payment_recorded: 0   // direction set from context
};
