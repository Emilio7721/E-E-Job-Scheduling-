/* E&E Job Scheduling — single-page app */
'use strict';

const $app = document.getElementById('app');

const state = {
  me: null,
  vapidPublicKey: null,
  users: [],
  venues: [],
  roles: [],
  positions: [],
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

/* --------------------------------- theme ---------------------------------- */

function themePref() {
  const t = localStorage.getItem('ee-theme');
  return t === 'light' || t === 'dark' ? t : 'system';
}

function applyTheme(pref) {
  if (pref === 'system') {
    localStorage.removeItem('ee-theme');
    delete document.documentElement.dataset.theme;
  } else {
    localStorage.setItem('ee-theme', pref);
    document.documentElement.dataset.theme = pref;
  }
  const dark = pref === 'dark' || (pref !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.getElementById('meta-theme')?.setAttribute('content', dark ? '#101114' : '#ffffff');
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(themePref()));

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
    time: ['clock', 'timesheets'], forms: ['forms'], posts: ['updates'],
    hours: ['hours'], roles: ['roles'], positions: ['positions', 'team'], users: ['team'],
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

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

function isMobile() {
  return isIOS() || /Android/.test(navigator.userAgent);
}

// Android Chrome fires this when the app is installable; stashing it lets us
// show a real one-tap "Install now" button inside the tutorial.
let installPromptEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPromptEvent = e;
});

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

/* ------------------------------- onboarding -------------------------------- */

function tutorialSteps(steps) {
  return `<div class="tut-steps">${steps.map((s, i) => `
    <div class="tut-step"><span class="tut-num">${i + 1}</span><span>${s}</span></div>`).join('')}
  </div>`;
}

function showInstallModal(onClose) {
  const modal = openModal(`
    <img src="/brand/logo.png" alt="E&amp;E Management" style="display:block;max-width:170px;margin:0 auto 8px">
    <h3 style="text-align:center">Get the app on your phone</h3>
    <p class="sub" style="text-align:center">Add E&amp;E to your home screen for the full app experience — including notifications when the app is closed.</p>
    <div class="tut-tabs">
      <button class="pill" data-plat="ios" style="flex:1">🍎 iPhone</button>
      <button class="pill" data-plat="android" style="flex:1">🤖 Android</button>
    </div>
    <div id="tut-body"></div>
    <div class="actions"><button class="btn secondary" id="tut-close">Got it</button></div>
  `);

  let plat = isIOS() ? 'ios' : 'android';
  const bodies = {
    ios: tutorialSteps([
      'Open this website in <b>Safari</b>.',
      'Tap the <b>Share</b> button <span class="tut-icon">⬆️</span> (the square with an arrow, at the bottom).',
      'Scroll down and tap <b>“Add to Home Screen”</b>, then <b>Add</b>.',
      'Open <b>E&amp;E</b> from your home screen and turn on notifications when asked.',
    ]) + `<p class="hint">iPhones only allow notifications for apps installed on the home screen — that's why this step matters.</p>`,
    android: (installPromptEvent
      ? `<button class="btn" id="tut-install-now" style="margin-top:14px">⬇️ Install now</button>
         <p class="hint" style="text-align:center">One tap — Chrome installs it straight to your home screen.</p>`
      : tutorialSteps([
          'Open this website in <b>Chrome</b>.',
          'Tap the <b>⋮ menu</b> (top right corner).',
          'Tap <b>“Add to Home screen”</b> or <b>“Install app”</b>, then confirm.',
          'Open <b>E&amp;E</b> from your home screen and turn on notifications when asked.',
        ])),
  };

  function draw() {
    modal.querySelectorAll('[data-plat]').forEach((b) => b.classList.toggle('active', b.dataset.plat === plat));
    modal.querySelector('#tut-body').innerHTML = bodies[plat];
    const installBtn = modal.querySelector('#tut-install-now');
    if (installBtn) installBtn.onclick = async () => {
      installPromptEvent.prompt();
      const { outcome } = await installPromptEvent.userChoice;
      installPromptEvent = null;
      if (outcome === 'accepted') { closeModal(); toast('Installed! Open E&E from your home screen 🎉'); }
      else draw();
    };
  }
  draw();
  modal.querySelectorAll('[data-plat]').forEach((b) => { b.onclick = () => { plat = b.dataset.plat; draw(); }; });
  modal.querySelector('#tut-close').onclick = () => { closeModal(); if (onClose) onClose(); };
}

function showNotifPrompt() {
  const modal = openModal(`
    <div style="text-align:center;font-size:46px;margin-bottom:4px">🔔</div>
    <h3 style="text-align:center">Turn on notifications</h3>
    <p class="sub" style="text-align:center">Get new jobs, schedule changes and team messages on this device — even when the app is closed.</p>
    <div class="actions">
      <button class="btn secondary" id="notif-later">Not now</button>
      <button class="btn" id="notif-enable">Turn on</button>
    </div>
  `);
  modal.querySelector('#notif-later').onclick = () => {
    localStorage.setItem('ee-notif-dismissed', String(Date.now()));
    closeModal();
  };
  modal.querySelector('#notif-enable').onclick = async () => {
    closeModal();
    try { await enablePush(); } catch (err) { toast(err.message); }
  };
}

function queueNotifPrompt() {
  if (!pushSupported()) return;
  if (Notification.permission !== 'default') return;
  const dismissed = Number(localStorage.getItem('ee-notif-dismissed') || 0);
  if (Date.now() - dismissed < 3 * 24 * 3600 * 1000) return; // re-ask after 3 days
  showNotifPrompt();
}

async function maybeShowOnboarding() {
  if (kioskArmed()) return; // a kiosk device gets no personal onboarding
  // Permission already granted: re-register this device on every launch. A push
  // endpoint is unique per device, so if anyone else signed in here the endpoint
  // now points at their account — re-posting it rebinds it to whoever is signed
  // in, which is why assignments could silently stop arriving.
  if (pushSupported() && Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription())
        || await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(state.vapidPublicKey),
        });
      await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
    } catch {}
    return;
  }
  // Browser tab on a phone: teach the home-screen install first.
  if (!isStandalone() && isMobile() && !localStorage.getItem('ee-install-seen')) {
    localStorage.setItem('ee-install-seen', '1');
    showInstallModal(queueNotifPrompt);
    return;
  }
  queueNotifPrompt();
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

function kioskArmed() {
  return localStorage.getItem('ee-kiosk') === '1';
}

function fmtPhone(p) {
  if (!p) return '';
  return p.length === 10 ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p;
}

// Preferred contact line: phone, else a real email (hides synthetic @ee.local ones).
function contactOf(u) {
  if (u.phone) return fmtPhone(u.phone);
  return u.email && !u.email.endsWith('@ee.local') ? u.email : '';
}

function renderAuth() {
  if (kioskArmed()) return renderKioskUnlock();
  const signup = state.authMode === 'signup';
  $app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <img class="auth-brand" src="/brand/logo.png" alt="E&amp;E Management — Event Services and More">
        ${signup ? `
        <p class="auth-sub">Enter your name and phone number — you'll get a PIN to sign in and clock in.</p>
        <form id="signup-form">
          <label>Full name</label><input name="name" required autocomplete="name" placeholder="Jane Doe">
          <label>Phone number</label><input name="phone" required autocomplete="tel" inputmode="tel" placeholder="(555) 123-4567">
          <div class="auth-error" id="auth-error"></div>
          <button class="btn" type="submit">Get my PIN</button>
        </form>
        <div class="auth-switch">Already have a PIN? <button id="auth-switch">Sign in</button></div>
        ` : `
        <p class="auth-sub">Enter your PIN to sign in</p>
        ${pinPadHTML()}
        <div class="auth-switch">New here? <button id="auth-switch">Sign up to get a PIN</button></div>
        `}
      </div>
    </div>`;
  document.getElementById('auth-switch').onclick = () => {
    state.authMode = signup ? 'signin' : 'signup';
    renderAuth();
  };
  if (signup) {
    document.getElementById('signup-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const { user, pin } = await api('/api/auth/register', {
          method: 'POST',
          body: { name: fd.get('name'), phone: fd.get('phone') },
        });
        state.me = user;
        showPinReveal(pin, user.role === 'admin');
      } catch (err) {
        document.getElementById('auth-error').textContent = err.message;
      }
    };
  } else {
    bindPinPad(document.querySelector('.auth-card'), async (pin) => {
      const { user } = await api('/api/auth/login', { method: 'POST', body: { pin } });
      state.me = user;
      await bootstrap();
    });
  }
}

function showPinReveal(pin, isAdmin) {
  $app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card" style="text-align:center">
        <img class="auth-brand" src="/brand/logo.png" alt="E&amp;E Management">
        <h3 style="margin-top:4px">Welcome${isAdmin ? ', admin' : ''}! Here's your PIN</h3>
        <div class="pin-reveal">${esc(pin)}</div>
        <p class="auth-sub">This is how you sign in and clock in${isAdmin ? '' : ' at the kiosk'}.<br>Memorize it — it's always available in Settings.</p>
        <button class="btn" id="pin-done">I saved my PIN — continue</button>
      </div>
    </div>`;
  document.getElementById('pin-done').onclick = () => bootstrap();
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
const MORE_VIEWS = ['more', 'venues', 'team', 'forms', 'timesheets', 'settings', 'notifications', 'hours', 'roles', 'positions'];

async function signOut() {
  if (!confirm('Sign out of E&E?')) return;
  await api('/api/auth/logout', { method: 'POST' });
  state.es?.close();
  state.me = null;
  location.hash = '';
  renderAuth();
}

function shell(title, contentHTML, { back = null, fab = null } = {}) {
  let { view } = route();
  if (MORE_VIEWS.includes(view)) view = 'more';
  $app.innerHTML = `
    ${back !== 'none' ? `
    <header class="topbar">
      ${back ? `<button class="icon-btn" id="back-btn">←</button>` : ''}
      <h2>${esc(title)}</h2>
      <button class="icon-btn" id="notif-btn">🔔</button>
      <button class="icon-btn" id="signout-btn" title="Sign out">⏻</button>
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
  const signoutBtn = document.getElementById('signout-btn');
  if (signoutBtn) signoutBtn.onclick = signOut;
  updateBadges();
}

/* ---------------------------- people picker -------------------------------- */

// Search box + filtered, multi-select list of people. Returns markup; pair it
// with bindPeoplePicker() to keep `selected` in sync as the admin types.
function peoplePickerHTML(people, selected, { id = 'picker', placeholder = 'Search team members…' } = {}) {
  return `
    <input class="picker-search" id="${id}-search" type="search" autocomplete="off" placeholder="${esc(placeholder)}">
    <div class="assignee-list" id="${id}-list">
      ${people.map((u) => `
        <button type="button" class="opt ${selected.has(u.id) ? 'on' : ''}" data-user="${u.id}" data-name="${esc(u.name.toLowerCase())}">
          <span class="avatar" style="background:${esc(u.color)}">${esc(initials(u.name))}</span>
          <span class="grow">${esc(u.name)}</span>
          <span class="check">✓</span>
        </button>`).join('')}
    </div>
    <div class="picker-empty" id="${id}-empty" hidden>No one matches that search.</div>`;
}

function bindPeoplePicker(root, selected, { id = 'picker' } = {}) {
  const search = root.querySelector(`#${id}-search`);
  const empty = root.querySelector(`#${id}-empty`);
  const options = [...root.querySelectorAll(`#${id}-list [data-user]`)];

  const filter = () => {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const opt of options) {
      const match = !q || opt.dataset.name.includes(q);
      opt.hidden = !match;
      if (match) shown++;
    }
    empty.hidden = shown > 0;
  };
  search.oninput = filter;

  for (const opt of options) {
    opt.onclick = () => {
      const uid = Number(opt.dataset.user);
      selected.has(uid) ? selected.delete(uid) : selected.add(uid);
      opt.classList.toggle('on');
    };
  }
  return filter;
}

/* -------------------------------- PIN pad ---------------------------------- */

function pinPadHTML() {
  return `
    <div class="pin-dots">${'<span></span>'.repeat(5)}</div>
    <div class="pin-err"></div>
    <div class="pin-pad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'].map((k) => (
        k === '' ? '<span></span>' : `<button type="button" data-key="${k}">${k}</button>`
      )).join('')}
    </div>`;
}

// Wires a rendered pinPadHTML() inside `root`; calls onComplete(pin) at 5 digits.
// onComplete may throw — the message is shown and the pad resets.
function bindPinPad(root, onComplete) {
  let pin = '';
  let busy = false;
  const dots = root.querySelectorAll('.pin-dots span');
  const err = root.querySelector('.pin-err');
  const draw = () => dots.forEach((d, i) => d.classList.toggle('on', i < pin.length));
  root.querySelectorAll('[data-key]').forEach((b) => {
    b.onclick = async () => {
      if (busy) return;
      err.textContent = '';
      if (b.dataset.key === '⌫') pin = pin.slice(0, -1);
      else if (pin.length < 5) pin += b.dataset.key;
      draw();
      if (pin.length === 5) {
        busy = true;
        try { await onComplete(pin); }
        catch (e) { err.textContent = e.message; }
        pin = ''; draw(); busy = false;
      }
    };
  });
}

function openPinPad(title, onComplete) {
  const modal = openModal(`
    <h3 style="text-align:center">${esc(title)}</h3>
    <p class="sub" style="text-align:center">Your 5-digit PIN is shown in Settings.</p>
    ${pinPadHTML()}
  `);
  bindPinPad(modal, onComplete);
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
      openShiftDetail(state.shifts.find((s) => s.id === Number(el.dataset.shift)));
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
      <div class="shift-stripe" style="background:${esc(s.venue_color || '#a8862c')}"></div>
      <div class="shift-body">
        <div class="shift-time">${fmtTime(s.starts_at)} – ${fmtTime(s.ends_at)}</div>
        <div class="shift-title">${esc(s.title)}</div>
        ${s.venue_name ? `<div class="shift-venue">📍 ${esc(s.venue_name)}${s.venue_address ? ` · ${esc(s.venue_address)}` : ''}</div>` : ''}
        ${s.role_name ? `<div class="shift-venue">🧑‍🍳 ${esc(s.role_name)}</div>` : ''}
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
  const isAdmin = state.me.role === 'admin';
  const mine = s.assignees.find((a) => a.id === state.me.id);
  const hours = ((new Date(s.ends_at) - new Date(s.starts_at)) / 3600000).toFixed(1).replace(/\.0$/, '');
  const statusLabel = { accepted: '✓ Accepted', declined: '✗ Declined', pending: '• Awaiting reply' };

  const modal = openModal(`
    <div class="detail-title" style="border-left:5px solid ${esc(s.venue_color || 'var(--brand)')}">
      <h3>${esc(s.title)}</h3>
      <div class="detail-when">${fmtDay(s.starts_at)}</div>
    </div>

    <div class="detail-rows">
      <div class="detail-row">
        <span class="detail-ico">🕐</span>
        <span><b>${fmtTime(s.starts_at)} – ${fmtTime(s.ends_at)}</b><div class="sub">${hours} hour${hours === '1' ? '' : 's'}</div></span>
      </div>
      ${s.venue_name ? `
      <div class="detail-row">
        <span class="detail-ico">📍</span>
        <span><b>${esc(s.venue_name)}</b>${s.venue_address ? `<div class="sub">${esc(s.venue_address)}</div>` : ''}</span>
        ${s.venue_address ? `<button class="btn small secondary" data-map-detail="${encodeURIComponent(s.venue_address)}">Map</button>` : ''}
      </div>` : ''}
      ${s.role_name ? `
      <div class="detail-row">
        <span class="detail-ico">🧑‍🍳</span>
        <span><b>${esc(s.role_name)}</b><div class="sub">Job</div></span>
      </div>` : ''}
      ${s.notes ? `
      <div class="detail-row">
        <span class="detail-ico">📝</span>
        <span style="white-space:pre-wrap">${esc(s.notes)}</span>
      </div>` : ''}
    </div>

    <div class="section-title" style="margin-top:16px">Team on this job (${s.assignees.length})</div>
    ${s.assignees.length ? `<div class="detail-people">
      ${s.assignees.map((a) => `
        <div class="row detail-person">
          <span class="avatar lg" style="background:${esc(a.color)}">${esc(initials(a.name))}</span>
          <span class="grow">
            <div style="font-weight:700">${esc(a.name)}${a.id === state.me.id ? ' <span class="sub">(you)</span>' : ''}</div>
            <div class="sub ${a.status}">${statusLabel[a.status] || ''}</div>
          </span>
        </div>`).join('')}
    </div>` : '<p class="sub">Nobody assigned yet.</p>'}

    ${mine && mine.status === 'pending' ? `
      <div class="actions">
        <button class="btn danger" data-detail-respond="declined">Decline</button>
        <button class="btn" data-detail-respond="accepted">Accept</button>
      </div>` : ''}
    <div class="actions">
      ${isAdmin ? '<button class="btn secondary" id="detail-edit">Edit job</button>' : ''}
      <button class="btn ${isAdmin ? 'secondary' : ''}" id="detail-close">Close</button>
    </div>
  `);

  modal.querySelector('#detail-close').onclick = closeModal;
  const mapBtn = modal.querySelector('[data-map-detail]');
  if (mapBtn) mapBtn.onclick = () => window.open(`https://maps.google.com/?q=${mapBtn.dataset.mapDetail}`, '_blank');
  const editBtn = modal.querySelector('#detail-edit');
  if (editBtn) editBtn.onclick = () => { closeModal(); openShiftModal(s); };
  modal.querySelectorAll('[data-detail-respond]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/shifts/${s.id}/respond`, { method: 'POST', body: { status: b.dataset.detailRespond } });
      closeModal();
      toast(b.dataset.detailRespond === 'accepted' ? 'Job accepted ✅' : 'Job declined');
      loadShifts().then(render);
    };
  });
}

function openShiftModal(shift = null) {
  const selected = new Set(shift ? shift.assignees.map((a) => a.id) : []);
  const day = shift ? dateKey(new Date(shift.starts_at)) : state.selectedDay;
  const startVal = shift ? toLocalInput(shift.starts_at) : `${day}T09:00`;
  const endVal = shift ? toLocalInput(shift.ends_at) : `${day}T17:00`;

  const modal = openModal(`
    <h3>${shift ? 'Edit job' : 'New job'}</h3>
    <form id="shift-form">
      <label>Title</label><input name="title" required placeholder="e.g. Bar setup — wedding" value="${esc(shift?.title || '')}">
      <label>Venue</label>
      <select name="venue_id">
        <option value="">No venue</option>
        ${state.venues.map((v) => `<option value="${v.id}" ${shift?.venue_id === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}
      </select>
      <label>Job (optional)</label>
      <select name="role_id">
        <option value="">No job</option>
        ${state.roles.map((r) => `<option value="${r.id}" ${shift?.role_id === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
      </select>
      <label>Starts</label><input name="starts_at" type="datetime-local" required value="${startVal}">
      <label>Ends</label><input name="ends_at" type="datetime-local" required value="${endVal}">
      <label>Notes</label><textarea name="notes" rows="2" placeholder="Instructions, dress code, contact…">${esc(shift?.notes || '')}</textarea>
      <label>Assign team members</label>
      ${peoplePickerHTML(state.users, selected, { id: 'shift-picker' })}
      <div class="actions">
        ${shift ? `<button type="button" class="btn danger" id="delete-shift">Delete</button>` : ''}
        <button type="submit" class="btn">${shift ? 'Save changes' : 'Create job'}</button>
      </div>
    </form>
  `);

  bindPeoplePicker(modal, selected, { id: 'shift-picker' });
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
      role_id: fd.get('role_id') ? Number(fd.get('role_id')) : null,
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
      ${peoplePickerHTML(state.users.filter((u) => u.id !== state.me.id), selected, { id: 'chan-picker' })}
      <div class="actions"><button type="submit" class="btn">Create channel</button></div>
    </form>
  `);
  bindPeoplePicker(modal, selected, { id: 'chan-picker' });
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
      <div class="card row team-row">
        <span class="avatar lg" style="background:${esc(u.color)}">${esc(initials(u.name))}</span>
        <span class="grow">
          <div style="font-weight:700">${esc(u.name)} ${u.id === state.me.id ? '<span class="sub">(you)</span>' : ''}</div>
          <div class="sub">${esc(contactOf(u))}</div>
        </span>
        <span class="role-tag">${esc(state.positions.find((r) => r.id === u.position_id)?.name || (u.role === 'admin' ? 'Admin' : 'Member'))}</span>
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

async function removeTeamMember(user) {
  if (!confirm(`Remove ${user.name} from the team?\n\nThey lose access immediately and their timesheet history is deleted. Export payroll first if you still need their hours.`)) return false;
  try {
    await api(`/api/users/${user.id}`, { method: 'DELETE' });
    state.users = (await api('/api/users')).users;
    toast(`${user.name} removed`);
    return true;
  } catch (err) { toast(err.message); return false; }
}

function openUserModal(user) {
  const isSelf = user.id === state.me.id;
  const modal = openModal(`
    <h3>${esc(user.name)}</h3>
    <p class="sub">${esc(contactOf(user))}</p>
    <form id="user-form">
      <label>Position</label>
      <select name="position_id" id="position-select">
        <option value="">No position</option>
        ${state.positions.map((r) => `<option value="${r.id}" ${user.position_id === r.id ? 'selected' : ''}>${esc(r.name)}${r.is_admin ? ' (admin)' : ''}</option>`).join('')}
      </select>
      <p class="hint">Access follows the position: those marked (admin) make the person an admin. Manage them in More → Positions.<br>Currently: <b>${user.role === 'admin' ? 'Admin' : 'Member'}</b>${isSelf ? ' (you)' : ''}</p>
      <div class="card row" style="box-shadow:none;border:1px solid var(--line);margin:12px 0 0">
        <span class="grow">
          <div style="font-weight:700">Phone notifications</div>
          <div class="sub">${user.devices ? `✅ ${user.devices} device${user.devices === 1 ? '' : 's'} registered` : '⚠️ No device registered — they need to open the app and turn notifications on'}</div>
        </span>
        ${user.devices && !isSelf ? '<button type="button" class="btn small secondary" id="push-test-user">Test</button>' : ''}
      </div>
      <label>Clock-in PIN</label>
      <div class="row">
        <span class="pin-value" id="pin-view">${esc(user.pin || '—')}</span>
        <button class="btn small secondary" type="button" id="regen-pin">Generate new PIN</button>
      </div>
      <div class="actions">
        ${isSelf ? '' : '<button type="button" class="btn danger" id="remove-user">Remove</button>'}
        <button type="submit" class="btn">Save</button>
      </div>
    </form>
  `);
  const removeBtn = modal.querySelector('#remove-user');
  if (removeBtn) removeBtn.onclick = async () => {
    if (await removeTeamMember(user)) { closeModal(); render(); }
  };
  modal.querySelector('#regen-pin').onclick = async () => {
    if (!confirm(`Give ${user.name} a new PIN? The old one stops working immediately.`)) return;
    const { pin } = await api(`/api/users/${user.id}`, { method: 'PATCH', body: { new_pin: true } });
    modal.querySelector('#pin-view').textContent = pin;
    state.users = (await api('/api/users')).users;
    toast('New PIN generated');
  };
  const posSel = modal.querySelector('#position-select');
  const pushTest = modal.querySelector('#push-test-user');
  if (pushTest) pushTest.onclick = async () => {
    try {
      await api(`/api/push/test/${user.id}`, { method: 'POST' });
      toast(`Test sent to ${user.name}`);
    } catch (err) { toast(err.message); }
  };

  modal.querySelector('#user-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/users/${user.id}`, {
        method: 'PATCH',
        body: { position_id: posSel.value ? Number(posSel.value) : null },
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
    ${notifications.length ? `
      <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
        <button class="btn small secondary" id="clear-notifs">Clear all</button>
      </div>
      ${notifications.map((n) => `
      <div class="card notif ${n.read ? '' : 'unread'}">
        <div class="row">
          <span class="grow" data-notif-url="${esc(n.url)}">
            <div class="title">${esc(n.title)}</div>
            ${n.body ? `<div class="body">${esc(n.body)}</div>` : ''}
            <div class="when">${fmtWhen(n.created_at)}</div>
          </span>
          <button class="icon-btn" data-del-notif="${n.id}" title="Remove">✕</button>
        </div>
      </div>`).join('')}` : `
      <div class="empty"><div class="big">🔔</div>Nothing here yet.<br>Job assignments and updates will show up here.</div>`}
  `, { back: () => history.back() });
  document.querySelectorAll('[data-notif-url]').forEach((el) => {
    el.onclick = () => { location.href = el.dataset.notifUrl; };
  });
  document.querySelectorAll('[data-del-notif]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      await api(`/api/notifications/${b.dataset.delNotif}`, { method: 'DELETE' });
      state.notifications = state.notifications.filter((n) => n.id !== Number(b.dataset.delNotif));
      render();
    };
  });
  const clearBtn = document.getElementById('clear-notifs');
  if (clearBtn) clearBtn.onclick = async () => {
    if (!confirm('Clear all notifications?')) return;
    await api('/api/notifications', { method: 'DELETE' });
    state.notifications = [];
    render();
  };
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
  const standalone = isStandalone();
  shell('Settings', `
    <div class="card row">
      <span class="avatar lg" style="background:${esc(state.me.color)}">${esc(initials(state.me.name))}</span>
      <span class="grow">
        <div style="font-weight:700">${esc(state.me.name)}</div>
        <div class="sub">${esc(contactOf(state.me))}</div>
      </span>
      <span class="role-tag">${state.me.role}</span>
    </div>

    <div class="section-title">Clock-in PIN</div>
    <div class="card row">
      <span class="grow">
        <div style="font-weight:700">My PIN</div>
        <div class="sub">You sign in and clock in with it — keep it private.</div>
      </span>
      <span class="pin-value">${esc(state.me.pin || '—')}</span>
    </div>

    <div class="section-title">Appearance</div>
    <div class="card">
      <div style="display:flex;gap:8px">
        ${['system', 'light', 'dark'].map((t) => `
          <button class="pill ${themePref() === t ? 'active' : ''}" data-theme-opt="${t}" style="flex:1">
            ${{ system: '📱 Auto', light: '☀️ Light', dark: '🌙 Dark' }[t]}
          </button>`).join('')}
      </div>
      <p class="hint">Auto follows your phone's light/dark setting.</p>
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
      ${Notification.permission === 'denied' ? `<p class="hint">⚠️ Notifications are blocked for this app in your device settings. Allow them there, then come back and tap Enable.</p>` : ''}
      ${!standalone ? `<button class="btn secondary" id="show-install-help" style="margin-top:12px">📲 How to install on your phone</button>` : ''}
    </div>

    <div class="section-title">Account</div>
    <div class="card">
      <button class="btn danger" id="logout">Sign out</button>
    </div>
  `);
  document.querySelectorAll('[data-theme-opt]').forEach((b) => {
    b.onclick = () => { applyTheme(b.dataset.themeOpt); renderSettings(); };
  });
  document.getElementById('push-toggle').onclick = async () => {
    try { enabled ? await disablePush() : await enablePush(); } catch (err) { toast(err.message); }
    renderSettings();
  };
  const test = document.getElementById('push-test');
  if (test) test.onclick = () => api('/api/push/test', { method: 'POST' }).then(() => toast('Test sent — check your notifications'));
  const installHelp = document.getElementById('show-install-help');
  if (installHelp) installHelp.onclick = () => showInstallModal();
  document.getElementById('logout').onclick = signOut;
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
      ${state.me.role === 'admin' ? `
        ${!entry && shifts.length ? `
        <label>Clock in for job (optional)</label>
        <select id="clock-shift">
          <option value="">General work</option>
          ${shifts.map((s) => `<option value="${s.id}">${esc(s.title)} (${fmtTime(s.starts_at)})</option>`).join('')}
        </select>` : ''}
        <button class="btn ${entry ? 'danger' : ''}" id="clock-btn" style="margin-top:16px">
          ${entry ? 'Clock out' : 'Clock in'}
        </button>
        <p class="hint" style="text-align:center">Punching requires your PIN. Your location is recorded if you allow it.</p>
      ` : `
        <p class="hint" style="text-align:center;margin-top:14px">🔒 Clock in and out <b>at the kiosk</b> with your PIN.<br>Your punches show up here automatically.</p>
      `}
    </div>
    <button class="btn secondary" id="request-hours-btn">🕐 Request hours for approval</button>

    <div class="section-title">This week · ${fmtDur(weekMs)} total</div>
    ${weekAgoEntries.length ? weekAgoEntries.map((e) => `
      <div class="card row">
        <span class="grow">
          <div style="font-weight:700">${fmtDay(e.clock_in)}</div>
          <div class="sub">${fmtTime(e.clock_in)} – ${e.clock_out ? fmtTime(e.clock_out) : 'now'}${e.shift_title ? ` · ${esc(e.shift_title)}` : ''}${e.role_name ? ` · ${esc(e.role_name)}` : ''}${e.venue_name ? ` · 📍 ${esc(e.venue_name)}` : ''}${e.mileage ? ` · 🚗 ${e.mileage} mi` : ''}</div>
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
  const clockBtn = document.getElementById('clock-btn');
  if (clockBtn) clockBtn.onclick = () => {
    const shiftSel = document.getElementById('clock-shift');
    const shiftId = shiftSel?.value ? Number(shiftSel.value) : null;
    const shift = shifts.find((s) => s.id === shiftId) || shifts[0] || null;
    openPinPad(entry ? 'Enter your PIN to clock out' : 'Enter your PIN to clock in', async (pin) => {
      if (!entry) {
        const loc = await getLocation();
        await api('/api/time/clock-in', {
          method: 'POST',
          body: { ...loc, pin, shift_id: shiftId, venue_id: shift?.venue_id || null, role_id: shift?.role_id || null },
        });
        closeModal();
        toast('Clocked in ✅');
        render();
        return;
      }
      closeModal();
      openClockoutForm({
        title: 'Clock out',
        entry, shift,
        onSubmit: async (fields) => {
          const loc = await getLocation();
          await api('/api/time/clock-out', { method: 'POST', body: { ...loc, pin, ...fields } });
          toast('Clocked out 👋');
          render();
        },
      });
    });
  };
  document.getElementById('request-hours-btn').onclick = () => openHourRequestModal();
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
    const u = byUser.get(e.user_id) || { name: e.user_name, color: e.user_color, ms: 0, mileage: 0, entries: [] };
    u.ms += (e.clock_out ? new Date(e.clock_out) : new Date()) - new Date(e.clock_in);
    u.mileage += e.mileage || 0;
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
            <div class="sub"><b>${fmtDur(u.ms)}</b>${u.mileage ? ` · 🚗 ${u.mileage.toFixed(1)} mi` : ''}</div>
          </span>
        </div>
        ${u.entries.map((e) => `
          <div class="row ts-entry" data-entry="${e.id}">
            <span class="grow sub">${fmtDay(e.clock_in)} · ${fmtTime(e.clock_in)} – ${e.clock_out ? fmtTime(e.clock_out) : 'open'}
              ${e.shift_title ? `· ${esc(e.shift_title)}` : ''}${e.role_name ? ` · ${esc(e.role_name)}` : ''}${e.venue_name ? ` · 📍${esc(e.venue_name)}` : ''}${e.mileage ? ` · 🚗 ${e.mileage} mi` : ''}
              ${e.in_lat ? `<a href="https://maps.google.com/?q=${e.in_lat},${e.in_lng}" target="_blank" onclick="event.stopPropagation()">📍</a>` : ''}
            </span>
            <span style="font-weight:600;font-size:13px">${fmtDur((e.clock_out ? new Date(e.clock_out) : new Date()) - new Date(e.clock_in))}</span>
            <button class="icon-btn" data-approve="${e.id}" data-approved="${e.approved}" title="${e.approved ? 'Approved — tap to unapprove' : 'Tap to approve'}">${e.approved ? '✅' : '⬜'}</button>
          </div>`).join('')}
      </div>`).join('') : '<div class="empty"><div class="big">🧾</div>No time entries this week</div>'}
    <button class="btn" id="ts-export" style="margin-top:10px">⬇️ Export hours CSV (${rangeLabel})</button>
    <p class="hint">The CSV lists every punch with hours, job, venue and mileage, plus per-person totals.</p>
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
            <div class="sub">
              ${f.fields.length} question${f.fields.length === 1 ? '' : 's'}${f.require_signature ? ' · signature required' : ''}
              ${isAdmin ? `<br><b>${f.signed_count} of ${f.headcount}</b> completed` : (f.my_submissions ? '<br>✅ You completed this' : '<br>⏳ Awaiting your signature')}
            </div>
          </span>
        </div>
        <div class="shift-actions">
          <button class="btn small" data-fill="${f.id}">${f.my_submissions ? 'Sign again' : (f.require_signature ? 'Review & sign' : 'Fill in')}</button>
          <button class="btn small secondary" data-subs="${f.id}">${isAdmin ? 'Completions' : 'My copies'}</button>
          ${isAdmin ? `<button class="btn small danger" data-del-form="${f.id}">Delete</button>` : ''}
        </div>
      </div>`).join('') : `<div class="empty"><div class="big">📋</div>No forms yet${isAdmin ? '<br>Tap ＋ to build one (waivers, policies, checklists…)' : ''}</div>`}
  `, { back: () => { location.hash = '#/more'; }, fab: isAdmin });

  if (isAdmin) document.getElementById('fab').onclick = openFormBuilder;
  document.querySelectorAll('[data-fill]').forEach((b) => {
    b.onclick = () => openFormFill(forms.find((f) => f.id === Number(b.dataset.fill)));
  });
  document.querySelectorAll('[data-subs]').forEach((b) => {
    b.onclick = () => (state.me.role === 'admin' ? openFormStatus(Number(b.dataset.subs)) : openSubmissions(Number(b.dataset.subs)));
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
      ${form.require_signature ? `
        <div class="sign-block">
          <div class="sign-head">Signature</div>
          <label>Type your full legal name</label>
          <input name="signed_name" required autocomplete="name" placeholder="Jane Doe" value="${esc(state.me.name)}">
          <label>Draw your signature</label>
          <div class="sign-pad-wrap">
            <canvas id="sign-pad" class="sign-pad"></canvas>
            <button type="button" class="sign-clear" id="sign-clear">Clear</button>
          </div>
          <p class="hint">By signing you agree this electronic signature is the legal equivalent of your handwritten signature on this document.</p>
        </div>` : ''}
      <div class="actions"><button type="submit" class="btn">${form.require_signature ? 'Sign & submit' : 'Submit'}</button></div>
    </form>
  `);

  let pad = null;
  if (form.require_signature) pad = initSignaturePad(modal.querySelector('#sign-pad'), modal.querySelector('#sign-clear'));

  modal.querySelector('#fill-form').onsubmit = async (e) => {
    e.preventDefault();
    const answers = {};
    for (const f of form.fields) {
      const el = e.target.elements[`f${f.id}`];
      answers[f.id] = f.type === 'checkbox' ? el.checked : el.value;
    }
    const body = { answers };
    if (form.require_signature) {
      if (pad.isEmpty()) return toast('Please draw your signature');
      body.signature = pad.toDataURL();
      body.signed_name = e.target.elements.signed_name.value;
    }
    try {
      await api(`/api/forms/${form.id}/submit`, { method: 'POST', body });
      closeModal(); toast(form.require_signature ? 'Signed ✅' : 'Submitted ✅');
      render();
    } catch (err) { toast(err.message); }
  };
}

// Finger/mouse signature capture on a canvas sized to its container.
function initSignaturePad(canvas, clearBtn) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * ratio;
  canvas.height = rect.height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111';

  let drawing = false;
  let dirty = false;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  };
  const start = (e) => { e.preventDefault(); drawing = true; const { x, y } = pos(e); ctx.beginPath(); ctx.moveTo(x, y); };
  const move = (e) => {
    if (!drawing) return;
    e.preventDefault();
    const { x, y } = pos(e);
    ctx.lineTo(x, y); ctx.stroke();
    dirty = true;
  };
  const end = () => { drawing = false; };

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);

  clearBtn.onclick = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; };

  return {
    isEmpty: () => !dirty,
    // Flatten onto white so the PNG reads correctly in the PDF.
    toDataURL: () => {
      const out = document.createElement('canvas');
      out.width = canvas.width; out.height = canvas.height;
      const octx = out.getContext('2d');
      octx.fillStyle = '#fff';
      octx.fillRect(0, 0, out.width, out.height);
      octx.drawImage(canvas, 0, 0);
      return out.toDataURL('image/png');
    },
  };
}

// Admin view: who has completed a form, with per-person PDF downloads.
async function openFormStatus(formId) {
  const { form, people } = await api(`/api/forms/${formId}/status`);
  const done = people.filter((p) => p.submission_id);
  const modal = openModal(`
    <h3>${esc(form.title)}</h3>
    <p class="sub"><b>${done.length} of ${people.length}</b> completed</p>
    <div class="detail-people" style="margin-top:12px">
      ${people.map((p) => `
        <div class="row detail-person">
          <span class="avatar lg" style="background:${esc(p.color)}">${esc(initials(p.name))}</span>
          <span class="grow">
            <div style="font-weight:700">${esc(p.name)}</div>
            <div class="sub ${p.submission_id ? 'accepted' : 'pending'}">
              ${p.submission_id ? `✓ ${p.signed_at ? 'Signed' : 'Submitted'} ${fmtWhen(p.created_at)}` : '• Not completed yet'}
            </div>
          </span>
          ${p.submission_id ? `<button class="btn small secondary" data-pdf="${p.submission_id}">PDF</button>` : ''}
        </div>`).join('')}
    </div>
    <div class="actions">
      <button class="btn secondary" id="status-close">Close</button>
      ${done.length ? `<button class="btn" id="download-all">Download all (${done.length})</button>` : ''}
    </div>
  `);
  modal.querySelector('#status-close').onclick = closeModal;
  modal.querySelectorAll('[data-pdf]').forEach((b) => {
    b.onclick = () => window.open(`/api/forms/${formId}/submissions/${b.dataset.pdf}/pdf`, '_blank');
  });
  const all = modal.querySelector('#download-all');
  if (all) all.onclick = () => {
    // Staggered so the browser does not swallow the batch as a popup flood.
    done.forEach((p, i) => setTimeout(
      () => window.open(`/api/forms/${formId}/submissions/${p.submission_id}/pdf`, '_blank'), i * 400));
  };
}

async function openSubmissions(formId) {
  const { form, submissions } = await api(`/api/forms/${formId}/submissions`);
  const modal = openModal(`
    <h3>${esc(form.title)} — submissions</h3>
    ${submissions.length ? submissions.map((s) => `
      <div class="card" style="box-shadow:none;border:1px solid var(--line)">
        <div class="row" style="margin-bottom:6px">
          <span class="avatar" style="background:${esc(s.user_color || '#888')}">${esc(initials(s.user_name || '?'))}</span>
          <b>${esc(s.user_name || 'Removed user')}</b>
          <span class="sub" style="margin-left:auto">${fmtWhen(s.created_at)}</span>
        </div>
        ${form.fields.map((f) => `<div class="sub" style="margin:3px 0"><b>${esc(f.label)}:</b> ${f.type === 'checkbox' ? (s.answers[f.id] ? '✅ yes' : '⬜ no') : esc(s.answers[f.id] || '—')}</div>`).join('')}
        <button class="btn small secondary" data-pdf="${s.id}" style="margin-top:8px">⬇️ Download PDF</button>
      </div>`).join('') : '<p class="sub" style="margin-top:10px">No submissions yet.</p>'}
    <div class="actions"><button class="btn secondary" id="subs-close">Close</button></div>
  `);
  modal.querySelector('#subs-close').onclick = closeModal;
  modal.querySelectorAll('[data-pdf]').forEach((b) => {
    b.onclick = () => window.open(`/api/forms/${formId}/submissions/${b.dataset.pdf}/pdf`, '_blank');
  });
}

function openFormBuilder() {
  const fields = [];
  const modal = openModal(`
    <h3>New form</h3>
    <form id="form-builder">
      <label>Form title</label><input name="title" required placeholder="e.g. End-of-shift checklist">
      <label>Description (optional)</label><input name="description" placeholder="Shown to the team above the questions">
      <label class="check-label"><input type="checkbox" name="require_signature" checked style="width:auto"> Require a signature to complete</label>
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
        body: {
          title: fd.get('title'),
          description: fd.get('description') || '',
          require_signature: !!fd.get('require_signature'),
          fields,
        },
      });
      closeModal(); toast('Form published — team notified');
      render();
    } catch (err) { toast(err.message); }
  };
}

/* ------------------------------ hours requests ------------------------------ */

function openHourRequestModal() {
  const today = dateKey(new Date());
  const modal = openModal(`
    <h3>Request hours</h3>
    <p class="sub">For time you worked but didn't clock — sent to a manager for approval.</p>
    <form id="hours-form">
      <label>Venue / job</label>
      <select name="venue_id">
        <option value="">No venue</option>
        ${state.venues.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}
      </select>
      <label>Job</label>
      <select name="role_id">
        <option value="">No job</option>
        ${state.roles.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}
      </select>
      <label>Date</label><input name="date" type="date" required value="${today}">
      <div style="display:flex;gap:10px">
        <span style="flex:1"><label>Starts</label><input name="start" type="time" required value="09:00"></span>
        <span style="flex:1"><label>Ends</label><input name="end" type="time" required value="17:00"></span>
      </div>
      <label>Note (optional)</label><textarea name="note" rows="2" placeholder="Attach a note to your request…"></textarea>
      <p class="hint">All requests are sent for a manager's approval.</p>
      <div class="actions"><button type="submit" class="btn">Send for approval</button></div>
    </form>
  `);
  modal.querySelector('#hours-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const starts = new Date(`${fd.get('date')}T${fd.get('start')}`);
    let ends = new Date(`${fd.get('date')}T${fd.get('end')}`);
    if (ends <= starts) ends = new Date(ends.getTime() + 24 * 3600000); // overnight shift
    try {
      await api('/api/hour-requests', {
        method: 'POST',
        body: {
          venue_id: fd.get('venue_id') ? Number(fd.get('venue_id')) : null,
          role_id: fd.get('role_id') ? Number(fd.get('role_id')) : null,
          starts_at: starts.toISOString(),
          ends_at: ends.toISOString(),
          note: fd.get('note') || '',
        },
      });
      closeModal(); toast('Sent for approval ✅');
      if (route().view === 'hours') render();
    } catch (err) { toast(err.message); }
  };
}

async function renderHours() {
  const { requests } = await api('/api/hour-requests');
  const isAdmin = state.me.role === 'admin';
  const pending = requests.filter((r) => r.status === 'pending');
  const rest = requests.filter((r) => r.status !== 'pending');

  const reqCard = (r) => {
    const hours = ((new Date(r.ends_at) - new Date(r.starts_at)) / 3600000).toFixed(1);
    return `
    <div class="card row">
      <span style="font-size:24px">🕐</span>
      <span class="grow">
        <div style="font-weight:700">${isAdmin ? esc(r.user_name) + ' · ' : ''}${hours}h</div>
        <div class="sub">${fmtDay(r.starts_at)} · ${fmtTime(r.starts_at)} – ${fmtTime(r.ends_at)}</div>
        ${r.venue_name || r.role_name ? `<div class="sub">${[r.role_name, r.venue_name].filter(Boolean).map(esc).join(' @ ')}</div>` : ''}
        ${r.note ? `<div class="sub">${esc(r.note)}</div>` : ''}
      </span>
      ${r.status === 'pending' && isAdmin ? `
        <button class="btn small" data-decide-hours="approved" data-id="${r.id}">✓</button>
        <button class="btn small danger" data-decide-hours="denied" data-id="${r.id}">✗</button>` : `
        <span class="status-tag ${r.status}">${r.status}</span>`}
      ${r.status === 'pending' && !isAdmin && r.user_id === state.me.id ? `<button class="icon-btn" data-cancel-hours="${r.id}" title="Withdraw">🗑️</button>` : ''}
    </div>`;
  };

  shell('Hours Requests', `
    ${pending.length ? `<div class="section-title">Pending${isAdmin ? ' approval' : ''}</div>${pending.map(reqCard).join('')}` : ''}
    <div class="section-title">History</div>
    ${rest.length ? rest.map(reqCard).join('') : '<div class="empty"><div class="big">🕐</div>No hours requests yet.<br>Approved requests land straight in the timesheet.</div>'}
  `, { back: () => { location.hash = '#/more'; }, fab: true });

  document.getElementById('fab').onclick = () => openHourRequestModal();
  document.querySelectorAll('[data-decide-hours]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/hour-requests/${b.dataset.id}/decide`, { method: 'POST', body: { status: b.dataset.decideHours } });
      toast(b.dataset.decideHours === 'approved' ? 'Approved — added to the timesheet' : 'Request denied');
      render();
    };
  });
  document.querySelectorAll('[data-cancel-hours]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/hour-requests/${b.dataset.cancelHours}`, { method: 'DELETE' });
      render();
    };
  });
}

/* ---------------------------------- roles ----------------------------------- */

async function renderRoles() {
  if (state.me.role !== 'admin') { location.hash = '#/more'; return; }
  const { roles } = await api('/api/roles');
  state.roles = roles;
  shell('Jobs', `
    <p class="hint" style="margin-bottom:12px">Jobs your team works (Server, Bar Back, Set Up…). Used when scheduling and when clocking out. Team positions are managed separately in <b>Positions</b>.</p>
    ${roles.length ? roles.map((r) => `
      <div class="card row">
        <span class="venue-icon" style="background:var(--brand-soft);color:var(--text)">🧑‍🍳</span>
        <span class="grow" style="font-weight:700">${esc(r.name)}</span>
        <button class="icon-btn" data-edit-role="${r.id}">✏️</button>
        <button class="icon-btn" data-del-role="${r.id}">🗑️</button>
      </div>`).join('') : '<div class="empty"><div class="big">🧑‍🍳</div>No jobs yet — tap ＋ to add Server, Bar Back, Set Up…</div>'}
  `, { back: () => { location.hash = '#/more'; }, fab: true });

  document.getElementById('fab').onclick = async () => {
    const name = prompt('New job name (e.g. Server, Bar Back):');
    if (!name?.trim()) return;
    await api('/api/roles', { method: 'POST', body: { name } });
    render();
  };
  document.querySelectorAll('[data-edit-role]').forEach((b) => {
    b.onclick = async () => {
      const role = roles.find((r) => r.id === Number(b.dataset.editRole));
      const name = prompt('Rename job:', role.name);
      if (!name?.trim() || name === role.name) return;
      await api(`/api/roles/${role.id}`, { method: 'PATCH', body: { name } });
      render();
    };
  });
  document.querySelectorAll('[data-del-role]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this job? Past timesheet entries keep their label.')) return;
      await api(`/api/roles/${b.dataset.delRole}`, { method: 'DELETE' });
      render();
    };
  });
}

/* -------------------------------- positions --------------------------------- */

async function renderPositions() {
  if (state.me.role !== 'admin') { location.hash = '#/more'; return; }
  const { positions } = await api('/api/positions');
  state.positions = positions;
  shell('Positions', `
    <p class="hint" style="margin-bottom:12px">Team positions you assign in <b>Team</b>. A position with <b>admin permission</b> automatically makes everyone holding it an admin.</p>
    ${positions.length ? positions.map((r) => `
      <div class="card row">
        <span class="grow">
          <div style="font-weight:700">${esc(r.name)}</div>
          <div class="sub">${r.is_admin ? 'Grants admin access' : 'Member access'}</div>
        </span>
        <button class="btn small ${r.is_admin ? '' : 'secondary'}" data-adm-pos="${r.id}">${r.is_admin ? 'Admin ✓' : 'Member'}</button>
        <button class="icon-btn" data-edit-pos="${r.id}">✏️</button>
        <button class="icon-btn" data-del-pos="${r.id}">🗑️</button>
      </div>`).join('') : '<div class="empty"><div class="big">👥</div>No positions yet — tap ＋ to add e.g. Operations Manager, Shift Lead…</div>'}
  `, { back: () => { location.hash = '#/more'; }, fab: true });

  document.getElementById('fab').onclick = async () => {
    const name = prompt('New position name (e.g. Operations Manager, Shift Lead):');
    if (!name?.trim()) return;
    const is_admin = confirm('Should this position have ADMIN permission?\n\nAdmins can manage the schedule, venues, payroll, and approvals.\n\nOK = admin · Cancel = member');
    await api('/api/positions', { method: 'POST', body: { name, is_admin } });
    render();
  };
  document.querySelectorAll('[data-adm-pos]').forEach((b) => {
    b.onclick = async () => {
      const position = positions.find((r) => r.id === Number(b.dataset.admPos));
      const grant = !position.is_admin;
      if (!confirm(grant
        ? `Give ADMIN permission to "${position.name}"? Everyone holding it becomes an admin.`
        : `Remove admin permission from "${position.name}"? Everyone holding it becomes a regular member.`)) return;
      try {
        await api(`/api/positions/${position.id}`, { method: 'PATCH', body: { is_admin: grant } });
        toast(grant ? 'Position now grants admin access' : 'Position is member-level now');
      } catch (err) { toast(err.message); }
      state.users = (await api('/api/users')).users;
      render();
    };
  });
  document.querySelectorAll('[data-edit-pos]').forEach((b) => {
    b.onclick = async () => {
      const position = positions.find((r) => r.id === Number(b.dataset.editPos));
      const name = prompt('Rename position:', position.name);
      if (!name?.trim() || name === position.name) return;
      await api(`/api/positions/${position.id}`, { method: 'PATCH', body: { name } });
      render();
    };
  });
  document.querySelectorAll('[data-del-pos]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this position? People holding it keep their current access level.')) return;
      await api(`/api/positions/${b.dataset.delPos}`, { method: 'DELETE' });
      state.users = (await api('/api/users')).users;
      render();
    };
  });
}

/* ---------------------------------- kiosk ----------------------------------- */

// Armed kiosk but no valid session (cookie expired / cleared): admin PIN re-activates.
function renderKioskUnlock() {
  $app.innerHTML = `
    <div class="kiosk-wrap">
      <img src="/brand/logo.png" alt="E&amp;E Management" style="max-width:200px;margin-bottom:6px">
      <h2 style="margin-bottom:2px">Kiosk locked</h2>
      <p class="sub">Enter an admin PIN to reactivate this kiosk</p>
      ${pinPadHTML()}
    </div>`;
  bindPinPad(document.querySelector('.kiosk-wrap'), async (pin) => {
    await api('/api/kiosk/arm', { method: 'POST', body: { pin } });
    await bootstrap();
  });
}

function kioskVenue() {
  try { return JSON.parse(localStorage.getItem('ee-kiosk-venue') || 'null'); } catch { return null; }
}

// After the admin PIN is accepted: which hall/venue is this kiosk at?
function pickKioskVenue(onDone) {
  const modal = openModal(`
    <h3>Which venue is this kiosk for?</h3>
    <p class="sub">It's shown on the kiosk and used as the default venue for punches.</p>
    <div class="assignee-list" style="margin-top:10px">
      ${state.venues.map((v) => `
        <button type="button" class="opt" data-kv="${v.id}" data-name="${esc(v.name)}">
          <span class="venue-icon" style="background:${esc(v.color)};width:30px;height:30px;font-size:14px">📍</span>
          ${esc(v.name)}
        </button>`).join('')}
      <button type="button" class="opt" data-kv="" data-name="">
        <span class="venue-icon" style="background:var(--brand-soft);color:var(--text);width:30px;height:30px;font-size:14px">—</span>
        No specific venue
      </button>
    </div>
  `);
  modal.querySelectorAll('[data-kv]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.kv) localStorage.setItem('ee-kiosk-venue', JSON.stringify({ id: Number(b.dataset.kv), name: b.dataset.name }));
      else localStorage.removeItem('ee-kiosk-venue');
      closeModal();
      onDone();
    };
  });
}

// The clock-out summary popup: time tally, venue, job, mileage, note.
// Members see the venue but can't change it — only admins can.
function openClockoutForm({ title, entry, shift, lockVenue = false, onSubmit }) {
  const defVenue = kioskVenue()?.id || entry.venue_id || shift?.venue_id || '';
  const defRole = entry.role_id || shift?.role_id || '';
  const elapsed = fmtDur(Date.now() - new Date(entry.clock_in));
  const modal = openModal(`
    <h3>${esc(title)}</h3>
    <div class="clockout-tally">⏱️ ${elapsed} <span class="sub">since ${fmtTime(entry.clock_in)}</span></div>
    <form id="clockout-form">
      <label>Venue${lockVenue ? ' <span class="lock-note">🔒 set by admin</span>' : ''}</label>
      <select name="venue_id" id="co-venue" ${lockVenue ? 'disabled' : ''}>
        <option value="">No venue</option>
        ${state.venues.map((v) => `<option value="${v.id}" ${defVenue === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}
      </select>
      <label>Job</label>
      <select name="role_id" id="co-role">
        <option value="">No job</option>
        ${state.roles.map((r) => `<option value="${r.id}" ${defRole === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
      </select>
      <label>Mileage (miles, optional)</label>
      <input name="mileage" id="co-mileage" type="number" min="0" step="0.1" inputmode="decimal" placeholder="0">
      <label>Note (optional)</label>
      <textarea name="note" id="co-note" rows="2" placeholder="Anything to report from this shift…"></textarea>
      <div class="actions">
        <button type="button" class="btn secondary" id="clockout-cancel">Cancel</button>
        <button type="submit" class="btn">Confirm clock out</button>
      </div>
    </form>
  `);
  modal.querySelector('#clockout-cancel').onclick = closeModal;
  modal.querySelector('#clockout-form').onsubmit = async (e) => {
    e.preventDefault();
    // Read elements directly: a disabled (locked) venue select still submits its value.
    const val = (id) => modal.querySelector(`#${id}`).value;
    try {
      await onSubmit({
        venue_id: val('co-venue') ? Number(val('co-venue')) : null,
        role_id: val('co-role') ? Number(val('co-role')) : null,
        mileage: val('co-mileage') ? Number(val('co-mileage')) : null,
        note: val('co-note') || '',
      });
      closeModal();
    } catch (err) { toast(err.message); }
  };
}

function renderKiosk() {
  if (!kioskArmed()) {
    // Arming screen (reached from More): an admin PIN locks this device into kiosk mode.
    if (state.me.role !== 'admin') { location.hash = '#/more'; return; }
    $app.innerHTML = `
      <div class="kiosk-wrap">
        <img src="/brand/logo.png" alt="E&amp;E Management" style="max-width:200px;margin-bottom:6px">
        <h2 style="margin-bottom:2px">Set up Kiosk Mode</h2>
        <p class="sub" style="max-width:300px">This device will stay locked as a time-clock kiosk — even after closing the app — until an admin PIN is entered again. Team members punch in and out with their own PINs.</p>
        <p class="sub" style="margin-top:10px"><b>Enter an admin PIN to activate</b></p>
        ${pinPadHTML()}
        <button class="btn secondary" id="kiosk-cancel" style="max-width:200px;margin-top:22px">Cancel</button>
      </div>`;
    document.getElementById('kiosk-cancel').onclick = () => { location.hash = '#/more'; };
    bindPinPad(document.querySelector('.kiosk-wrap'), async (pin) => {
      await api('/api/kiosk/arm', { method: 'POST', body: { pin } });
      pickKioskVenue(() => {
        localStorage.setItem('ee-kiosk', '1');
        toast('Kiosk mode activated 🔒');
        render();
      });
    });
    return;
  }

  // Armed: full-screen punch pad. Exiting requires an admin PIN again.
  const kv = kioskVenue();
  $app.innerHTML = `
    <div class="kiosk-wrap">
      <img src="/brand/logo.png" alt="E&amp;E Management" style="max-width:200px;margin-bottom:6px">
      <h2 style="margin-bottom:2px">Time Clock Kiosk</h2>
      <p class="sub">Enter your PIN to clock in or out</p>
      <div id="kiosk-result"></div>
      ${pinPadHTML()}
      ${kv?.name ? `<div class="kiosk-venue">📍 ${esc(kv.name)}</div>` : ''}
      <button id="kiosk-exit" class="kiosk-exit">🔒 Admin exit</button>
    </div>`;
  document.getElementById('kiosk-exit').onclick = () => {
    openPinPad('Enter an admin PIN to exit kiosk mode', async (pin) => {
      await api('/api/kiosk/arm', { method: 'POST', body: { pin } });
      localStorage.removeItem('ee-kiosk');
      localStorage.removeItem('ee-kiosk-venue');
      closeModal();
      toast('Kiosk mode off');
      location.hash = '#/more';
      await bootstrap();
    });
  };

  let resultTimer;
  const showBanner = (name, action, at) => {
    const box = document.getElementById('kiosk-result');
    if (!box) return;
    box.innerHTML = `<div class="kiosk-banner ${action}">
      ${action === 'in' ? '✅' : '👋'} <b>${esc(name)}</b> clocked <b>${action.toUpperCase()}</b> at ${fmtTime(at)}
    </div>`;
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => { box.innerHTML = ''; }, 4000);
  };

  bindPinPad(document.querySelector('.kiosk-wrap'), async (pin) => {
    const { user, entry, shift } = await api('/api/kiosk/status', { method: 'POST', body: { pin } });
    if (!entry) {
      // Clock in right away, tagged with the kiosk venue and any scheduled sub-job.
      const loc = await getLocation();
      const { name, action, at } = await api('/api/kiosk/punch', {
        method: 'POST',
        body: { ...loc, pin, venue_id: kv?.id || shift?.venue_id || null, role_id: shift?.role_id || null, shift_id: shift?.id || null },
      });
      showBanner(name, action, at);
    } else {
      // Clock out goes through the summary popup.
      openClockoutForm({
        title: `Clock out — ${user.name}`,
        entry, shift,
        lockVenue: user.role !== 'admin',
        onSubmit: async (fields) => {
          const loc = await getLocation();
          const { name, action, at } = await api('/api/kiosk/punch', { method: 'POST', body: { ...loc, pin, ...fields } });
          showBanner(name, action, at);
        },
      });
    }
  });
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
    { href: '#/hours', icon: '🕐', label: 'Hours Requests', sub: 'Submit worked hours for approval' },
    { href: '#/forms', icon: '📋', label: 'Forms', sub: 'Review, sign & download documents' },
    ...(isAdmin ? [
      { href: '#/timesheets', icon: '🧾', label: 'Timesheets', sub: 'Hours, approval & payroll CSV' },
      { href: '#/kiosk', icon: '🔢', label: 'Kiosk Mode', sub: 'Lock this device into a PIN punch clock' },
      { href: '#/roles', icon: '🧑‍🍳', label: 'Jobs', sub: 'Server, Bar Back, Set Up… (clock-outs & scheduling)' },
      { href: '#/positions', icon: '👥', label: 'Positions', sub: 'Team positions & admin permissions' },
    ] : []),
    { href: '#/venues', icon: '📍', label: 'Venues', sub: 'Work locations' },
    { href: '#/team', icon: '👥', label: 'Team', sub: 'People & roles' },
    { href: '#/notifications', icon: '🔔', label: 'Notifications', sub: 'Your activity feed' },
    { href: '#/settings', icon: '⚙️', label: 'Settings', sub: 'Notifications & account' },
  ];
  shell('More', `
    <img src="/brand/logo.png" alt="E&amp;E Management" style="display:block;max-width:190px;margin:2px auto 16px">
    <div class="card row" style="margin-bottom:16px">
      <span class="avatar lg" style="background:${esc(state.me.color)}">${esc(initials(state.me.name))}</span>
      <span class="grow">
        <div style="font-weight:700">${esc(state.me.name)}</div>
        <div class="sub">${esc(contactOf(state.me))}</div>
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
  clearInterval(state.timer);
  // A device armed as a kiosk shows only the kiosk, whatever the URL says.
  if (kioskArmed()) {
    if (!state.me) return renderKioskUnlock();
    return renderKiosk();
  }
  if (!state.me) return renderAuth();
  const { view, arg } = route();
  try {
    if (view === 'schedule') renderSchedule();
    else if (view === 'chat' && arg) await renderChat(arg);
    else if (view === 'chat') await renderChatList();
    else if (view === 'clock') await renderClock();
    else if (view === 'kiosk') renderKiosk();
    else if (view === 'hours') await renderHours();
    else if (view === 'roles') await renderRoles();
    else if (view === 'positions') await renderPositions();
    else if (view === 'timesheets') await renderTimesheets();
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
  const [me, users, venues, roles, positions, channels, notifs] = await Promise.all([
    api('/api/me'), api('/api/users'), api('/api/venues'), api('/api/roles'), api('/api/positions'), api('/api/channels'), api('/api/notifications'),
  ]);
  state.me = me.user;
  state.vapidPublicKey = me.vapidPublicKey;
  state.users = users.users;
  state.venues = venues.venues;
  state.roles = roles.roles;
  state.positions = positions.positions;
  state.channels = channels.channels;
  state.notifications = notifs.notifications;
  connectEvents();
  await loadShifts();
  if (!location.hash) location.hash = '#/schedule';
  render();
  setTimeout(maybeShowOnboarding, 600);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

api('/api/me')
  .then(() => bootstrap())
  .catch(() => renderAuth());
