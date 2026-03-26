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
  draft: { bg: '#f3f4f6', color: '#6b7280' },
  posted: { bg: '#dbeafe', color: '#1e40af' },
  sent: { bg: '#e0e7ff', color: '#4338ca' },
  viewed: { bg: '#ede9fe', color: '#6d28d9' },
  accepted: { bg: '#d1fae5', color: '#065f46' },
  due: { bg: '#fef3c7', color: '#92400e' },
  partially_settled: { bg: '#fef3c7', color: '#92400e' },
  settled: { bg: '#d1fae5', color: '#065f46' },
  fulfilled: { bg: '#d1fae5', color: '#065f46' },
  overdue: { bg: '#fee2e2', color: '#991b1b' },
  disputed: { bg: '#fee2e2', color: '#991b1b' },
  voided: { bg: '#f3f4f6', color: '#6b7280' },
  cancelled: { bg: '#f3f4f6', color: '#6b7280' },
  closed: { bg: '#f3f4f6', color: '#6b7280' },
  payment: { bg: '#d1fae5', color: '#065f46' },
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
  return `<span style="display:inline-block;background:${s.bg};color:${s.color};
    border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;
    text-transform:uppercase;letter-spacing:0.03em;">${esc(label)}</span>`;
}

// ── TX Type labels ────────────────────────────────────────────────
export const TX_LABELS = {
  they_owe_you: 'They Owe Me',
  you_owe_them: 'I Owe Them',
  they_paid_you: 'They Settled Me',
  you_paid_them: 'I Settled Them',
  invoice: 'Invoice',
  bill: 'Bill'
};

export const TX_COLORS = {
  they_owe_you: '#16a34a',
  you_owe_them: '#dc2626',
  they_paid_you: '#16a34a',
  you_paid_them: '#dc2626',
  invoice: '#6c63ff',
  bill: '#6c63ff'
};
