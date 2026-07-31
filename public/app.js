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
  attire: [],
  settings: {},
  channels: [],
  notifications: [],
  authMode: 'login',
  weekStart: startOfWeek(new Date()),
  selectedDay: dateKey(new Date()),
  scheduleFilter: 'all', // 'all' | 'mine'
  scheduleView: 'day',   // 'day' | 'week'
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
  if (!iso) return '';
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
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    Object.assign(err, data);
    throw err;
  }
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
    hours: ['hours'], roles: ['roles'], positions: ['positions', 'team'], users: ['team'], settings: ['timesheets'],
    attire: ['attire', 'schedule'], availability: ['availability', 'schedule'],
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
  const updatesBtn = document.querySelector('[data-tab="updates"]');
  if (updatesBtn) {
    const badge = updatesBtn.querySelector('.tab-badge');
    const n = unreadNotifCount();
    if (n && !badge) updatesBtn.insertAdjacentHTML('beforeend', `<span class="tab-badge">${n}</span>`);
    else if (n && badge) badge.textContent = n;
    else badge?.remove();
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
        const { user, pin, payroll_match: match } = await api('/api/auth/register', {
          method: 'POST',
          body: { name: fd.get('name'), phone: fd.get('phone') },
        });
        state.me = user;
        if (match) showPayrollConfirm(match, pin, user);
        else showPinReveal(pin, user.role === 'admin');
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

// Payroll already lists someone with this name — make the new account confirm
// it before their Paychex Worker ID is attached.
function showPayrollConfirm(match, pin, user) {
  $app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card" style="text-align:center">
        <img class="auth-brand" src="/brand/logo.png" alt="E&amp;E Management">
        <div style="font-size:40px;margin:6px 0 2px">🧾</div>
        <h3>Is this you?</h3>
        <p class="auth-sub">Our payroll records list an employee as</p>
        <div class="payroll-name">${esc(match.display_name)}</div>
        <p class="auth-sub">Confirm only if that is you, so your hours reach the right payroll record.</p>
        <button class="btn" id="payroll-yes">Yes, that's me</button>
        <button class="btn secondary" id="payroll-no" style="margin-top:10px">No, that's someone else</button>
      </div>
    </div>`;
  const finish = async (confirm) => {
    try { await api('/api/me/payroll-match', { method: 'POST', body: { confirm } }); }
    catch { /* the admin can always set the Worker ID by hand */ }
    showPinReveal(pin, user.role === 'admin');
  };
  document.getElementById('payroll-yes').onclick = () => finish(true);
  document.getElementById('payroll-no').onclick = () => finish(false);
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
  { id: 'availability', icon: '📗', label: 'Availability' },
  { id: 'clock', icon: '⏱️', label: 'Clock' },
  { id: 'updates', icon: '📢', label: 'Updates' },
  { id: 'more', icon: '☰', label: 'More' },
];

// Views that live under the "More" hub still highlight the More tab.
const MORE_VIEWS = ['more', 'venues', 'team', 'forms', 'signed', 'place', 'timesheets', 'settings', 'notifications', 'hours', 'roles', 'positions', 'attire'];

function tabbarHTML(active, extraClass = '') {
  return `
    <nav class="tabbar ${extraClass}">
      ${TABS.map((t) => `
        <button data-tab="${t.id}" class="${active === t.id ? 'active' : ''}">
          <span class="tab-icon">${t.icon}</span>${t.label}
        </button>`).join('')}
    </nav>`;
}

function bindTabbar() {
  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { location.hash = `#/${b.dataset.tab}`; };
  });
}

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
      <button class="icon-btn" id="signout-btn" title="Sign out">⏻</button>
    </header>` : ''}
    <div class="main" id="main">${contentHTML}</div>
    ${fab ? `<button class="fab" id="fab">＋</button>` : ''}
    ${tabbarHTML(view)}`;
  bindTabbar();
  const backBtn = document.getElementById('back-btn');
  if (backBtn) backBtn.onclick = back;
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
      <span style="flex:1"></span>
      <button class="pill ${state.scheduleView === 'week' ? 'active' : ''}" id="view-toggle">${state.scheduleView === 'week' ? '📅 Week' : '📋 Day'}</button>
    </div>
    ${state.scheduleView === 'week' ? weekGridHTML(days, byDay) : (dayShifts.length ? dayShifts.map(shiftCardHTML).join('') : `
      <div class="empty"><div class="big">🗓️</div>No jobs scheduled for this day${isAdmin ? '<br>Tap ＋ to add one' : ''}</div>`)}
  `, { fab: isAdmin });

  document.getElementById('view-toggle').onclick = () => {
    state.scheduleView = state.scheduleView === 'week' ? 'day' : 'week';
    render();
  };

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
  state.shiftsIndex = state.shifts;
  document.querySelectorAll('[data-respond]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/shifts/${b.dataset.shiftId}/respond`, { method: 'POST', body: { status: b.dataset.respond } });
      toast(b.dataset.respond === 'accepted' ? 'Job accepted ✅' : 'Job declined');
      loadShifts().then(render);
    };
  });
}

// Members only see who else is working when they share that venue that day.
function canSeeCrew(shift, dayKeyValue, allShifts) {
  if (state.me.role === 'admin') return true;
  if (shift.assignees.some((a) => a.id === state.me.id)) return true;
  if (!shift.venue_id) return false;
  return allShifts.some((other) => (
    other.venue_id === shift.venue_id
    && dateKey(new Date(other.starts_at)) === dayKeyValue
    && other.assignees.some((a) => a.id === state.me.id)
  ));
}

// Week timetable: a column per day, an hour per row, jobs placed by time.
function weekGridHTML(days, byDay) {
  const all = state.shifts;
  let earliest = 24 * 60, latest = 0;
  for (const s of all) {
    const st = new Date(s.starts_at), en = new Date(s.ends_at);
    earliest = Math.min(earliest, st.getHours() * 60 + st.getMinutes());
    latest = Math.max(latest, dateKey(en) === dateKey(st) ? en.getHours() * 60 + en.getMinutes() : 24 * 60);
  }
  if (!all.length) { earliest = 8 * 60; latest = 18 * 60; }
  const startHour = Math.max(0, Math.floor(earliest / 60) - 1);
  const endHour = Math.min(24, Math.ceil(latest / 60) + 1);
  const hours = Math.max(4, endHour - startHour);
  const PX_PER_HOUR = 58;

  const columns = days.map((d) => {
    const key = dateKey(d);
    const items = (byDay[key] || []).map((s) => {
      const st = new Date(s.starts_at), en = new Date(s.ends_at);
      const fromMin = st.getHours() * 60 + st.getMinutes();
      const toMin = dateKey(en) === key ? en.getHours() * 60 + en.getMinutes() : 24 * 60;
      const top = ((fromMin - startHour * 60) / 60) * PX_PER_HOUR;
      const height = Math.max(30, ((toMin - fromMin) / 60) * PX_PER_HOUR);
      const mine = s.assignees.some((a) => a.id === state.me.id);
      const showCrew = canSeeCrew(s, key, all);
      return `
        <div class="grid-shift ${mine ? 'mine' : ''}" data-shift="${s.id}"
             style="top:${top}px;height:${height}px;border-left-color:${esc(s.venue_color || 'var(--brand)')}">
          <div class="gs-time">${fmtTime(s.starts_at)}</div>
          <div class="gs-title">${esc(s.title)}</div>
          ${s.venue_name ? `<div class="gs-venue">${esc(s.venue_name)}</div>` : ''}
          ${showCrew
            ? (s.assignees.length ? `<div class="gs-people">${s.assignees.map((a) => esc(a.name.split(' ')[0])).join(', ')}</div>` : '')
            : `<div class="gs-people muted">${s.assignees.length} scheduled</div>`}
        </div>`;
    }).join('');
    const isToday = key === dateKey(new Date());
    return `
      <div class="grid-col">
        <div class="grid-head ${isToday ? 'today' : ''}">
          <div>${d.toLocaleDateString([], { weekday: 'short' })}</div>
          <div class="gh-num">${d.getDate()}</div>
        </div>
        <div class="grid-body" style="height:${hours * PX_PER_HOUR}px">${items}</div>
      </div>`;
  }).join('');

  const labels = [...Array(hours)].map((_, i) => `
    <div class="grid-hour" style="height:${PX_PER_HOUR}px">${minToLabel((startHour + i) * 60)}</div>`).join('');

  return `
    <div class="week-grid-wrap">
      <div class="week-grid">
        <div class="grid-col grid-times">
          <div class="grid-head"></div>
          <div class="grid-body" style="height:${hours * PX_PER_HOUR}px">${labels}</div>
        </div>
        ${columns}
      </div>
    </div>`;
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
        ${s.attire_name ? `<div class="shift-venue">👔 ${esc(s.attire_name)}</div>` : ''}
        ${s.notes ? `<div class="shift-notes">${esc(s.notes)}</div>` : ''}
        ${s.assignees.length ? (canSeeCrew(s, dateKey(new Date(s.starts_at)), state.shifts) ? `<div class="shift-people">
          ${s.assignees.map((a) => `<span class="chip ${a.status}">
            <span class="avatar" style="background:${esc(a.color)}">${esc(initials(a.name))}</span>
            ${esc(a.name)}<span class="st">${statusIcon[a.status] || ''}</span></span>`).join('')}
        </div>` : `<div class="sub" style="margin-top:8px">${s.assignees.length} scheduled</div>`) : ''}
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
      ${s.attire_name ? `
      <div class="detail-row">
        <span class="detail-ico">👔</span>
        <span><b>${esc(s.attire_name)}</b><div class="sub">${esc(s.attire_description || 'Attire')}</div></span>
        ${s.attire_id ? `<button class="btn small secondary" data-attire-detail="${s.attire_id}">View</button>` : ''}
      </div>` : ''}
      ${s.notes ? `
      <div class="detail-row">
        <span class="detail-ico">📝</span>
        <span style="white-space:pre-wrap">${esc(s.notes)}</span>
      </div>` : ''}
    </div>

    <div class="section-title" style="margin-top:16px">Team on this job (${s.assignees.length})</div>
    ${!canSeeCrew(s, dateKey(new Date(s.starts_at)), state.shifts)
      ? `<p class="sub">${s.assignees.length} scheduled. You only see names for jobs at a venue you're working that day.</p>`
      : s.assignees.length ? `<div class="detail-people">
      ${s.assignees.map((a) => `
        <div class="row detail-person">
          <span class="avatar lg" style="background:${esc(a.color)}">${esc(initials(a.name))}</span>
          <span class="grow">
            <div style="font-weight:700">${esc(a.name)}${a.id === state.me.id ? ' <span class="sub">(you)</span>' : ''}</div>
            <div class="sub ${a.status}">${statusLabel[a.status] || ''}</div>
          </span>
        </div>`).join('')}
    </div>` : '<p class="sub">Nobody assigned yet.</p>'}
    <div id="detail-changes"></div>

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

  // Any edits an admin made since the job was created.
  api(`/api/shifts/${s.id}/changes`).then(({ changes }) => {
    const box = modal.querySelector('#detail-changes');
    if (!box || !changes.length) return;
    box.innerHTML = `
      <div class="section-title" style="margin-top:16px">Changes</div>
      <div class="detail-people">
        ${changes.map((c) => `
          <div class="detail-person change-row">
            <span class="detail-ico">✏️</span>
            <span class="grow">
              <div>${esc(c.summary)}</div>
              <div class="sub">${esc(c.user_name || 'An admin')} · ${fmtWhen(c.created_at)}</div>
            </span>
          </div>`).join('')}
      </div>`;
  }).catch(() => {});
  const attireBtn = modal.querySelector('[data-attire-detail]');
  if (attireBtn) attireBtn.onclick = () => {
    closeModal();
    openAttireDetail(state.attire.find((a) => a.id === Number(attireBtn.dataset.attireDetail)));
  };
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
      <label>Attire (optional)</label>
      <select name="attire_id">
        <option value="">No attire specified</option>
        ${state.attire.map((a) => `<option value="${a.id}" ${shift?.attire_id === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
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
      attire_id: fd.get('attire_id') ? Number(fd.get('attire_id')) : null,
      starts_at: new Date(fd.get('starts_at')).toISOString(),
      ends_at: new Date(fd.get('ends_at')).toISOString(),
      notes: fd.get('notes') || '',
      assignee_ids: [...selected],
    };
    try {
      await api(shift ? `/api/shifts/${shift.id}` : '/api/shifts', { method: shift ? 'PATCH' : 'POST', body });
      closeModal(); toast(shift ? 'Job updated — team notified' : 'Job created — team notified');
      loadShifts().then(render);
    } catch (err) {
      if (err.conflicts?.length) showConflicts(err.conflicts);
      else toast(err.message);
    }
  };
}

function showConflicts(conflicts) {
  openModal(`
    <h3>⚠️ Scheduling conflict</h3>
    <p class="sub">This job can't be saved until these are resolved:</p>
    <div class="detail-people" style="margin-top:10px">
      ${conflicts.map((c) => `
        <div class="detail-person">
          <span class="detail-ico">${c.kind === 'unavailable' ? '📗' : '📅'}</span>
          <span class="grow">${esc(c.message)}</span>
        </div>`).join('')}
    </div>
    <div class="actions"><button class="btn" onclick="document.querySelector('.modal-backdrop').remove()">Got it</button></div>
  `);
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
    </div>
    ${tabbarHTML('chat', 'chat-nav')}`;
  bindTabbar();
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
    ${isAdmin ? `<button class="btn secondary" id="import-worker-ids" style="margin-bottom:14px">📋 Import Paychex Worker IDs</button>` : ''}
    <div class="card">
      <div style="font-weight:700;margin-bottom:6px">Invite your team</div>
      <p class="hint">Share this app's link with your team — they sign up with their email and instantly appear here, in chat, and in the schedule.</p>
    </div>
  `);
  document.querySelectorAll('[data-edit-user]').forEach((b) => {
    b.onclick = () => openUserModal(state.users.find((u) => u.id === Number(b.dataset.editUser)));
  });
  const importBtn = document.getElementById('import-worker-ids');
  if (importBtn) importBtn.onclick = openWorkerIdImport;
}

// Accepts a pasted Paychex roster. Handles the "All Active Employees" export
// layout (a name line followed by "ID 120") as well as plain "Name, 120" lines.
function parseWorkerRoster(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const entries = [];
  const isNoise = (l) => (
    /^--\s*\d+\s*of\s*\d+\s*--$/i.test(l)
    || /^[A-Z]{1,3}$/.test(l)
    || l.includes('@')
    || /^E&E Management/i.test(l)
    || /^All Active Employees/i.test(l)
    || !/[a-z]/i.test(l)
  );

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // "Name, 120" or "Name<tab>120"
    const inline = line.match(/^(.+?)[,\t;]\s*(?:ID\s*)?([A-Za-z0-9]{1,10})$/i);
    if (inline && /[a-z]/i.test(inline[1]) && !/^ID$/i.test(inline[1].trim())) {
      // Guard against "Last, First" being read as a name/id pair.
      if (!/^[A-Za-z]+$/.test(inline[2]) || /\d/.test(inline[2])) {
        entries.push({ name: inline[1].trim(), worker_id: inline[2] });
        continue;
      }
    }

    // The PDF layout: a standalone "ID 120" line preceded by the name.
    const idLine = line.match(/^ID\s+([A-Za-z0-9]{1,10})$/i);
    if (!idLine) continue;
    for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
      if (isNoise(lines[j])) continue;
      entries.push({ name: lines[j], worker_id: idLine[1] });
      break;
    }
  }
  return entries;
}

function openWorkerIdImport() {
  const modal = openModal(`
    <h3>Import Paychex Worker IDs</h3>
    <p class="sub">Open your Paychex <b>All Active Employees</b> list, select all and copy, then paste it below. Lines like <b>Name, 120</b> work too.</p>
    <textarea id="roster-text" rows="7" placeholder="Acosta, Damian&#10;ID 120&#10;Adamzadeh, David&#10;ID 151"></textarea>
    <div id="roster-preview" class="sub" style="margin-top:10px"></div>
    <div class="actions">
      <button type="button" class="btn secondary" id="roster-cancel">Cancel</button>
      <button type="button" class="btn" id="roster-import" disabled>Import</button>
    </div>
  `);
  const textarea = modal.querySelector('#roster-text');
  const preview = modal.querySelector('#roster-preview');
  const importBtn = modal.querySelector('#roster-import');
  let entries = [];

  textarea.oninput = () => {
    entries = parseWorkerRoster(textarea.value);
    importBtn.disabled = entries.length === 0;
    preview.innerHTML = entries.length
      ? `Found <b>${entries.length}</b> employee${entries.length === 1 ? '' : 's'} — e.g. ${esc(entries[0].name)} → ${esc(entries[0].worker_id)}`
      : (textarea.value.trim() ? 'No employees found in that text yet.' : '');
  };

  modal.querySelector('#roster-cancel').onclick = closeModal;
  importBtn.onclick = async () => {
    importBtn.disabled = true; importBtn.textContent = 'Importing…';
    try {
      const r = await api('/api/users/worker-ids/import', { method: 'POST', body: { entries } });
      state.users = (await api('/api/users')).users;
      showRosterResult(r);
    } catch (err) {
      toast(err.message);
      importBtn.disabled = false; importBtn.textContent = 'Import';
    }
  };
}

function showRosterResult(r) {
  const { counts, ambiguous, skipped } = r;
  openModal(`
    <h3>Worker IDs imported</h3>
    <div class="detail-rows" style="margin-top:10px">
      <div class="detail-row"><span class="detail-ico">✅</span><span><b>${counts.assigned}</b> matched to people already in the app</span></div>
      <div class="detail-row"><span class="detail-ico">⏳</span><span><b>${counts.pending}</b> saved for later — they get their ID automatically when they sign up</span></div>
      ${counts.ambiguous ? `<div class="detail-row"><span class="detail-ico">⚠️</span><span><b>${counts.ambiguous}</b> matched more than one team member, so they were left alone:<div class="sub">${ambiguous.slice(0, 8).map((a) => esc(a.name)).join(', ')}</div></span></div>` : ''}
      ${counts.skipped ? `<div class="detail-row"><span class="detail-ico">🚫</span><span><b>${counts.skipped}</b> skipped:<div class="sub">${skipped.slice(0, 8).map((x) => `${esc(x.name || '?')} (${esc(x.reason)})`).join(', ')}</div></span></div>` : ''}
    </div>
    <div class="actions"><button class="btn" id="roster-done">Done</button></div>
  `).querySelector('#roster-done').onclick = () => { closeModal(); render(); };
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
      <label>Paychex Worker ID</label>
      <input name="worker_id" maxlength="10" placeholder="Payroll ID" value="${esc(user.worker_id || '')}">
      <p class="hint">Required to include this person in the Paychex export.</p>
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
        body: {
          position_id: posSel.value ? Number(posSel.value) : null,
          worker_id: new FormData(e.target).get('worker_id') || '',
        },
      });
      state.users = (await api('/api/users')).users;
      closeModal(); render();
    } catch (err) { toast(err.message); }
  };
}

/* ------------------------------ notifications ------------------------------ */

async function renderNotifications() {
  const { categories, prefs } = await api('/api/me/notification-prefs');
  const enabled = await pushEnabled();

  shell('Notifications', `
    <div class="card">
      <div class="settings-row">
        <div>
          <div style="font-weight:700">Push notifications</div>
          <div class="sub">${enabled ? 'On for this device' : 'Off — turn on to receive any of these'}</div>
        </div>
        <button class="btn small ${enabled ? 'secondary' : ''}" id="pref-push-toggle">${enabled ? 'Disable' : 'Enable'}</button>
      </div>
    </div>

    <div class="section-title">Send me a push for</div>
    ${Object.entries(categories).map(([key, label]) => `
      <div class="card settings-row">
        <div class="grow">${esc(label)}</div>
        <button class="toggle ${prefs[key] ? 'on' : ''}" data-pref="${key}" role="switch" aria-checked="${!!prefs[key]}">
          <span class="knob"></span>
        </button>
      </div>`).join('')}
    <p class="hint">Turning one off only stops the phone alert — it still appears under Updates → My activity.</p>
  `, { back: () => { location.hash = '#/more'; } });

  document.getElementById('pref-push-toggle').onclick = async () => {
    try { enabled ? await disablePush() : await enablePush(); } catch (err) { toast(err.message); }
    render();
  };
  document.querySelectorAll('[data-pref]').forEach((b) => {
    b.onclick = async () => {
      const key = b.dataset.pref;
      const next = !b.classList.contains('on');
      b.classList.toggle('on', next);
      b.setAttribute('aria-checked', String(next));
      try { await api('/api/me/notification-prefs', { method: 'PUT', body: { prefs: { [key]: next } } }); }
      catch (err) { toast(err.message); b.classList.toggle('on', !next); }
    };
  });
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
      <button class="btn secondary" id="goto-notif-prefs" style="margin-top:8px">Choose which notifications you get</button>
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
  document.getElementById('goto-notif-prefs').onclick = () => { location.hash = '#/notifications'; };
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

const PERIOD_DAYS = 14;

// Pay periods run in fixed 14-day blocks from the anchor date in settings, so
// every admin sees the same boundaries no matter when they open the screen.
function periodStartFor(date, anchorIso) {
  const anchor = new Date(`${anchorIso || '2026-01-05'}T00:00:00`);
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const blocks = Math.floor((d - anchor) / (PERIOD_DAYS * 86400000));
  const start = new Date(anchor);
  start.setDate(start.getDate() + blocks * PERIOD_DAYS);
  return start;
}

function periodRange() {
  const from = new Date(state.tsPeriodStart);
  const to = new Date(state.tsPeriodStart);
  to.setDate(to.getDate() + PERIOD_DAYS);
  return { from, to };
}

async function renderTimesheets() {
  if (state.me.role !== 'admin') { location.hash = '#/clock'; return; }
  if (!state.tsPeriodStart) {
    state.tsPeriodStart = periodStartFor(new Date(), state.settings.period_anchor);
  }
  const { from, to } = periodRange();
  const { entries } = await api(`/api/time/entries?from=${from.toISOString()}&to=${to.toISOString()}`);

  const byUser = new Map();
  for (const e of entries) {
    const u = byUser.get(e.user_id) || {
      id: e.user_id, name: e.user_name, color: e.user_color,
      approvedMs: 0, pendingMs: 0, pending: 0, mileage: 0, venues: new Set(), entries: [],
    };
    const ms = e.clock_out ? new Date(e.clock_out) - new Date(e.clock_in) : 0;
    if (e.approved) u.approvedMs += ms; else u.pendingMs += ms;
    if (!e.approved) u.pending++;
    u.mileage += e.mileage || 0;
    if (e.venue_name) u.venues.add(e.venue_name);
    u.entries.push(e);
    byUser.set(e.user_id, u);
  }
  const people = [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
  const needsReview = people.reduce((n, p) => n + p.pending, 0);
  const label = `${from.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${new Date(to - 1).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;

  shell('Timesheets', `
    <div class="week-nav">
      <button class="icon-btn" id="ts-prev">‹</button>
      <div class="range">${label}<div class="sub" style="font-weight:500">Bi-weekly pay period</div></div>
      <button class="icon-btn" id="ts-next">›</button>
    </div>
    ${needsReview ? `<div class="review-banner">⚠️ <b>${needsReview}</b> punch${needsReview === 1 ? '' : 'es'} still need review before export</div>`
      : (people.length ? '<div class="review-banner ok">✓ Everything in this period is approved</div>' : '')}
    ${people.length ? people.map((p) => `
      <button class="card row ts-person" data-person="${p.id}">
        <span class="avatar lg" style="background:${esc(p.color)}">${esc(initials(p.name))}</span>
        <span class="grow">
          <div style="font-weight:700">${esc(p.name)}</div>
          <div class="sub">
            <b>${fmtDur(p.approvedMs)}</b> approved${p.pending ? ` · <span class="pending-tag">${fmtDur(p.pendingMs)} pending</span>` : ''}
            ${p.mileage ? ` · 🚗 ${p.mileage.toFixed(1)} mi` : ''}
          </div>
          <div class="sub">${p.venues.size ? esc([...p.venues].join(', ')) : 'No venue recorded'}</div>
        </span>
        <span class="sub">›</span>
      </button>`).join('') : '<div class="empty"><div class="big">🧾</div>No punches in this pay period</div>'}
    <button class="btn" id="ts-export" style="margin-top:10px">⬇️ Export Paychex CSV</button>
    <button class="btn secondary" id="ts-settings" style="margin-top:8px">⚙️ Payroll export settings</button>
    <p class="hint">Only <b>approved</b> hours are exported. Tap a person to review, edit and approve their punches.</p>
  `, { back: () => { location.hash = '#/more'; } });

  document.getElementById('ts-prev').onclick = () => {
    state.tsPeriodStart.setDate(state.tsPeriodStart.getDate() - PERIOD_DAYS); render();
  };
  document.getElementById('ts-next').onclick = () => {
    state.tsPeriodStart.setDate(state.tsPeriodStart.getDate() + PERIOD_DAYS); render();
  };
  document.querySelectorAll('[data-person]').forEach((b) => {
    b.onclick = () => openPersonTimesheet(people.find((p) => p.id === Number(b.dataset.person)), from, to);
  });
  document.getElementById('ts-export').onclick = async () => {
    try {
      // Surface setup problems as a message instead of downloading an error page.
      const res = await fetch(`/api/time/export?from=${from.toISOString()}&to=${to.toISOString()}`);
      if (!res.ok) return toast((await res.json().catch(() => ({}))).error || 'Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `paychex-spi-${dateKey(from)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Paychex file downloaded');
    } catch (err) { toast(err.message); }
  };
  document.getElementById('ts-settings').onclick = openPayrollSettings;
}

function openPersonTimesheet(person, from, to) {
  const rows = person.entries.slice().sort((a, b) => a.clock_in.localeCompare(b.clock_in));
  const modal = openModal(`
    <h3>${esc(person.name)}</h3>
    <p class="sub"><b>${fmtDur(person.approvedMs)}</b> approved${person.pending ? ` · ${person.pending} awaiting review` : ''}</p>
    <div class="detail-people" style="margin-top:10px">
      ${rows.map((e) => `
        <button class="ts-row ${e.approved ? 'approved' : ''}" data-entry="${e.id}">
          <span class="grow">
            <div style="font-weight:700">${fmtDay(e.clock_in)} · ${fmtTime(e.clock_in)} – ${e.clock_out ? fmtTime(e.clock_out) : 'still open'}</div>
            <div class="sub">
              ${e.clock_out ? `<b>${fmtDur(new Date(e.clock_out) - new Date(e.clock_in))}</b>` : 'open punch'}
              ${e.venue_name ? ` · 📍 ${esc(e.venue_name)}` : ' · no venue'}
              ${e.role_name ? ` · ${esc(e.role_name)}` : ''}
              ${e.mileage ? ` · 🚗 ${e.mileage} mi` : ''}
            </div>
            ${e.note ? `<div class="sub note-line">📝 ${esc(e.note)}</div>` : ''}
          </span>
          <span class="ts-state">${e.approved ? '✓ Approved' : 'Review'}</span>
        </button>`).join('')}
    </div>
    <div class="actions">
      <button class="btn secondary" id="pt-close">Close</button>
      ${person.pending ? '<button class="btn" id="pt-approve-all">Approve all</button>' : ''}
    </div>
  `);
  modal.querySelector('#pt-close').onclick = closeModal;
  modal.querySelectorAll('[data-entry]').forEach((b) => {
    b.onclick = () => {
      const entry = rows.find((e) => e.id === Number(b.dataset.entry));
      closeModal();
      openTimeEntryModal(entry);
    };
  });
  const approveAll = modal.querySelector('#pt-approve-all');
  if (approveAll) approveAll.onclick = async () => {
    if (!confirm(`Approve all finished punches for ${person.name} in this pay period?`)) return;
    const { changed } = await api('/api/time/approve', {
      method: 'POST',
      body: { user_id: person.id, from: from.toISOString(), to: to.toISOString(), approved: true },
    });
    closeModal(); toast(`${changed} punch${changed === 1 ? '' : 'es'} approved`);
    render();
  };
}

function openTimeEntryModal(entry) {
  const modal = openModal(`
    <h3>Edit punch</h3>
    <p class="sub">${esc(entry.user_name)} · ${fmtDay(entry.clock_in)}</p>
    <form id="entry-form">
      <label>Clock in</label><input name="clock_in" type="datetime-local" required value="${toLocalInput(entry.clock_in)}">
      <label>Clock out</label><input name="clock_out" type="datetime-local" ${entry.clock_out ? `value="${toLocalInput(entry.clock_out)}"` : ''}>
      <label>Venue</label>
      <select name="venue_id">
        <option value="">No venue</option>
        ${state.venues.map((v) => `<option value="${v.id}" ${entry.venue_id === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}
      </select>
      <label>Job</label>
      <select name="role_id">
        <option value="">No job</option>
        ${state.roles.map((r) => `<option value="${r.id}" ${entry.role_id === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
      </select>
      <label>Mileage</label>
      <input name="mileage" type="number" min="0" step="0.1" value="${entry.mileage || 0}">
      <label>Note from the shift</label>
      <textarea name="note" rows="2">${esc(entry.note || '')}</textarea>
      ${entry.in_lat ? `<p class="hint">📍 <a href="https://maps.google.com/?q=${entry.in_lat},${entry.in_lng}" target="_blank">Clock-in location</a>${entry.out_lat ? ` · <a href="https://maps.google.com/?q=${entry.out_lat},${entry.out_lng}" target="_blank">clock-out location</a>` : ''}</p>` : ''}
      <div class="actions">
        <button type="button" class="btn danger" id="entry-delete">Delete</button>
        <button type="submit" class="btn secondary" id="entry-save">Save</button>
      </div>
      <button type="button" class="btn" id="entry-approve" style="margin-top:8px">
        ${entry.approved ? '✓ Approved — tap to un-approve' : 'Save & approve'}
      </button>
    </form>
  `);

  const collect = () => {
    const fd = new FormData(modal.querySelector('#entry-form'));
    return {
      clock_in: new Date(fd.get('clock_in')).toISOString(),
      clock_out: fd.get('clock_out') ? new Date(fd.get('clock_out')).toISOString() : null,
      venue_id: fd.get('venue_id') ? Number(fd.get('venue_id')) : null,
      role_id: fd.get('role_id') ? Number(fd.get('role_id')) : null,
      mileage: Number(fd.get('mileage')) || 0,
      note: fd.get('note') || '',
    };
  };
  const save = async (approved) => {
    try {
      await api(`/api/time/entries/${entry.id}`, { method: 'PATCH', body: { ...collect(), approved } });
      closeModal(); toast(approved ? 'Approved ✅' : 'Saved');
      render();
    } catch (err) { toast(err.message); }
  };

  modal.querySelector('#entry-form').onsubmit = (e) => { e.preventDefault(); save(entry.approved); };
  modal.querySelector('#entry-approve').onclick = () => save(!entry.approved);
  modal.querySelector('#entry-delete').onclick = async () => {
    if (!confirm('Delete this punch?')) return;
    await api(`/api/time/entries/${entry.id}`, { method: 'DELETE' });
    closeModal(); render();
  };
}

function openPayrollSettings() {
  const cfg = state.settings;
  const modal = openModal(`
    <h3>Payroll export settings</h3>
    <p class="sub">Used to build the Paychex SPI import file.</p>
    <form id="pay-form">
      <label>Paychex Company ID</label>
      <input name="paychex_company_id" maxlength="8" placeholder="e.g. 1234567" value="${esc(cfg.paychex_company_id)}">
      <label>Pay Component (earning name in Paychex)</label>
      <input name="pay_component" maxlength="20" placeholder="Hourly" value="${esc(cfg.pay_component)}">
      <p class="hint">Must match the earning name set up on your Paychex company exactly, including capitals.</p>
      <label>First day of a pay period</label>
      <input name="period_anchor" type="date" value="${esc(cfg.period_anchor)}">
      <p class="hint">Periods run 14 days from this date.</p>
      <label class="check-label"><input type="checkbox" name="export_per_day" ${cfg.export_per_day === '1' ? 'checked' : ''} style="width:auto"> One row per day (adds Line Date)</label>
      <label class="check-label"><input type="checkbox" name="export_jobs" ${cfg.export_jobs === '1' ? 'checked' : ''} style="width:auto"> Include venue as Job Number / Job Name</label>
      <p class="hint">Rates are never exported — Paychex applies each worker's own rate. Add each person's Worker ID in Team.</p>
      <div class="actions"><button type="submit" class="btn">Save</button></div>
    </form>
  `);
  modal.querySelector('#pay-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const { settings } = await api('/api/settings', {
        method: 'PUT',
        body: {
          paychex_company_id: fd.get('paychex_company_id') || '',
          pay_component: fd.get('pay_component') || 'Hourly',
          period_anchor: fd.get('period_anchor') || '',
          export_per_day: fd.get('export_per_day') ? '1' : '0',
          export_jobs: fd.get('export_jobs') ? '1' : '0',
        },
      });
      state.settings = settings;
      state.tsPeriodStart = periodStartFor(new Date(), settings.period_anchor);
      closeModal(); toast('Settings saved');
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

/* ------------------------------- availability ------------------------------- */

function minToLabel(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function minToInput(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function inputToMin(value) {
  const [h, m] = String(value || '0:0').split(':').map(Number);
  return (h * 60) + (m || 0);
}

async function renderAvailability() {
  const from = dateKey(new Date());
  const to = new Date(); to.setDate(to.getDate() + 120);
  const { unavailability } = await api(`/api/availability?from=${from}&to=${dateKey(to)}`);

  // Group by date so a day with several blocks reads as one row.
  const byDate = new Map();
  for (const u of unavailability) {
    if (!byDate.has(u.date)) byDate.set(u.date, []);
    byDate.get(u.date).push(u);
  }

  shell('Availability', `
    <p class="hint" style="margin-bottom:14px">Mark the times you <b>can't</b> work. Admins can't schedule you during them.</p>
    ${byDate.size ? [...byDate.entries()].map(([date, items]) => `
      <div class="card">
        <div style="font-weight:700;margin-bottom:6px">${fmtDay(`${date}T12:00:00`)}</div>
        ${items.map((u) => `
          <div class="row unavail-row">
            <span class="grow">
              <div class="unavail-chip">Unavailable · ${u.all_day ? 'All day' : `${minToLabel(u.start_min)} – ${minToLabel(u.end_min)}`}</div>
              ${u.note ? `<div class="sub" style="margin-top:4px">${esc(u.note)}</div>` : ''}
              ${u.series_id ? '<div class="sub">🔁 Part of a weekly repeat</div>' : ''}
            </span>
            <button class="icon-btn" data-del-unavail="${u.id}" data-series="${u.series_id ? 1 : 0}">🗑️</button>
          </div>`).join('')}
      </div>`).join('')
      : '<div class="empty"><div class="big">📗</div>You have no unavailability set.<br>Tap ＋ to add a day or time you can\'t work.</div>'}
  `, { fab: true });

  document.getElementById('fab').onclick = () => openUnavailModal();
  document.querySelectorAll('[data-del-unavail]').forEach((b) => {
    b.onclick = async () => {
      const isSeries = b.dataset.series === '1';
      let series = false;
      if (isSeries) {
        series = confirm('This repeats weekly.\n\nOK = remove this one and all later repeats\nCancel = remove just this day');
      } else if (!confirm('Remove this unavailability?')) return;
      await api(`/api/availability/${b.dataset.delUnavail}${series ? '?series=1' : ''}`, { method: 'DELETE' });
      render();
    };
  });
}

function openUnavailModal() {
  const modal = openModal(`
    <h3>Declare unavailability</h3>
    <form id="unavail-form">
      <div class="settings-row" style="margin-top:12px">
        <div style="font-weight:600">All day</div>
        <button type="button" class="toggle" id="ua-allday" role="switch" aria-checked="false"><span class="knob"></span></button>
      </div>
      <label>Date</label><input name="date" type="date" required value="${dateKey(new Date())}">
      <div id="ua-times">
        <div style="display:flex;gap:10px;align-items:flex-end">
          <span style="flex:1"><label>From</label><input name="start" type="time" value="09:00"></span>
          <span style="flex:1"><label>To</label><input name="end" type="time" value="17:00"></span>
        </div>
      </div>
      <label>Note (optional)</label>
      <textarea name="note" rows="2" placeholder="Class, second job, appointment…"></textarea>

      <div class="settings-row" style="margin-top:16px">
        <div style="font-weight:600">🔁 Repeat every week</div>
        <button type="button" class="toggle" id="ua-repeat" role="switch" aria-checked="false"><span class="knob"></span></button>
      </div>
      <div id="ua-repeat-weeks" hidden>
        <label>Repeat for how many weeks?</label>
        <input name="weeks" type="number" min="2" max="52" value="8">
        <p class="hint">Counts this week as the first one.</p>
      </div>

      <div class="actions">
        <button type="button" class="btn secondary" id="ua-cancel">Cancel</button>
        <button type="submit" class="btn">Confirm</button>
      </div>
    </form>
  `);

  const allDay = modal.querySelector('#ua-allday');
  const times = modal.querySelector('#ua-times');
  allDay.onclick = () => {
    const on = !allDay.classList.contains('on');
    allDay.classList.toggle('on', on);
    allDay.setAttribute('aria-checked', String(on));
    times.hidden = on;
  };

  const repeat = modal.querySelector('#ua-repeat');
  const weeksBox = modal.querySelector('#ua-repeat-weeks');
  repeat.onclick = () => {
    const on = !repeat.classList.contains('on');
    repeat.classList.toggle('on', on);
    repeat.setAttribute('aria-checked', String(on));
    weeksBox.hidden = !on;
  };

  modal.querySelector('#ua-cancel').onclick = closeModal;
  modal.querySelector('#unavail-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const isAllDay = allDay.classList.contains('on');
    try {
      const { created } = await api('/api/availability', {
        method: 'POST',
        body: {
          date: fd.get('date'),
          all_day: isAllDay,
          start_min: inputToMin(fd.get('start')),
          end_min: inputToMin(fd.get('end')),
          note: fd.get('note') || '',
          repeat_weeks: repeat.classList.contains('on') ? Number(fd.get('weeks')) || 1 : 1,
        },
      });
      closeModal();
      toast(created > 1 ? `Saved for ${created} weeks` : 'Unavailability saved');
      render();
    } catch (err) { toast(err.message); }
  };
}

/* ---------------------------------- attire ---------------------------------- */

async function renderAttire() {
  if (state.me.role !== 'admin') { location.hash = '#/schedule'; return; }
  const { attire } = await api('/api/attire');
  state.attire = attire;
  const isAdmin = state.me.role === 'admin';

  // What the signed-in person is expected to wear next.
  const now = Date.now();
  const upcoming = state.shifts
    .filter((sh) => sh.attire_name && new Date(sh.ends_at) > now
      && sh.assignees.some((a) => a.id === state.me.id))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];

  shell('Attire', `
    ${upcoming ? `
      <div class="card next-attire">
        <div class="sub">For your next job · ${fmtDay(upcoming.starts_at)}</div>
        <div style="font-weight:800;font-size:17px;margin:3px 0">👔 ${esc(upcoming.attire_name)}</div>
        <div class="sub">${esc(upcoming.title)}${upcoming.venue_name ? ` · ${esc(upcoming.venue_name)}` : ''}</div>
      </div>` : ''}
    ${attire.length ? `<div class="attire-grid">${attire.map((a) => `
      <button class="attire-card" data-attire="${a.id}">
        ${a.has_photo
          ? `<img src="/api/attire/${a.id}/photo" alt="${esc(a.name)}" loading="lazy">`
          : `<span class="attire-swatch" style="background:${esc(a.color)}">👔</span>`}
        <span class="attire-name">${esc(a.name)}</span>
        ${a.description ? `<span class="sub attire-desc">${esc(a.description)}</span>` : ''}
      </button>`).join('')}</div>`
      : `<div class="empty"><div class="big">👔</div>No attire set up yet${isAdmin ? '<br>Tap ＋ to add one (e.g. Black Formal, Banquet Whites)' : ''}</div>`}
  `, { fab: isAdmin });

  if (isAdmin) document.getElementById('fab').onclick = () => openAttireModal();
  document.querySelectorAll('[data-attire]').forEach((b) => {
    b.onclick = () => openAttireDetail(attire.find((a) => a.id === Number(b.dataset.attire)));
  });
}

function openAttireDetail(item) {
  if (!item) return;
  const isAdmin = state.me.role === 'admin';
  const modal = openModal(`
    <h3>${esc(item.name)}</h3>
    ${item.has_photo ? `<img class="attire-full" src="/api/attire/${item.id}/photo" alt="${esc(item.name)}">` : ''}
    ${item.description ? `<p style="margin-top:12px;white-space:pre-wrap">${esc(item.description)}</p>` : '<p class="sub" style="margin-top:12px">No extra details.</p>'}
    <div class="actions">
      ${isAdmin ? '<button class="btn secondary" id="attire-edit">Edit</button>' : ''}
      <button class="btn ${isAdmin ? 'secondary' : ''}" id="attire-close">Close</button>
    </div>
  `);
  modal.querySelector('#attire-close').onclick = closeModal;
  const edit = modal.querySelector('#attire-edit');
  if (edit) edit.onclick = () => { closeModal(); openAttireModal(item); };
}

function openAttireModal(item = null) {
  const colors = ['#a8862c', '#1f2937', '#0ea5e9', '#059669', '#dc2626', '#7c3aed', '#db2777'];
  let color = item?.color || colors[0];
  let photo;  // undefined = unchanged, null = cleared, string = new data URL

  const modal = openModal(`
    <h3>${item ? 'Edit attire' : 'New attire'}</h3>
    <form id="attire-form">
      <label>Name</label>
      <input name="name" required placeholder="e.g. Black Formal" value="${esc(item?.name || '')}">
      <label>What to wear</label>
      <textarea name="description" rows="3" placeholder="Black button-up, black slacks, black non-slip shoes, no visible logos…">${esc(item?.description || '')}</textarea>
      <label>Photo (optional)</label>
      <input type="file" id="attire-photo" accept="image/jpeg,image/png">
      <div id="attire-photo-preview">
        ${item?.has_photo ? `<img class="attire-full" src="/api/attire/${item.id}/photo" alt=""><button type="button" class="btn small danger" id="attire-photo-clear" style="margin-top:8px">Remove photo</button>` : ''}
      </div>
      <label>Color</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${colors.map((c) => `<button type="button" data-color="${c}" style="width:34px;height:34px;border-radius:50%;background:${c};outline:${color === c ? '3px solid var(--text)' : 'none'};outline-offset:2px"></button>`).join('')}
      </div>
      <div class="actions">
        ${item ? '<button type="button" class="btn danger" id="attire-delete">Delete</button>' : ''}
        <button type="submit" class="btn">${item ? 'Save' : 'Add attire'}</button>
      </div>
    </form>
  `);

  modal.querySelectorAll('[data-color]').forEach((b) => {
    b.onclick = () => {
      color = b.dataset.color;
      modal.querySelectorAll('[data-color]').forEach((x) => { x.style.outline = 'none'; });
      b.style.outline = '3px solid var(--text)'; b.style.outlineOffset = '2px';
    };
  });

  const fileInput = modal.querySelector('#attire-photo');
  const preview = modal.querySelector('#attire-photo-preview');
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { toast('Photos must be under 4 MB'); fileInput.value = ''; return; }
    photo = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read that photo'));
      reader.readAsDataURL(file);
    });
    preview.innerHTML = `<img class="attire-full" src="${photo}" alt="">`;
  };
  const clearBtn = modal.querySelector('#attire-photo-clear');
  if (clearBtn) clearBtn.onclick = () => { photo = null; preview.innerHTML = '<p class="sub">Photo removed on save.</p>'; };

  const del = modal.querySelector('#attire-delete');
  if (del) del.onclick = async () => {
    if (!confirm('Delete this attire? Jobs already using it keep their label.')) return;
    await api(`/api/attire/${item.id}`, { method: 'DELETE' });
    closeModal(); render();
  };

  modal.querySelector('#attire-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { name: fd.get('name'), description: fd.get('description') || '', color };
    if (photo !== undefined) body.photo = photo;
    try {
      await api(item ? `/api/attire/${item.id}` : '/api/attire', { method: item ? 'PATCH' : 'POST', body });
      state.attire = (await api('/api/attire')).attire;
      closeModal(); toast(item ? 'Attire updated' : 'Attire added');
      render();
    } catch (err) { toast(err.message); }
  };
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
  const isAdmin = state.me.role === 'admin';
  const tab = state.updatesTab || 'activity';
  const [{ posts }, { notifications }] = await Promise.all([api('/api/posts'), api('/api/notifications')]);
  state.notifications = notifications;
  const unread = notifications.filter((n) => !n.read).length;

  const activity = notifications.length ? notifications.map((n) => `
    <div class="card notif ${n.read ? '' : 'unread'}">
      <div class="row">
        <span class="grow" data-notif-url="${esc(n.url)}">
          <div class="title">${esc(n.title)}</div>
          ${n.body ? `<div class="body">${esc(n.body)}</div>` : ''}
          <div class="when">${fmtWhen(n.created_at)}</div>
        </span>
        <button class="icon-btn" data-del-notif="${n.id}" title="Remove">✕</button>
      </div>
    </div>`).join('') + `
    <button class="btn secondary" id="clear-notifs" style="margin-top:6px">Clear all</button>`
    : `<div class="empty"><div class="big">🔔</div>Nothing yet.<br>Jobs you're added to, schedule changes and shift reminders show up here.</div>`;

  const announcements = posts.length ? posts.map((p) => `
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
    </div>`).join('')
    : `<div class="empty"><div class="big">📢</div>No company updates yet${isAdmin ? '<br>Tap ＋ to post one' : ''}</div>`;

  shell('Updates', `
    <div class="filter-row">
      <button class="pill ${tab === 'activity' ? 'active' : ''}" data-utab="activity">
        My activity${unread ? ` (${unread})` : ''}
      </button>
      <button class="pill ${tab === 'posts' ? 'active' : ''}" data-utab="posts">Company updates</button>
    </div>
    ${tab === 'activity' ? activity : announcements}
  `, { fab: isAdmin && tab === 'posts' });

  document.querySelectorAll('[data-utab]').forEach((b) => {
    b.onclick = () => { state.updatesTab = b.dataset.utab; render(); };
  });

  if (tab === 'activity') {
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
      if (!confirm('Clear all activity?')) return;
      await api('/api/notifications', { method: 'DELETE' });
      state.notifications = [];
      render();
    };
    if (unread) {
      api('/api/notifications/read', { method: 'POST' }).then(() => {
        state.notifications = state.notifications.map((n) => ({ ...n, read: 1 }));
        updateBadges();
      });
    }
    return;
  }

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
    { href: '#/forms', icon: '📄', label: 'Documents', sub: 'Read & sign uploaded documents' },
    ...(isAdmin ? [
      { href: '#/attire', icon: '👔', label: 'Attire', sub: 'What the team wears on each job' },
      { href: '#/timesheets', icon: '🧾', label: 'Timesheets', sub: 'Review, approve & export to Paychex' },
      { href: '#/kiosk', icon: '🔢', label: 'Kiosk Mode', sub: 'Lock this device into a PIN punch clock' },
      { href: '#/signed', icon: '📁', label: 'Signed Documents', sub: 'Who signed what & download copies' },
      { href: '#/roles', icon: '🧑‍🍳', label: 'Jobs', sub: 'Server, Bar Back, Set Up… (clock-outs & scheduling)' },
      { href: '#/positions', icon: '👥', label: 'Positions', sub: 'Team positions & admin permissions' },
    ] : []),
    { href: '#/venues', icon: '📍', label: 'Venues', sub: 'Work locations' },
    { href: '#/team', icon: '👥', label: 'Team', sub: 'People & roles' },
    { href: '#/notifications', icon: '🔔', label: 'Notifications', sub: 'Choose what reaches your phone' },
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
    else if (view === 'availability') await renderAvailability();
    else if (view === 'attire') await renderAttire();
    else if (view === 'signed') await renderSignedDocs();
    else if (view === 'place' && arg) await renderFieldPlacer(Number(arg));
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
  const [me, users, venues, roles, positions, attire, settings, channels, notifs] = await Promise.all([
    api('/api/me'), api('/api/users'), api('/api/venues'), api('/api/roles'), api('/api/positions'),
    api('/api/attire'), api('/api/settings'), api('/api/channels'), api('/api/notifications'),
  ]);
  state.me = me.user;
  state.vapidPublicKey = me.vapidPublicKey;
  state.users = users.users;
  state.venues = venues.venues;
  state.roles = roles.roles;
  state.positions = positions.positions;
  state.attire = attire.attire;
  state.settings = settings.settings;
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
