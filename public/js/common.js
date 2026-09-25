/* Auto Repair Bids — shared frontend helpers */
'use strict';

// Shorthand: $('myid') → document.getElementById('myid')
function $(id) { return document.getElementById(id); }

// Where API calls go. "" = same origin (local dev: `npm start` on Windows).
// In the Capacitor native app the webview runs on capacitor://localhost, so
// API calls go to the hosted API URL (NATIVE_API_BASE in js/config.js).
function apiBase() {
  if (window.APP_CONFIG && window.APP_CONFIG.API_BASE) return window.APP_CONFIG.API_BASE;
  try {
    if (window.Capacitor && typeof window.Capacitor.getPlatform === 'function' &&
        window.Capacitor.getPlatform() !== 'web') {
      return window.NATIVE_API_BASE || '';
    }
  } catch (e) { /* not running inside a native webview */ }
  return '';
}

async function api(path, opts = {}) {
  const o = { headers: {}, credentials: 'include', ...opts };
  if (o.body && !(o.body instanceof FormData)) {
    o.headers['Content-Type'] = 'application/json';
    o.body = JSON.stringify(o.body);
  }
  // apiBase(): "" = same origin (local web dev). In the Capacitor native app
  // the webview is capacitor://localhost, so calls go to the hosted API URL
  // from js/config.js. credentials:'include' keeps the cookie session working
  // cross-origin in the native app; harmless same-origin.
  const r = await fetch(apiBase() + path, o);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !location.pathname.endsWith('login.html') && location.pathname !== '/') {
    location.href = '/login.html';
    throw new Error('login');
  }
  if (!r.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function showErr(msg) {
  const e = document.getElementById('err');
  if (!e) { alert(msg); return; }
  e.textContent = msg;
  e.classList.add('show');
  e.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function clearErr() {
  const e = document.getElementById('err');
  if (e) e.classList.remove('show');
}

// Redirect to the right home if already logged in; enforce role on guarded pages.
async function guard(role) {
  try {
    const me = await api('/api/me');
    if (!me.loggedIn) { location.href = '/login.html'; return null; }
    if (role && me.role !== role) {
      location.href = me.role === 'shop' ? '/shop/dashboard.html'
        : me.role === 'tow' ? '/tow/partner.html'
        : '/customer/home.html';
      return null;
    }
    return me;
  } catch (e) { location.href = '/login.html'; return null; }
}

function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso + 'Z').getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// "in about Xh Ym" until completed_at + hrs elapses; null if no completed_at
function autoCountdown(completedAt, hrs) {
  if (!completedAt) return null;
  const left = (new Date(completedAt + 'Z').getTime() + hrs * 36e5) - Date.now();
  if (left <= 0) return 'moments';
  const h = Math.floor(left / 36e5), m = Math.floor((left % 36e5) / 6e4);
  if (h >= 48) return Math.round(h / 24) + ' days';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

// Renders the job audit trail into #timeline (expects {request_id} fetchable
// at `/api/requests/${id}/timeline`). Shared by customer + shop.
async function renderTimeline(requestId) {
  const box = document.getElementById('timeline');
  if (!box) return;
  try {
    const t = await api('/api/requests/' + requestId + '/timeline');
    if (!t.events.length) { box.innerHTML = ''; return; }
    const label = {
      request_created: '📝 Request posted', bid_submitted: '💵 Bid submitted',
      bid_selected: '✅ Shop selected', terms_accepted: '📋 Terms accepted',
      payment_held: '💰 Payment held in escrow', addon_proposed: '➕ Add-on proposed',
      addon_approved: '✅ Add-on approved & paid', addon_rejected: '✕ Add-on declined',
      completion_marked: '🔧 Repair marked completed', completion_confirmed: '👍 Completion confirmed',
      problem_reported: '⚠️ Problem reported — disputed', payout_released: '💸 Payout released',
      auto_released: '⏱️ Payout auto-released', refunded: '↩ Refunded', cancelled: '✕ Cancelled',
      no_show_marked: '🚫 No-show reported',
      tow_requested: '🛻 Tow requested', tow_accepted: '🛻 Tow accepted — driver on the way',
      tow_completed: '🛻 Tow completed', tow_cancelled: '🛻 Tow cancelled',
      tow_offered: '📣 Tow offered to partner', tow_offer_expired: '⏱️ Tow offer expired',
      tow_offer_passed: '⏭️ Tow partner passed', tow_unassigned: '⚠️ Tow unassigned — needs attention'
    };
    box.innerHTML = '<div class="card"><h3 style="margin-top:0">🧾 Job history</h3>' +
      t.events.map(ev => `<div class="kv"><span class="k">${esc(label[ev.event] || ev.event)}<br>
        <span class="muted small">${esc(ev.created_at || '').replace(' ', ' · ')}</span></span>
        <span class="v small">${esc(ev.detail || '')}</span></div>`).join('') + '</div>';
  } catch (e) { /* timeline is nice-to-have */ }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Bottom navigation, injected on authed pages: bottomNav('customer'|'shop', 'home')
function bottomNav(role, active) {
  const items = role === 'shop'
    ? [['dashboard.html', '🏠', 'Home'], ['requests.html', '🧾', 'Requests'],
       ['bids.html', '💰', 'Bids'], ['dashboard.html#profile', '👤', 'Profile']]
    : [['home.html', '🏠', 'Home'], ['requests.html', '🧾', 'My Cars'],
       ['requests.html', '💬', 'Messages'], ['home.html#profile', '👤', 'Profile']];
  const nav = document.createElement('nav');
  nav.className = 'bottomnav';
  nav.innerHTML = items.map(([href, icon, label]) =>
    `<a href="/${role}/${href}" class="${href.split('#')[0] === active ? 'on' : ''}">
       <span class="ni">${icon}</span>${label}</a>`).join('');
  document.querySelector('.phone').appendChild(nav);
}

function stars(rating) {
  return '★ ' + Number(rating || 5).toFixed(1);
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  location.href = '/';
}
