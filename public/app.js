/* E&E Job Scheduling — single-page app */
'use strict';

const $app = document.getElementById('app');

const state = {
  me: null,
  vapidPublicKey: null,
  users: [],
  venues: [],
  channels: [],
  notifications: [],
  authMode: 'login',
  weekStart: startOfWeek(new Date()),
  selectedDay: dateKey(new Date()),
  scheduleFilter: 'all', // 'all' | 'mine'
  shifts: [],
  chatChannel: null,
  chatMessages: [],
  es: null,
};

/* ------------------------------- utilities ------------------------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function initials(name) {
  return name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

function startOfWeek(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
  return x;
}

function dateKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtDay(iso) {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtWhen(iso) {
  const d = new Date(iso + (iso.endsWith('Z') || iso.includes('+') ? '' : 'Z'));
  const now = new Date();
  if (dateKey(d) === dateKey(now)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2600);
}

/* -------------------------------- routing -------------------------------- */

function route() {
  const hash = location.hash || '#/schedule';
  const [, view, arg] = hash.split('/');
  return { view: view || 'schedule', arg };
}

window.addEventListener('hashchange', () => render());

/* ------------------------------- realtime -------------------------------- */

function connectEvents() {
  if (state.es) state.es.close();
  const es = new EventSource('/api/events');
  state.es = es;
  es.addEventListener('message', (e) => {
    const { channel_id, message } = JSON.parse(e.data);
    if (state.chatChannel?.id === channel_id && route().view === 'chat') {
      state.chatMessages.push(message);
      renderChatMessages();
      api(`/api/channels/${channel_id}/messages`).catch(() => {}); // mark read
    }
    refreshChannels();
  });
  es.addEventListener('shifts', () => { if (route().view === 'schedule') loadShifts().then(render); });
  es.addEventListener('venues', () => refreshVenues());
  es.addEventListener('channels', () => refreshChannels());
  for (const [event, views] of Object.entries({
    time: ['clock', 'timesheets'], timeoff: ['timeoff'], tasks: ['tasks'], forms: ['forms'], posts: ['updates'],
  })) {
    es.addEventListener(event, () => { if (views.includes(route().view)) render(); });
  }
  es.addEventListener('notification', (e) => {
    const n = JSON.parse(e.data);
    state.notifications.unshift({ ...n, read: 0, created_at: new Date().toISOString() });
    toast(n.title);
    updateBadges();
  });
  es.onerror = () => { es.close(); setTimeout(connectEvents, 4000); };
}

async function refreshChannels() {
  try {
    const { channels } = await api('/api/channels');
    state.channels = channels;
    updateBadges();
    if (route().view === 'chat' && !route().arg) render();
  } catch {}
}

async function refreshVenues() {
  try {
    const { venues } = await api('/api/venues');
    state.venues = venues;
    if (route().view === 'venues') render();
  } catch {}
}

function unreadChatCount() {
  return state.channels.reduce((n, c) => n + (c.unread || 0), 0);
}

function unreadNotifCount() {
  return state.notifications.filter((n) => !n.read).length;
}

function updateBadges() {
  const chatBadge = document.querySelector('[data-tab="chat"] .tab-badge');
  const chatBtn = document.querySelector('[data-tab="chat"]');
  if (chatBtn) {
    const n = unreadChatCount();
    if (n && !chatBadge) chatBtn.insertAdjacentHTML('beforeend', `<span class="tab-badge">${n}</span>`);
    else if (n && chatBadge) chatBadge.textContent = n;
    else chatBadge?.remove();
  }
  const dot = document.querySelector('#notif-btn .badge-dot');
  const btn = document.querySelector('#notif-btn');
  if (btn) {
    if (unreadNotifCount() && !dot) btn.insertAdjacentHTML('beforeend', '<span class="badge-dot"></span>');
    else if (!unreadNotifCount()) dot?.remove();
  }
}

/* ----------------------------- push notifications ------------------------ */

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enablePush() {
  if (!pushSupported()) {
    const isIOS = /iPhone|iPad/.test(navigator.userAgent);
    toast(isIOS
      ? 'On iPhone: tap Share → “Add to Home Screen”, then open the app from your home screen and try again.'
      : 'Push is not supported in this browser.');
    return false;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notification permission was denied'); return false; }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(state.vapidPublicKey),
  });
  await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
  toast('Notifications enabled on this device ✅');
  return true;
}

async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
  toast('Notifications disabled on this device');
}

async function pushEnabled() {
  if (!pushSupported()) return false;
  if (Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.ready;
  return !!(await reg.pushManager.getSubscription());
}

/* --------------------------------- modal ---------------------------------- */

function openModal(html) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal">${html}</div>`;
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  document.body.appendChild(backdrop);
  return backdrop.querySelector('.modal');
}

function closeModal() {
  document.querySelector('.modal-backdrop')?.remove();
}

/* ------------------------------- auth views ------------------------------- */

function renderAuth() {
  const login = state.authMode === 'login';
  $app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-logo"><img src="/icons/icon-192.png" alt=""><h1>E&amp;E Job Scheduling</h1></div>
        <p class="auth-sub">${login ? 'Sign in to see your schedule and chat with your team.' : 'Create your account. The first account becomes the admin.'}</p>
        <form id="auth-form">
          ${login ? '' : `<label>Full name</label><input name="name" required autocomplete="name" placeholder="Jane Doe">`}
          <label>Email</label><input name="email" type="email" required autocomplete="email" placeholder="you@company.com">
          <label>Password</label><input name="password" type="password" required minlength="6" autocomplete="${login ? 'current-password' : 'new-password'}" placeholder="••••••••">
          <div class="auth-error" id="auth-error"></div>
          <button class="btn" type="submit">${login ? 'Sign in' : 'Create account'}</button>
        </form>
        <div class="auth-switch">
          ${login ? "Don't have an account?" : 'Already have an account?'}
          <button id="auth-switch">${login ? 'Sign up' : 'Sign in'}</button>
        </div>
      </div>
    </div>`;
  document.getElementById('auth-switch').onclick = () => { state.authMode = login ? 'register' : 'login'; renderAuth(); };
  document.getElementById('auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const { user } = await api(`/api/auth/${login ? 'login' : 'register'}`, {
        method: 'POST',
        body: Object.fromEntries(fd.entries()),
      });
      state.me = user;
      await bootstrap();
    } catch (err) {
      document.getElementById('auth-error').textContent = err.message;
    }
  };
}

/* -------------------------------- app shell ------------------------------- */

const TABS = [
  { id: 'schedule', icon: '📅', label: 'Schedule' },
  { id: 'chat', icon: '💬', label: 'Chat' },
  { id: 'clock', icon: '⏱️', label: 'Clock' },
  { id: 'updates', icon: '📢', label: 'Updates' },
  { id: 'more', icon: '☰', label: 'More' },
];

// Views that live under the "More" hub still highlight the More tab.
const MORE_VIEWS = ['more', 'venues', 'team', 'tasks', 'timeoff', 'forms', 'timesheets', 'settings', 'notifications'];

function shell(title, contentHTML, { back = null, fab = null } = {}) {
  let { view } = route();
  if (MORE_VIEWS.includes(view)) view = 'more';
  $app.innerHTML = `
    ${back !== 'none' ? `
    <header class="topbar">
      ${back ? `<button class="icon-btn" id="back-btn">←</button>` : ''}
      <h2>${esc(title)}</h2>
      <button class="icon-btn" id="notif-btn">🔔</button>
    </header>` : ''}
    <div class="main" id="main">${contentHTML}</div>
    ${fab ? `<button class="fab" id="fab">＋</button>` : ''}
    <nav class="tabbar">
      ${TABS.map((t) => `
        <button data-tab="${t.id}" class="${view === t.id ? 'active' : ''}">
          <span class="tab-icon">${t.icon}</span>${t.label}
        </button>`).join('')}
    </nav>`;
  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { location.hash = `#/${b.dataset.tab}`; };
  });
  const backBtn = document.getElementById('back-btn');
  if (backBtn) backBtn.onclick = back;
  const notifBtn = document.getElementById('notif-btn');
  if (notifBtn) notifBtn.onclick = () => { location.hash = '#/notifications'; };
  updateBadges();
}

/* -------------------------------- schedule -------------------------------- */

async function loadShifts() {
  const from = new Date(state.weekStart);
  const to = new Date(state.weekStart); to.setDate(to.getDate() + 7);
  const { shifts } = await api(`/api/shifts?from=${from.toISOString()}&to=${to.toISOString()}${state.scheduleFilter === 'mine' ? '&mine=1' : ''}`);
  state.shifts = shifts;
}

function renderSchedule() {
  const days = [...Array(7)].map((_, i) => {
    const d = new Date(state.weekStart); d.setDate(d.getDate() + i);
    return d;
  });
  const byDay = {};
  for (const s of state.shifts) (byDay[dateKey(new Date(s.starts_at))] ||= []).push(s);
  const todayKey = dateKey(new Date());
  const dayShifts = byDay[state.selectedDay] || [];
  const isAdmin = state.me.role === 'admin';

  const rangeLabel = `${days[0].toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString([], { month: 'short', day: 'numeric' })}`;

  shell('Schedule', `
    <div class="week-nav">
      <button class="icon-btn" id="prev-week">‹</button>
      <div class="range">${rangeLabel}</div>
      <button class="icon-btn" id="next-week">›</button>
    </div>
    <div class="day-strip">
      ${days.map((d) => {
        const k = dateKey(d);
        return `<button data-day="${k}" class="${k === state.selectedDay ? 'active' : ''} ${k === todayKey ? 'today' : ''}">
          ${d.toLocaleDateString([], { weekday: 'narrow' })}<span class="num">${d.getDate()}</span>
          ${byDay[k]?.length ? '<span class="dot"></span>' : '<span style="height:5px"></span>'}
        </button>`;
      }).join('')}
    </div>
    <div class="filter-row">
      <button class="pill ${state.scheduleFilter === 'all' ? 'active' : ''}" data-filter="all">Everyone</button>
      <button class="pill ${state.scheduleFilter === 'mine' ? 'active' : ''}" data-filter="mine">My jobs</button>
    </div>
    ${dayShifts.length ? dayShifts.map(shiftCardHTML).join('') : `
      <div class="empty"><div class="big">🗓️</div>No jobs scheduled for this day${isAdmin ? '<br>Tap ＋ to add one' : ''}</div>`}
  `, { fab: isAdmin });

  document.getElementById('prev-week').onclick = () => { state.weekStart.setDate(state.weekStart.getDate() - 7); state.selectedDay = dateKey(state.weekStart); loadShifts().then(render); };
  document.getElementById('next-week').onclick = () => { state.weekStart.setDate(state.weekStart.getDate() + 7); state.selectedDay = dateKey(state.weekStart); loadShifts().then(render); };
  document.querySelectorAll('[data-day]').forEach((b) => { b.onclick = () => { state.selectedDay = b.dataset.day; render(); }; });
  document.querySelectorAll('[data-filter]').forEach((b) => { b.onclick = () => { state.scheduleFilter = b.dataset.filter; loadShifts().then(render); }; });
  const fab = document.getElementById('fab');
  if (fab) fab.onclick = () => openShiftModal();
  document.querySelectorAll('[data-shift]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('[data-respond]')) return;
      const shift = state.shifts.find((s) => s.id === Number(el.dataset.shift));
      if (isAdmin) openShiftModal(shift); else openShiftDetail(shift);
    };
  });
  document.querySelectorAll('[data-respond]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/shifts/${b.dataset.shiftId}/respond`, { method: 'POST', body: { status: b.dataset.respond } });
      toast(b.dataset.respond === 'accepted' ? 'Job accepted ✅' : 'Job declined');
      loadShifts().then(render);
    };
  });
}

function shiftCardHTML(s) {
  const mine = s.assignees.find((a) => a.id === state.me.id);
  const statusIcon = { accepted: '✓ Accepted', declined: '✗ Declined', pending: '• Awaiting reply' };
  return `
    <div class="card shift-card" data-shift="${s.id}">
      <div class="shift-stripe" style="background:${esc(s.venue_color || '#4f46e5')}"></div>
      <div class="shift-body">
        <div class="shift-time">${fmtTime(s.starts_at)} – ${fmtTime(s.ends_at)}</div>
        <div class="shift-title">${esc(s.title)}</div>
        ${s.venue_name ? `<div class="shift-venue">📍 ${esc(s.venue_name)}${s.venue_address ? ` · ${esc(s.venue_address)}` : ''}</div>` : ''}
        ${s.notes ? `<div class="shift-notes">${esc(s.notes)}</div>` : ''}
        ${s.assignees.length ? `<div class="shift-people">
          ${s.assignees.map((a) => `<span class="chip ${a.status}">
            <span class="avatar" style="background:${esc(a.color)}">${esc(initials(a.name))}</span>
            ${esc(a.name)}<span class="st">${statusIcon[a.status] || ''}</span></span>`).join('')}
        </div>` : ''}
        ${mine && mine.status === 'pending' ? `
        <div class="shift-actions">
          <button class="btn small" data-respond="accepted" data-shift-id="${s.id}">Accept</button>
          <button class="btn small danger" data-respond="declined" data-shift-id="${s.id}">Decline</button>
        </div>` : ''}
      </div>
    </div>`;
}

function openShiftDetail(s) {
  openModal(`
    <h3>${esc(s.title)}</h3>
    <p class="sub">${fmtDay(s.starts_at)} · ${fmtTime(s.starts_at)} – ${fmtTime(s.ends_at)}</p>
    ${s.venue_name ? `<p class="sub" style="margin-top:8px">📍 ${esc(s.venue_name)}${s.venue_address ? `<br>${esc(s.venue_address)}` : ''}</p>` : ''}
    ${s.notes ? `<p style="margin-top:12px;white-space:pre-wrap">${esc(s.notes)}</p>` : ''}
    <div class="actions"><button class="btn secondary" onclick="document.querySelector('.modal-backdrop').remove()">Close</button></div>
  `);
}

function openShiftModal(shift = null) {
  const selected = new Set(shift ? shift.assignees.map((a) => a.id) : []);
  const day = shift ? dateKey(new Date(shift.starts_at)) : state.selectedDay;
  const startVal = shift ? toLocalInput(shift.starts_at) : `${day}T09:00`;
  const endVal = shift ? toLocalInput(shift.ends_at) : `${day}T17:00`;

  const modal = openModal(`
    <h3>${shift ? 'Edit job' : 'New job'}</h3>
    <form id="shift-form">
      <label>Job title</label><input name="title" required placeholder="e.g. Bar setup — wedding" value="${esc(shift?.title || '')}">
      <label>Venue</label>
      <select name="venue_id">
        <option value="">No venue</option>
        ${state.venues.map((v) => `<option value="${v.id}" ${shift?.venue_id === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}
      </select>
      <label>Starts</label><input name="starts_at" type="datetime-local" required value="${startVal}">
      <label>Ends</label><input name="ends_at" type="datetime-local" required value="${endVal}">
      <label>Notes</label><textarea name="notes" rows="2" placeholder="Instructions, dress code, contact…">${esc(shift?.notes || '')}</textarea>
      <label>Assign team members</label>
      <div class="assignee-list">
        ${state.users.map((u) => `
          <button type="button" class="opt ${selected.has(u.id) ? 'on' : ''}" data-user="${u.id}">
            <span class="avatar" style="background:${esc(u.color)}">${esc(initials(u.name))}</span>
            ${esc(u.name)}<span class="check">✓</span>
          </button>`).join('')}
      </div>
      <div class="actions">
        ${shift ? `<button type="button" class="btn danger" id="delete-shift">Delete</button>` : ''}
        <button type="submit" class="btn">${shift ? 'Save changes' : 'Create job'}</button>
      </div>
    </form>
  `);

  modal.querySelectorAll('[data-user]').forEach((b) => {
    b.onclick = () => {
      const id = Number(b.dataset.user);
      selected.has(id) ? selected.delete(id) : selected.add(id);
      b.classList.toggle('on');
    };
  });
  const del = modal.querySelector('#delete-shift');
  if (del) del.onclick = async () => {
    if (!confirm('Delete this job? Assigned team members will be notified.')) return;
    await api(`/api/shifts/${shift.id}`, { method: 'DELETE' });
    closeModal(); toast('Job deleted');
    loadShifts().then(render);
  };
  modal.querySelector('#shift-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      title: fd.get('title'),
      venue_id: fd.get('venue_id') ? Number(fd.get('venue_id')) : null,
      starts_at: new Date(fd.get('starts_at')).toISOString(),
      ends_at: new Date(fd.get('ends_at')).toISOString(),
      notes: fd.get('notes') || '',
      assignee_ids: [...selected],
    };
    try {
      await api(shift ? `/api/shifts/${shift.id}` : '/api/shifts', { method: shift ? 'PATCH' : 'POST', body });
      closeModal(); toast(shift ? 'Job updated — team notified' : 'Job created — team notified');
      loadShifts().then(render);
    } catch (err) { toast(err.message); }
  };
}

function toLocalInput(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------------------------------- chat ---------------------------------- */

async function renderChatList() {
  await refreshChannelsQuiet();
  const isAdmin = state.me.role === 'admin';
  shell('Chat', `
    ${state.channels.map((c) => `
      <button class="channel-row" data-channel="${c.id}">
        <span class="avatar lg" style="background:${c.kind === 'dm' ? '#0ea5e9' : 'var(--brand)'}">${c.kind === 'dm' ? esc(initials(c.name)) : '#'}</span>
        <span class="info">
          <div class="name">${esc(c.name)}</div>
          <div class="preview">${c.last_message ? `${esc(c.last_message.user_name || '')}: ${esc(c.last_message.body)}` : 'No messages yet'}</div>
        </span>
        <span class="meta">
          ${c.last_message ? `<div class="time">${fmtWhen(c.last_message.created_at)}</div>` : ''}
          ${c.unread ? `<span class="unread">${c.unread}</span>` : ''}
        </span>
      </button>`).join('')}
    <div class="section-title">Start a conversation</div>
    ${state.users.filter((u) => u.id !== state.me.id).map((u) => `
      <button class="channel-row" data-dm="${u.id}">
        <span class="avatar lg" style="background:${esc(u.color)}">${esc(initials(u.name))}</span>
        <span class="info"><div class="name">${esc(u.name)}</div><div class="preview">Send a direct message</div></span>
      </button>`).join('')}
  `, { fab: isAdmin });

  document.querySelectorAll('[data-channel]').forEach((b) => {
    b.onclick = () => { location.hash = `#/chat/${b.dataset.channel}`; };
  });
  document.querySelectorAll('[data-dm]').forEach((b) => {
    b.onclick = async () => {
      const { channel } = await api('/api/channels/dm', { method: 'POST', body: { user_id: Number(b.dataset.dm) } });
      state.channels = [channel, ...state.channels.filter((c) => c.id !== channel.id)];
      location.hash = `#/chat/${channel.id}`;
    };
  });
  const fab = document.getElementById('fab');
  if (fab) fab.onclick = openChannelModal;
}

async function refreshChannelsQuiet() {
  try { state.channels = (await api('/api/channels')).channels; } catch {}
}

function openChannelModal() {
  const selected = new Set();
  const modal = openModal(`
    <h3>New channel</h3>
    <form id="channel-form">
      <label>Channel name</label><input name="name" required placeholder="e.g. Bartenders">
      <label>Members</label>
      <div class="assignee-list">
        ${state.users.filter((u) => u.id !== state.me.id).map((u) => `
          <button type="button" class="opt" data-user="${u.id}">
            <span class="avatar" style="background:${esc(u.color)}">${esc(initials(u.name))}</span>
            ${esc(u.name)}<span class="check">✓</span>
          </button>`).join('')}
      </div>
      <div class="actions"><button type="submit" class="btn">Create channel</button></div>
    </form>
  `);
  modal.querySelectorAll('[data-user]').forEach((b) => {
    b.onclick = () => {
      const id = Number(b.dataset.user);
      selected.has(id) ? selected.delete(id) : selected.add(id);
      b.classList.toggle('on');
    };
  });
  modal.querySelector('#channel-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name');
    const { channel } = await api('/api/channels', { method: 'POST', body: { name, member_ids: [...selected] } });
    closeModal();
    location.hash = `#/chat/${channel.id}`;
  };
}

async function renderChat(channelId) {
  await refreshChannelsQuiet();
  const channel = state.channels.find((c) => c.id === Number(channelId));
  if (!channel) { location.hash = '#/chat'; return; }
  state.chatChannel = channel;
  const { messages } = await api(`/api/channels/${channel.id}/messages`);
  state.chatMessages = messages;

  $app.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" id="back-btn">←</button>
      <h2>${esc(channel.name)}</h2>
    </header>
    <div class="chat-screen">
      <div class="chat-msgs" id="chat-msgs"></div>
      <form class="chat-input" id="chat-form">
        <input id="chat-text" placeholder="Message ${esc(channel.name)}…" autocomplete="off">
        <button class="send" type="submit">➤</button>
      </form>
    </div>`;
  document.getElementById('back-btn').onclick = () => { location.hash = '#/chat'; };
  renderChatMessages();
  document.getElementById('chat-form').onsubmit = async (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-text');
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    try {
      const { message } = await api(`/api/channels/${channel.id}/messages`, { method: 'POST', body: { body } });
      if (!state.chatMessages.some((m) => m.id === message.id)) {
        state.chatMessages.push(message);
        renderChatMessages();
      }
    } catch (err) { toast(err.message); input.value = body; }
  };
}

function renderChatMessages() {
  const wrap = document.getElementById('chat-msgs');
  if (!wrap) return;
  let lastUser = null;
  wrap.innerHTML = state.chatMessages.map((m) => {
    const mine = m.user_id === state.me.id;
    const showWho = !mine && m.user_id !== lastUser;
    lastUser = m.user_id;
    return `<div class="msg ${mine ? 'mine' : 'theirs'}">
      ${showWho ? `<div class="who" style="color:${esc(m.user_color || '#666')}">${esc(m.user_name || 'Removed user')}</div>` : ''}
      <div class="bubble">${esc(m.body)}</div>
      <div class="when">${fmtWhen(m.created_at)}</div>
    </div>`;
  }).join('') || '<div class="empty"><div class="big">👋</div>Say hello to your team</div>';
  wrap.scrollTop = wrap.scrollHeight;
}

/* --------------------------------- venues --------------------------------- */

function renderVenues() {
  const isAdmin = state.me.role === 'admin';
  shell('Venues', `
    ${state.venues.length ? state.venues.map((v) => `
      <div class="card row" data-venue="${v.id}" ${isAdmin ? 'style="cursor:pointer"' : ''}>
        <span class="venue-icon" style="background:${esc(v.color)}">📍</span>
        <span class="grow">
          <div style="font-weight:700">${esc(v.name)}</div>
          ${v.address ? `<div class="sub">${esc(v.address)}</div>` : ''}
          ${v.notes ? `<div class="sub">${esc(v.notes)}</div>` : ''}
        </span>
        ${v.address ? `<button class="icon-btn" data-map="${encodeURIComponent(v.address)}" title="Open in Maps">🗺️</button>` : ''}
      </div>`).join('') : `
      <div class="empty"><div class="big">📍</div>No venues yet${isAdmin ? '<br>Tap ＋ to add your first venue' : ''}</div>`}
  `, { fab: isAdmin });

  document.querySelectorAll('[data-map]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); window.open(`https://maps.google.com/?q=${b.dataset.map}`, '_blank'); };
  });
  if (isAdmin) {
    document.querySelectorAll('[data-venue]').forEach((el) => {
      el.onclick = () => openVenueModal(state.venues.find((v) => v.id === Number(el.dataset.venue)));
    });
    document.getElementById('fab').onclick = () => openVenueModal();
  }
}

function openVenueModal(venue = null) {
  const colors = ['#0ea5e9', '#4f46e5', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777'];
  const modal = openModal(`
    <h3>${venue ? 'Edit venue' : 'New venue'}</h3>
    <form id="venue-form">
      <label>Name</label><input name="name" required placeholder="e.g. Riverside Hall" value="${esc(venue?.name || '')}">
      <label>Address</label><input name="address" placeholder="123 Main St, Springfield" value="${esc(venue?.address || '')}">
      <label>Notes</label><textarea name="notes" rows="2" placeholder="Parking, loading dock, site contact…">${esc(venue?.notes || '')}</textarea>
      <label>Color</label>
      <div style="display:flex;gap:8px">
        ${colors.map((c) => `<button type="button" data-color="${c}" style="width:34px;height:34px;border-radius:50%;background:${c};outline:${(venue?.color || colors[0]) === c ? '3px solid var(--text)' : 'none'};outline-offset:2px"></button>`).join('')}
      </div>
      <div class="actions">
        ${venue ? `<button type="button" class="btn danger" id="delete-venue">Delete</button>` : ''}
        <button type="submit" class="btn">${venue ? 'Save' : 'Add venue'}</button>
      </div>
    </form>
  `);
  let color = venue?.color || colors[0];
  modal.querySelectorAll('[data-color]').forEach((b) => {
    b.onclick = () => {
      color = b.dataset.color;
      modal.querySelectorAll('[data-color]').forEach((x) => { x.style.outline = 'none'; });
      b.style.outline = '3px solid var(--text)'; b.style.outlineOffset = '2px';
    };
  });
  const del = modal.querySelector('#delete-venue');
  if (del) del.onclick = async () => {
    if (!confirm('Delete this venue? Existing jobs keep their details.')) return;
    await api(`/api/venues/${venue.id}`, { method: 'DELETE' });
    closeModal(); refreshVenues();
  };
  modal.querySelector('#venue-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { name: fd.get('name'), address: fd.get('address'), notes: fd.get('notes'), color };
    try {
      await api(venue ? `/api/venues/${venue.id}` : '/api/venues', { method: venue ? 'PATCH' : 'POST', body });
      closeModal(); refreshVenues();
    } catch (err) { toast(err.message); }
  };
}

/* ---------------------------------- team ----------------------------------- */

function renderTeam() {
  const isAdmin = state.me.role === 'admin';
  shell('Team', `
    ${state.users.map((u) => `
      <div class="card row">
        <span class="avatar lg" style="background:${esc(u.color)}">${esc(initials(u.name))}</span>
        <span class="grow">
          <div style="font-weight:700">${esc(u.name)} ${u.id === state.me.id ? '<span class="sub">(you)</span>' : ''}</div>
          <div class="sub">${esc(u.email)}</div>
        </span>
        <span class="role-tag">${u.role}</span>
        ${isAdmin && u.hourly_rate ? `<span class="sub">$${Number(u.hourly_rate).toFixed(2)}/h</span>` : ''}
        ${isAdmin ? `<button class="icon-btn" data-edit-user="${u.id}" title="Edit">✏️</button>` : ''}
      </div>`).join('')}
    <div class="card">
      <div style="font-weight:700;margin-bottom:6px">Invite your team</div>
      <p class="hint">Share this app's link with your team — they sign up with their email and instantly appear here, in chat, and in the schedule.</p>
    </div>
  `);
  document.querySelectorAll('[data-edit-user]').forEach((b) => {
    b.onclick = () => openUserModal(state.users.find((u) => u.id === Number(b.dataset.editUser)));
  });
}

function openUserModal(user) {
  const isSelf = user.id === state.me.id;
  const modal = openModal(`
    <h3>${esc(user.name)}</h3>
    <p class="sub">${esc(user.email)}</p>
    <form id="user-form">
      <label>Role</label>
      <select name="role" ${isSelf ? 'disabled' : ''}>
        <option value="member" ${user.role === 'member' ? 'selected' : ''}>Member</option>
        <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin — manages jobs, venues, forms, payroll</option>
      </select>
      ${isSelf ? '<p class="hint">You cannot change your own role.</p>' : ''}
      <label>Hourly rate ($) — used for payroll export</label>
      <input name="hourly_rate" type="number" min="0" step="0.01" value="${Number(user.hourly_rate || 0).toFixed(2)}">
      <div class="actions"><button type="submit" class="btn">Save</button></div>
    </form>
  `);
  modal.querySelector('#user-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/api/users/${user.id}`, {
        method: 'PATCH',
        body: { role: isSelf ? user.role : fd.get('role'), hourly_rate: Number(fd.get('hourly_rate')) || 0 },
      });
      state.users = (await api('/api/users')).users;
      closeModal(); render();
    } catch (err) { toast(err.message); }
  };
}

/* ------------------------------ notifications ------------------------------ */

async function renderNotifications() {
  const { notifications } = await api('/api/notifications');
  state.notifications = notifications;
  shell('Notifications', `
    ${notifications.length ? notifications.map((n) => `
      <div class="card notif ${n.read ? '' : 'unread'}" data-notif-url="${esc(n.url)}">
        <div class="title">${esc(n.title)}</div>
        ${n.body ? `<div class="body">${esc(n.body)}</div>` : ''}
        <div class="when">${fmtWhen(n.created_at)}</div>
      </div>`).join('') : `
      <div class="empty"><div class="big">🔔</div>Nothing here yet.<br>Job assignments and updates will show up here.</div>`}
  `, { back: () => history.back() });
  document.querySelectorAll('[data-notif-url]').forEach((el) => {
    el.onclick = () => { location.href = el.dataset.notifUrl; };
  });
  if (notifications.some((n) => !n.read)) {
    api('/api/notifications/read', { method: 'POST' }).then(() => {
      state.notifications = state.notifications.map((n) => ({ ...n, read: 1 }));
      updateBadges();
    });
  }
}

/* -------------------------------- settings --------------------------------- */

async function renderSettings() {
  const enabled = await pushEnabled();
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const isIOS = /iPhone|iPad/.test(navigator.userAgent);
  shell('Settings', `
    <div class="card row">
      <span class="avatar lg" style="background:${esc(state.me.color)}">${esc(initials(state.me.name))}</span>
      <span class="grow">
        <div style="font-weight:700">${esc(state.me.name)}</div>
        <div class="sub">${esc(state.me.email)}</div>
      </span>
      <span class="role-tag">${state.me.role}</span>
    </div>

    <div class="section-title">Phone notifications</div>
    <div class="card">
      <div class="settings-row">
        <div>
          <div style="font-weight:700">Push notifications</div>
          <div class="sub">${enabled ? 'Enabled on this device' : 'Get job and chat alerts on this device'}</div>
        </div>
        <button class="btn small ${enabled ? 'secondary' : ''}" id="push-toggle">${enabled ? 'Disable' : 'Enable'}</button>
      </div>
      ${enabled ? `<div class="settings-row" style="margin-top:10px">
        <div class="sub">Send a test notification</div>
        <button class="btn small secondary" id="push-test">Test</button>
      </div>` : ''}
      ${isIOS && !standalone ? `<p class="hint">📱 <b>iPhone:</b> notifications require the app to be installed — tap the Share button in Safari, choose <b>“Add to Home Screen”</b>, then open E&amp;E Jobs from your home screen and enable notifications here.</p>` : ''}
      ${!isIOS && !standalone ? `<p class="hint">💡 Tip: use your browser's <b>“Install app” / “Add to Home Screen”</b> option to get the full app experience.</p>` : ''}
    </div>

    <div class="section-title">Account</div>
    <div class="card">
      <button class="btn danger" id="logout">Sign out</button>
    </div>
  `);
  document.getElementById('push-toggle').onclick = async () => {
    try { enabled ? await disablePush() : await enablePush(); } catch (err) { toast(err.message); }
    renderSettings();
  };
  const test = document.getElementById('push-test');
  if (test) test.onclick = () => api('/api/push/test', { method: 'POST' }).then(() => toast('Test sent — check your notifications'));
  document.getElementById('logout').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    state.es?.close();
    state.me = null;
    renderAuth();
  };
}

/* -------------------------------- time clock -------------------------------- */

function fmtDur(ms) {
  const mins = Math.floor(ms / 60000);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({});
    const timer = setTimeout(() => resolve({}), 4000);
    navigator.geolocation.getCurrentPosition(
      (pos) => { clearTimeout(timer); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
      () => { clearTimeout(timer); resolve({}); },
      { timeout: 3500, maximumAge: 60000 }
    );
  });
}

async function renderClock() {
  const [{ entry }, weekAgoEntries] = await Promise.all([
    api('/api/time/status'),
    (async () => {
      const from = new Date(startOfWeek(new Date())).toISOString();
      return (await api(`/api/time/entries?from=${from}`)).entries.filter((e) => e.user_id === state.me.id);
    })(),
  ]);
  const { shifts } = await api(`/api/shifts?from=${new Date(Date.now() - 12 * 3600000).toISOString()}&to=${new Date(Date.now() + 24 * 3600000).toISOString()}&mine=1`);

  const weekMs = weekAgoEntries.reduce((sum, e) => {
    const end = e.clock_out ? new Date(e.clock_out) : new Date();
    return sum + (end - new Date(e.clock_in));
  }, 0);

  shell('Time Clock', `
    <div class="card clock-card">
      <div class="clock-status">${entry ? '🟢 Clocked in' : '⚪ Clocked out'}</div>
      <div class="clock-timer" id="clock-timer">${entry ? fmtDur(Date.now() - new Date(entry.clock_in)) : '0h 00m'}</div>
      ${entry?.shift_title ? `<div class="sub" style="text-align:center">Working: ${esc(entry.shift_title)}</div>` : ''}
      ${entry ? `<div class="sub" style="text-align:center">Since ${fmtTime(entry.clock_in)}${entry.in_lat ? ' · 📍 location recorded' : ''}</div>` : ''}
      ${!entry && shifts.length ? `
        <label>Clock in for job (optional)</label>
        <select id="clock-shift">
          <option value="">General work</option>
          ${shifts.map((s) => `<option value="${s.id}">${esc(s.title)} (${fmtTime(s.starts_at)})</option>`).join('')}
        </select>` : ''}
      <button class="btn ${entry ? 'danger' : ''}" id="clock-btn" style="margin-top:16px">
        ${entry ? 'Clock out' : 'Clock in'}
      </button>
      <p class="hint" style="text-align:center">Your location is recorded at punch time if you allow it.</p>
    </div>

    <div class="section-title">This week · ${fmtDur(weekMs)} total</div>
    ${weekAgoEntries.length ? weekAgoEntries.map((e) => `
      <div class="card row">
        <span class="grow">
          <div style="font-weight:700">${fmtDay(e.clock_in)}</div>
          <div class="sub">${fmtTime(e.clock_in)} – ${e.clock_out ? fmtTime(e.clock_out) : 'now'}${e.shift_title ? ` · ${esc(e.shift_title)}` : ''}</div>
        </span>
        <span style="font-weight:700">${fmtDur((e.clock_out ? new Date(e.clock_out) : new Date()) - new Date(e.clock_in))}</span>
        ${e.approved ? '<span title="Approved">✅</span>' : ''}
      </div>`).join('') : '<div class="empty"><div class="big">⏱️</div>No punches yet this week</div>'}
    ${state.me.role === 'admin' ? `<button class="btn secondary" id="goto-timesheets" style="margin-top:8px">Open timesheets & payroll →</button>` : ''}
  `);

  if (entry) {
    state.timer = setInterval(() => {
      const el = document.getElementById('clock-timer');
      if (el) el.textContent = fmtDur(Date.now() - new Date(entry.clock_in));
      else clearInterval(state.timer);
    }, 30000);
  }
  document.getElementById('clock-btn').onclick = async (e) => {
    e.target.disabled = true;
    const loc = await getLocation();
    try {
      if (entry) {
        await api('/api/time/clock-out', { method: 'POST', body: loc });
        toast('Clocked out 👋');
      } else {
        const shiftSel = document.getElementById('clock-shift');
        await api('/api/time/clock-in', { method: 'POST', body: { ...loc, shift_id: shiftSel?.value ? Number(shiftSel.value) : null } });
        toast('Clocked in ✅');
      }
    } catch (err) { toast(err.message); }
    render();
  };
  const ts = document.getElementById('goto-timesheets');
  if (ts) ts.onclick = () => { location.hash = '#/timesheets'; };
}

/* -------------------------------- timesheets -------------------------------- */

function tsRange() {
  const from = new Date(state.tsWeekStart);
  const to = new Date(state.tsWeekStart); to.setDate(to.getDate() + 7);
  return { from, to };
}

async function renderTimesheets() {
  if (state.me.role !== 'admin') { location.hash = '#/clock'; return; }
  state.tsWeekStart ||= startOfWeek(new Date());
  const { from, to } = tsRange();
  const { entries } = await api(`/api/time/entries?from=${from.toISOString()}&to=${to.toISOString()}`);

  const byUser = new Map();
  for (const e of entries) {
    const u = byUser.get(e.user_id) || { name: e.user_name, color: e.user_color, rate: e.hourly_rate || 0, ms: 0, entries: [] };
    u.ms += (e.clock_out ? new Date(e.clock_out) : new Date()) - new Date(e.clock_in);
    u.entries.push(e);
    byUser.set(e.user_id, u);
  }

  const rangeLabel = `${from.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${new Date(to - 1).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;

  shell('Timesheets', `
    <div class="week-nav">
      <button class="icon-btn" id="ts-prev">‹</button>
      <div class="range">${rangeLabel}</div>
      <button class="icon-btn" id="ts-next">›</button>
    </div>
    ${byUser.size ? [...byUser.entries()].map(([uid, u]) => `
      <div class="card">
        <div class="row" style="margin-bottom:${u.entries.length ? '10px' : '0'}">
          <span class="avatar lg" style="background:${esc(u.color)}">${esc(initials(u.name))}</span>
          <span class="grow">
            <div style="font-weight:700">${esc(u.name)}</div>
            <div class="sub">${fmtDur(u.ms)} · $${u.rate.toFixed(2)}/h · <b>$${(u.ms / 3600000 * u.rate).toFixed(2)}</b></div>
          </span>
        </div>
        ${u.entries.map((e) => `
          <div class="row ts-entry" data-entry="${e.id}">
            <span class="grow sub">${fmtDay(e.clock_in)} · ${fmtTime(e.clock_in)} – ${e.clock_out ? fmtTime(e.clock_out) : 'open'}
              ${e.shift_title ? `· ${esc(e.shift_title)}` : ''}
              ${e.in_lat ? `<a href="https://maps.google.com/?q=${e.in_lat},${e.in_lng}" target="_blank" onclick="event.stopPropagation()">📍</a>` : ''}
            </span>
            <span style="font-weight:600;font-size:13px">${fmtDur((e.clock_out ? new Date(e.clock_out) : new Date()) - new Date(e.clock_in))}</span>
            <button class="icon-btn" data-approve="${e.id}" data-approved="${e.approved}" title="${e.approved ? 'Approved — tap to unapprove' : 'Tap to approve'}">${e.approved ? '✅' : '⬜'}</button>
          </div>`).join('')}
      </div>`).join('') : '<div class="empty"><div class="big">🧾</div>No time entries this week</div>'}
    <button class="btn" id="ts-export" style="margin-top:10px">⬇️ Export payroll CSV (${rangeLabel})</button>
    <p class="hint">Set each person's hourly rate in the Team screen. The CSV includes hours and pay per punch plus per-person totals.</p>
  `, { back: () => { location.hash = '#/more'; } });

  document.getElementById('ts-prev').onclick = () => { state.tsWeekStart.setDate(state.tsWeekStart.getDate() - 7); render(); };
  document.getElementById('ts-next').onclick = () => { state.tsWeekStart.setDate(state.tsWeekStart.getDate() + 7); render(); };
  document.getElementById('ts-export').onclick = () => {
    window.open(`/api/time/export?from=${from.toISOString()}&to=${to.toISOString()}`, '_blank');
  };
  document.querySelectorAll('[data-approve]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      await api(`/api/time/entries/${b.dataset.approve}`, { method: 'PATCH', body: { approved: b.dataset.approved !== '1' } });
      render();
    };
  });
  document.querySelectorAll('[data-entry]').forEach((el) => {
    el.onclick = () => {
      const entry = entries.find((x) => x.id === Number(el.dataset.entry));
      openTimeEntryModal(entry);
    };
  });
}

function openTimeEntryModal(entry) {
  const modal = openModal(`
    <h3>Edit time entry</h3>
    <p class="sub">${esc(entry.user_name)}</p>
    <form id="entry-form">
      <label>Clock in</label><input name="clock_in" type="datetime-local" required value="${toLocalInput(entry.clock_in)}">
      <label>Clock out</label><input name="clock_out" type="datetime-local" ${entry.clock_out ? `value="${toLocalInput(entry.clock_out)}"` : ''}>
      <div class="actions">
        <button type="button" class="btn danger" id="entry-delete">Delete</button>
        <button type="submit" class="btn">Save</button>
      </div>
    </form>
  `);
  modal.querySelector('#entry-delete').onclick = async () => {
    if (!confirm('Delete this time entry?')) return;
    await api(`/api/time/entries/${entry.id}`, { method: 'DELETE' });
    closeModal(); render();
  };
  modal.querySelector('#entry-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/api/time/entries/${entry.id}`, {
        method: 'PATCH',
        body: {
          clock_in: new Date(fd.get('clock_in')).toISOString(),
          clock_out: fd.get('clock_out') ? new Date(fd.get('clock_out')).toISOString() : null,
          approved: entry.approved,
        },
      });
      closeModal(); render();
    } catch (err) { toast(err.message); }
  };
}

/* --------------------------------- time off --------------------------------- */

const TIMEOFF_ICONS = { vacation: '🏖️', sick: '🤒', personal: '🏠', other: '📅' };

async function renderTimeoff() {
  const { requests } = await api('/api/timeoff');
  const isAdmin = state.me.role === 'admin';
  const pending = requests.filter((r) => r.status === 'pending');
  const rest = requests.filter((r) => r.status !== 'pending');

  const reqCard = (r) => `
    <div class="card row">
      <span style="font-size:26px">${TIMEOFF_ICONS[r.kind] || '📅'}</span>
      <span class="grow">
        <div style="font-weight:700">${isAdmin ? esc(r.user_name) + ' · ' : ''}${r.kind}</div>
        <div class="sub">${r.start_date === r.end_date ? r.start_date : `${r.start_date} → ${r.end_date}`}</div>
        ${r.note ? `<div class="sub">${esc(r.note)}</div>` : ''}
      </span>
      ${r.status === 'pending' && isAdmin ? `
        <button class="btn small" data-decide="approved" data-id="${r.id}">✓</button>
        <button class="btn small danger" data-decide="denied" data-id="${r.id}">✗</button>` : `
        <span class="status-tag ${r.status}">${r.status}</span>`}
      ${r.status === 'pending' && !isAdmin && r.user_id === state.me.id ? `<button class="icon-btn" data-cancel="${r.id}" title="Cancel request">🗑️</button>` : ''}
    </div>`;

  shell('Time Off', `
    ${pending.length ? `<div class="section-title">Pending${isAdmin ? ' approval' : ''}</div>${pending.map(reqCard).join('')}` : ''}
    <div class="section-title">History</div>
    ${rest.length ? rest.map(reqCard).join('') : '<div class="empty"><div class="big">🏖️</div>No time-off requests yet</div>'}
  `, { back: () => { location.hash = '#/more'; }, fab: true });

  document.getElementById('fab').onclick = () => {
    const today = dateKey(new Date());
    const modal = openModal(`
      <h3>Request time off</h3>
      <form id="timeoff-form">
        <label>Type</label>
        <select name="kind">
          <option value="vacation">🏖️ Vacation</option>
          <option value="sick">🤒 Sick</option>
          <option value="personal">🏠 Personal</option>
          <option value="other">📅 Other</option>
        </select>
        <label>First day</label><input name="start_date" type="date" required value="${today}">
        <label>Last day</label><input name="end_date" type="date" required value="${today}">
        <label>Note (optional)</label><textarea name="note" rows="2" placeholder="Anything your manager should know…"></textarea>
        <div class="actions"><button type="submit" class="btn">Send request</button></div>
      </form>
    `);
    modal.querySelector('#timeoff-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/timeoff', { method: 'POST', body: Object.fromEntries(fd.entries()) });
        closeModal(); toast('Request sent — your manager was notified');
        render();
      } catch (err) { toast(err.message); }
    };
  };
  document.querySelectorAll('[data-decide]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/timeoff/${b.dataset.id}/decide`, { method: 'POST', body: { status: b.dataset.decide } });
      toast(`Request ${b.dataset.decide}`);
      render();
    };
  });
  document.querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/timeoff/${b.dataset.cancel}`, { method: 'DELETE' });
      render();
    };
  });
}

/* ---------------------------------- tasks ----------------------------------- */

async function renderTasks() {
  const { tasks } = await api('/api/tasks');
  const isAdmin = state.me.role === 'admin';
  const isDone = (t) => t.assignees.length > 0 && t.assignees.every((a) => a.done_at);
  const open = tasks.filter((t) => !isDone(t));
  const done = tasks.filter(isDone);

  const taskCard = (t) => {
    const mine = t.assignees.find((a) => a.id === state.me.id);
    const overdue = t.due_at && !isDone(t) && new Date(t.due_at) < new Date();
    return `
    <div class="card" data-task="${t.id}">
      <div class="row">
        ${mine ? `<button class="task-check ${mine.done_at ? 'on' : ''}" data-toggle="${t.id}">${mine.done_at ? '✓' : ''}</button>` : '<span style="width:6px"></span>'}
        <span class="grow">
          <div style="font-weight:700;${mine?.done_at ? 'text-decoration:line-through;color:var(--muted)' : ''}">${esc(t.title)}</div>
          ${t.notes ? `<div class="sub">${esc(t.notes)}</div>` : ''}
          ${t.due_at ? `<div class="sub" style="${overdue ? 'color:var(--red);font-weight:600' : ''}">Due ${fmtDay(t.due_at)}${overdue ? ' · overdue' : ''}</div>` : ''}
        </span>
        ${isAdmin ? `<button class="icon-btn" data-edit-task="${t.id}">✏️</button>` : ''}
      </div>
      ${t.assignees.length ? `<div class="shift-people" style="margin-top:8px">
        ${t.assignees.map((a) => `<span class="chip ${a.done_at ? 'accepted' : 'pending'}">
          <span class="avatar" style="background:${esc(a.color)}">${esc(initials(a.name))}</span>
          ${esc(a.name)}<span class="st">${a.done_at ? '✓ Done' : '• Open'}</span></span>`).join('')}
      </div>` : ''}
    </div>`;
  };

  shell('Tasks', `
    ${open.length ? open.map(taskCard).join('') : '<div class="empty"><div class="big">✅</div>No open tasks</div>'}
    ${done.length ? `<div class="section-title">Completed</div>${done.map(taskCard).join('')}` : ''}
  `, { back: () => { location.hash = '#/more'; }, fab: isAdmin });

  if (isAdmin) document.getElementById('fab').onclick = () => openTaskModal();
  document.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      await api(`/api/tasks/${b.dataset.toggle}/toggle`, { method: 'POST' });
      render();
    };
  });
  document.querySelectorAll('[data-edit-task]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      openTaskModal(tasks.find((t) => t.id === Number(b.dataset.editTask)));
    };
  });
}

function openTaskModal(task = null) {
  const selected = new Set(task ? task.assignees.map((a) => a.id) : []);
  const modal = openModal(`
    <h3>${task ? 'Edit task' : 'New task'}</h3>
    <form id="task-form">
      <label>Task</label><input name="title" required placeholder="e.g. Restock the bar fridge" value="${esc(task?.title || '')}">
      <label>Details (optional)</label><textarea name="notes" rows="2">${esc(task?.notes || '')}</textarea>
      <label>Due date (optional)</label><input name="due_at" type="date" value="${task?.due_at ? task.due_at.slice(0, 10) : ''}">
      <label>Assign to</label>
      <div class="assignee-list">
        ${state.users.map((u) => `
          <button type="button" class="opt ${selected.has(u.id) ? 'on' : ''}" data-user="${u.id}">
            <span class="avatar" style="background:${esc(u.color)}">${esc(initials(u.name))}</span>
            ${esc(u.name)}<span class="check">✓</span>
          </button>`).join('')}
      </div>
      <div class="actions">
        ${task ? '<button type="button" class="btn danger" id="task-delete">Delete</button>' : ''}
        <button type="submit" class="btn">${task ? 'Save' : 'Create task'}</button>
      </div>
    </form>
  `);
  modal.querySelectorAll('[data-user]').forEach((b) => {
    b.onclick = () => {
      const id = Number(b.dataset.user);
      selected.has(id) ? selected.delete(id) : selected.add(id);
      b.classList.toggle('on');
    };
  });
  const del = modal.querySelector('#task-delete');
  if (del) del.onclick = async () => {
    if (!confirm('Delete this task?')) return;
    await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
    closeModal(); render();
  };
  modal.querySelector('#task-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      title: fd.get('title'),
      notes: fd.get('notes') || '',
      due_at: fd.get('due_at') ? `${fd.get('due_at')}T23:59:00.000Z` : null,
      assignee_ids: [...selected],
    };
    try {
      await api(task ? `/api/tasks/${task.id}` : '/api/tasks', { method: task ? 'PATCH' : 'POST', body });
      closeModal(); toast(task ? 'Task updated' : 'Task created — assignees notified');
      render();
    } catch (err) { toast(err.message); }
  };
}

/* ---------------------------------- forms ----------------------------------- */

async function renderForms() {
  const { forms } = await api('/api/forms');
  const isAdmin = state.me.role === 'admin';
  shell('Forms', `
    ${forms.length ? forms.map((f) => `
      <div class="card">
        <div class="row">
          <span class="venue-icon" style="background:var(--brand)">📋</span>
          <span class="grow">
            <div style="font-weight:700">${esc(f.title)}</div>
            ${f.description ? `<div class="sub">${esc(f.description)}</div>` : ''}
            <div class="sub">${f.fields.length} question${f.fields.length === 1 ? '' : 's'}${f.my_submissions ? ` · you submitted ${f.my_submissions}×` : ''}${isAdmin ? ` · ${f.total_submissions} total submissions` : ''}</div>
          </span>
        </div>
        <div class="shift-actions">
          <button class="btn small" data-fill="${f.id}">Fill in</button>
          <button class="btn small secondary" data-subs="${f.id}">${isAdmin ? 'Submissions' : 'My submissions'}</button>
          ${isAdmin ? `<button class="btn small danger" data-del-form="${f.id}">Delete</button>` : ''}
        </div>
      </div>`).join('') : `<div class="empty"><div class="big">📋</div>No forms yet${isAdmin ? '<br>Tap ＋ to build one (checklists, incident reports, inspections…)' : ''}</div>`}
  `, { back: () => { location.hash = '#/more'; }, fab: isAdmin });

  if (isAdmin) document.getElementById('fab').onclick = openFormBuilder;
  document.querySelectorAll('[data-fill]').forEach((b) => {
    b.onclick = () => openFormFill(forms.find((f) => f.id === Number(b.dataset.fill)));
  });
  document.querySelectorAll('[data-subs]').forEach((b) => {
    b.onclick = () => openSubmissions(Number(b.dataset.subs));
  });
  document.querySelectorAll('[data-del-form]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this form? Past submissions are kept but hidden.')) return;
      await api(`/api/forms/${b.dataset.delForm}`, { method: 'DELETE' });
      render();
    };
  });
}

function openFormFill(form) {
  const modal = openModal(`
    <h3>${esc(form.title)}</h3>
    ${form.description ? `<p class="sub">${esc(form.description)}</p>` : ''}
    <form id="fill-form">
      ${form.fields.map((f) => {
        const req = f.required ? 'required' : '';
        if (f.type === 'checkbox') return `<label class="check-label"><input type="checkbox" name="f${f.id}" style="width:auto"> ${esc(f.label)}${f.required ? ' *' : ''}</label>`;
        const label = `<label>${esc(f.label)}${f.required ? ' *' : ''}</label>`;
        if (f.type === 'textarea') return `${label}<textarea name="f${f.id}" rows="3" ${req}></textarea>`;
        if (f.type === 'select') return `${label}<select name="f${f.id}" ${req}><option value="">Choose…</option>${(f.options || []).map((o) => `<option>${esc(o)}</option>`).join('')}</select>`;
        return `${label}<input name="f${f.id}" type="${f.type}" ${req}>`;
      }).join('')}
      <div class="actions"><button type="submit" class="btn">Submit</button></div>
    </form>
  `);
  modal.querySelector('#fill-form').onsubmit = async (e) => {
    e.preventDefault();
    const answers = {};
    for (const f of form.fields) {
      const el = e.target.elements[`f${f.id}`];
      answers[f.id] = f.type === 'checkbox' ? el.checked : el.value;
    }
    try {
      await api(`/api/forms/${form.id}/submit`, { method: 'POST', body: { answers } });
      closeModal(); toast('Submitted ✅');
      render();
    } catch (err) { toast(err.message); }
  };
}

async function openSubmissions(formId) {
  const { form, submissions } = await api(`/api/forms/${formId}/submissions`);
  openModal(`
    <h3>${esc(form.title)} — submissions</h3>
    ${submissions.length ? submissions.map((s) => `
      <div class="card" style="box-shadow:none;border:1px solid var(--line)">
        <div class="row" style="margin-bottom:6px">
          <span class="avatar" style="background:${esc(s.user_color || '#888')}">${esc(initials(s.user_name || '?'))}</span>
          <b>${esc(s.user_name || 'Removed user')}</b>
          <span class="sub" style="margin-left:auto">${fmtWhen(s.created_at)}</span>
        </div>
        ${form.fields.map((f) => `<div class="sub" style="margin:3px 0"><b>${esc(f.label)}:</b> ${f.type === 'checkbox' ? (s.answers[f.id] ? '✅ yes' : '⬜ no') : esc(s.answers[f.id] || '—')}</div>`).join('')}
      </div>`).join('') : '<p class="sub" style="margin-top:10px">No submissions yet.</p>'}
    <div class="actions"><button class="btn secondary" onclick="document.querySelector('.modal-backdrop').remove()">Close</button></div>
  `);
}

function openFormBuilder() {
  const fields = [];
  const modal = openModal(`
    <h3>New form</h3>
    <form id="form-builder">
      <label>Form title</label><input name="title" required placeholder="e.g. End-of-shift checklist">
      <label>Description (optional)</label><input name="description" placeholder="Shown to the team above the questions">
      <label>Questions</label>
      <div id="fields-list"></div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        <button type="button" class="btn small secondary" data-add="text">+ Text</button>
        <button type="button" class="btn small secondary" data-add="textarea">+ Paragraph</button>
        <button type="button" class="btn small secondary" data-add="checkbox">+ Checkbox</button>
        <button type="button" class="btn small secondary" data-add="select">+ Dropdown</button>
        <button type="button" class="btn small secondary" data-add="number">+ Number</button>
        <button type="button" class="btn small secondary" data-add="date">+ Date</button>
      </div>
      <div class="actions"><button type="submit" class="btn">Create form</button></div>
    </form>
  `);
  const list = modal.querySelector('#fields-list');
  const typeNames = { text: 'Text', textarea: 'Paragraph', checkbox: 'Checkbox', select: 'Dropdown', number: 'Number', date: 'Date' };

  function redraw() {
    list.innerHTML = fields.map((f, i) => `
      <div class="builder-field">
        <div class="row">
          <span class="role-tag">${typeNames[f.type]}</span>
          <input data-label="${i}" placeholder="Question label" value="${esc(f.label)}" style="flex:1">
          <button type="button" class="icon-btn" data-remove="${i}">🗑️</button>
        </div>
        ${f.type === 'select' ? `<input data-options="${i}" placeholder="Options, comma separated" value="${esc((f.options || []).join(', '))}" style="margin-top:6px">` : ''}
        <label class="check-label" style="margin-top:6px;font-weight:400"><input type="checkbox" data-required="${i}" ${f.required ? 'checked' : ''} style="width:auto"> Required</label>
      </div>`).join('') || '<p class="sub">Add at least one question below.</p>';
    list.querySelectorAll('[data-label]').forEach((el) => { el.oninput = () => { fields[el.dataset.label].label = el.value; }; });
    list.querySelectorAll('[data-options]').forEach((el) => { el.oninput = () => { fields[el.dataset.options].options = el.value.split(',').map((s) => s.trim()).filter(Boolean); }; });
    list.querySelectorAll('[data-required]').forEach((el) => { el.onchange = () => { fields[el.dataset.required].required = el.checked; }; });
    list.querySelectorAll('[data-remove]').forEach((el) => { el.onclick = () => { fields.splice(Number(el.dataset.remove), 1); redraw(); }; });
  }
  redraw();
  modal.querySelectorAll('[data-add]').forEach((b) => {
    b.onclick = () => { fields.push({ type: b.dataset.add, label: '', required: false, options: [] }); redraw(); };
  });
  modal.querySelector('#form-builder').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/forms', {
        method: 'POST',
        body: { title: fd.get('title'), description: fd.get('description') || '', fields },
      });
      closeModal(); toast('Form published — team notified');
      render();
    } catch (err) { toast(err.message); }
  };
}

/* ------------------------------- updates feed ------------------------------- */

async function renderUpdates() {
  const { posts } = await api('/api/posts');
  const isAdmin = state.me.role === 'admin';
  shell('Updates', `
    ${posts.length ? posts.map((p) => `
      <div class="card">
        <div class="row" style="margin-bottom:8px">
          <span class="avatar lg" style="background:${esc(p.user_color || '#888')}">${esc(initials(p.user_name || '?'))}</span>
          <span class="grow">
            <div style="font-weight:700">${esc(p.user_name || 'Removed user')}</div>
            <div class="sub">${fmtWhen(p.created_at)}</div>
          </span>
          ${isAdmin ? `<button class="icon-btn" data-del-post="${p.id}">🗑️</button>` : ''}
        </div>
        ${p.title ? `<div style="font-weight:700;font-size:16px;margin-bottom:4px">${esc(p.title)}</div>` : ''}
        <div style="white-space:pre-wrap">${esc(p.body)}</div>
        <button class="like-btn ${p.liked ? 'on' : ''}" data-like="${p.id}">👍 ${p.likes || ''}</button>
      </div>`).join('') : `<div class="empty"><div class="big">📢</div>No updates yet${isAdmin ? '<br>Tap ＋ to post a company update' : ''}</div>`}
  `, { fab: isAdmin });

  if (isAdmin) {
    document.getElementById('fab').onclick = () => {
      const modal = openModal(`
        <h3>New update</h3>
        <form id="post-form">
          <label>Title (optional)</label><input name="title" placeholder="e.g. Schedule for the holiday weekend">
          <label>Message</label><textarea name="body" rows="5" required placeholder="Everyone gets a notification on their phone…"></textarea>
          <div class="actions"><button type="submit" class="btn">Post & notify team</button></div>
        </form>
      `);
      modal.querySelector('#post-form').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        await api('/api/posts', { method: 'POST', body: { title: fd.get('title') || '', body: fd.get('body') } });
        closeModal(); toast('Posted — team notified');
        render();
      };
    };
    document.querySelectorAll('[data-del-post]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Delete this update?')) return;
        await api(`/api/posts/${b.dataset.delPost}`, { method: 'DELETE' });
        render();
      };
    });
  }
  document.querySelectorAll('[data-like]').forEach((b) => {
    b.onclick = async () => { await api(`/api/posts/${b.dataset.like}/like`, { method: 'POST' }); render(); };
  });
}

/* ---------------------------------- more hub --------------------------------- */

function renderMore() {
  const isAdmin = state.me.role === 'admin';
  const items = [
    { href: '#/tasks', icon: '✅', label: 'Tasks', sub: 'To-dos for the team' },
    { href: '#/timeoff', icon: '🏖️', label: 'Time Off', sub: 'Requests & approvals' },
    { href: '#/forms', icon: '📋', label: 'Forms', sub: 'Checklists & reports' },
    ...(isAdmin ? [{ href: '#/timesheets', icon: '🧾', label: 'Timesheets', sub: 'Hours, approval & payroll CSV' }] : []),
    { href: '#/venues', icon: '📍', label: 'Venues', sub: 'Work locations' },
    { href: '#/team', icon: '👥', label: 'Team', sub: 'People & roles' },
    { href: '#/notifications', icon: '🔔', label: 'Notifications', sub: 'Your activity feed' },
    { href: '#/settings', icon: '⚙️', label: 'Settings', sub: 'Notifications & account' },
  ];
  shell('More', `
    <div class="card row" style="margin-bottom:16px">
      <span class="avatar lg" style="background:${esc(state.me.color)}">${esc(initials(state.me.name))}</span>
      <span class="grow">
        <div style="font-weight:700">${esc(state.me.name)}</div>
        <div class="sub">${esc(state.me.email)}</div>
      </span>
      <span class="role-tag">${state.me.role}</span>
    </div>
    ${items.map((i) => `
      <button class="channel-row" data-href="${i.href}">
        <span class="venue-icon" style="background:var(--brand-soft);color:var(--text);font-size:20px">${i.icon}</span>
        <span class="info"><div class="name">${i.label}</div><div class="preview">${i.sub}</div></span>
        <span class="sub">›</span>
      </button>`).join('')}
  `);
  document.querySelectorAll('[data-href]').forEach((b) => {
    b.onclick = () => { location.hash = b.dataset.href; };
  });
}

/* --------------------------------- render ---------------------------------- */

async function render() {
  if (!state.me) return renderAuth();
  clearInterval(state.timer);
  const { view, arg } = route();
  try {
    if (view === 'schedule') renderSchedule();
    else if (view === 'chat' && arg) await renderChat(arg);
    else if (view === 'chat') await renderChatList();
    else if (view === 'clock') await renderClock();
    else if (view === 'timesheets') await renderTimesheets();
    else if (view === 'timeoff') await renderTimeoff();
    else if (view === 'tasks') await renderTasks();
    else if (view === 'forms') await renderForms();
    else if (view === 'updates') await renderUpdates();
    else if (view === 'more') renderMore();
    else if (view === 'venues') renderVenues();
    else if (view === 'team') renderTeam();
    else if (view === 'notifications') await renderNotifications();
    else if (view === 'settings') await renderSettings();
    else { location.hash = '#/schedule'; }
  } catch (err) {
    console.error(err);
    toast(err.message);
  }
}

/* -------------------------------- bootstrap -------------------------------- */

async function bootstrap() {
  const [me, users, venues, channels, notifs] = await Promise.all([
    api('/api/me'), api('/api/users'), api('/api/venues'), api('/api/channels'), api('/api/notifications'),
  ]);
  state.me = me.user;
  state.vapidPublicKey = me.vapidPublicKey;
  state.users = users.users;
  state.venues = venues.venues;
  state.channels = channels.channels;
  state.notifications = notifs.notifications;
  connectEvents();
  await loadShifts();
  if (!location.hash) location.hash = '#/schedule';
  render();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

api('/api/me')
  .then(() => bootstrap())
  .catch(() => renderAuth());
