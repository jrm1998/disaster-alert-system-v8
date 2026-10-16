// Shared helpers for all MDAS pages
const api = {
  async request(method, url, body, isForm) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined && body !== null) {
      if (isForm) {
        opts.body = body; // FormData
      } else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    const res = await fetch(url, opts);
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  },
  get(url) { return this.request('GET', url); },
  post(url, body) { return this.request('POST', url, body); },
  put(url, body) { return this.request('PUT', url, body); },
  del(url) { return this.request('DELETE', url); },
  postForm(url, formData) { return this.request('POST', url, formData, true); }
};

// ---------- Toasts ----------
function toast(message, type) {
  let area = document.getElementById('toast-area');
  if (!area) {
    area = document.createElement('div');
    area.id = 'toast-area';
    document.body.appendChild(area);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = message;
  area.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4500);
}

// ---------- Auth state ----------
let currentUser = null;
async function loadCurrentUser() {
  try {
    currentUser = await api.get('/api/auth/me');
  } catch {
    currentUser = null;
  }
  renderAuthUI();
  return currentUser;
}

function renderAuthUI() {
  document.querySelectorAll('[data-auth-area]').forEach(el => {
    if (currentUser) {
      el.innerHTML =
        `<span class="muted">${escapeHtml(currentUser.name)} <span class="badge info">${currentUser.role.replace('_', ' ')}</span></span>
         <a class="btn secondary sm" href="/dashboard.html">Dashboard</a>
         <button class="btn sm" id="logout-btn">Logout</button>`;
      const btn = el.querySelector('#logout-btn');
      if (btn) btn.onclick = async () => { await api.post('/api/auth/logout'); location.href = '/'; };
    } else {
      el.innerHTML = `<a class="btn secondary sm" href="/login.html">Login</a>
                      <a class="btn sm" href="/login.html?mode=register">Register</a>`;
    }
  });
  // Re-render the siren banner so the authorized "Stop Siren" button
  // appears/disappears now that we know who is logged in.
  if (typeof renderSirenBanner === 'function') renderSirenBanner();
  // Start live GPS sharing if this staff member previously enabled it.
  if (typeof syncLocationSharing === 'function') syncLocationSharing();
}

// ---------- Live GPS location sharing (feature 1) ----------
// Staff (responder / barangay_official / admin) can opt in to share their real-time
// position so they appear on the incident map and their team's ETA can be computed.
// Gated behind an explicit browser permission prompt and a persisted preference;
// residents never share. Nothing is sent until the user turns it on.
const GPS_PREF_KEY = 'mdas_gps_sharing';
const GPS_STAFF_ROLES = ['responder', 'barangay_official', 'admin'];
let gpsWatchId = null;
let gpsPostTimer = null;
let gpsLastFix = null;

function isGpsStaff() {
  return currentUser && GPS_STAFF_ROLES.includes(currentUser.role);
}
function gpsSharingEnabled() {
  return localStorage.getItem(GPS_PREF_KEY) === 'on';
}

function postGpsFix() {
  if (!gpsLastFix) return;
  api.post('/api/location/update', {
    latitude: gpsLastFix.latitude,
    longitude: gpsLastFix.longitude,
    accuracy: gpsLastFix.accuracy
  }).catch(() => { /* transient/offline - next tick retries */ });
}

function startLocationSharing() {
  if (gpsWatchId != null) return;
  if (!('geolocation' in navigator)) { toast('Geolocation is not supported on this device.', 'error'); return; }
  gpsWatchId = navigator.geolocation.watchPosition(
    pos => {
      gpsLastFix = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      };
      postGpsFix(); // send immediately, then keep the fix fresh on an interval
    },
    err => {
      console.warn('[gps] watch failed:', err.message);
      if (err.code === err.PERMISSION_DENIED) {
        toast('Location permission denied. Enable it in your browser to share your position.', 'error');
        stopLocationSharing();
        localStorage.setItem(GPS_PREF_KEY, 'off');
        if (typeof renderGpsToggle === 'function') renderGpsToggle();
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  // Re-post the last fix every 20s so the server keeps it "fresh" while stationary.
  gpsPostTimer = setInterval(postGpsFix, 20000);
}

function stopLocationSharing() {
  if (gpsWatchId != null && 'geolocation' in navigator) navigator.geolocation.clearWatch(gpsWatchId);
  gpsWatchId = null;
  if (gpsPostTimer) { clearInterval(gpsPostTimer); gpsPostTimer = null; }
  gpsLastFix = null;
}

// Called on auth render: resumes sharing only if the staff user already opted in.
function syncLocationSharing() {
  if (isGpsStaff() && gpsSharingEnabled()) startLocationSharing();
  else stopLocationSharing();
}

// Explicit user toggle (dashboard button). Requests permission on first enable.
function setLocationSharing(on) {
  if (!isGpsStaff()) { toast('Only responders and officials can share their location.', 'error'); return; }
  localStorage.setItem(GPS_PREF_KEY, on ? 'on' : 'off');
  if (on) startLocationSharing(); else stopLocationSharing();
  if (typeof renderGpsToggle === 'function') renderGpsToggle();
}

// ---------- Utils ----------
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(d) {
  if (!d) return '';
  let s = String(d).replace(' ', 'T');
  // MySQL sends naive "YYYY-MM-DDTHH:MM:SS" strings that are already in
  // Philippine Time (UTC+8). Tag them with the offset so the instant is
  // correct regardless of the viewer's browser timezone, then render in UTC+8.
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) s += '+08:00';
  const dt = new Date(s);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------- Modal helper ----------
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.addEventListener('click', e => {
  if (e.target.classList && e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('open');
  }
});

// ---------- Offline indicator ----------
function updateOnlineState() {
  document.body.classList.toggle('is-offline', !navigator.onLine);
}
window.addEventListener('online', updateOnlineState);
window.addEventListener('offline', updateOnlineState);

// ---------- PWA: service worker + background push ----------
async function initPWA(enablePush) {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    if (enablePush && 'PushManager' in window) {
      await subscribePush(reg);
    }
  } catch (err) {
    console.warn('Service worker registration failed:', err);
  }
}

async function subscribePush(reg) {
  try {
    const { vapidPublicKey } = await api.get('/api/auth/push-key');
    if (!vapidPublicKey) return; // server has no VAPID keys configured
    const existing = await reg.pushManager.getSubscription();
    if (existing) return;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
    });
    await api.post('/api/push/subscribe', sub.toJSON());
    toast('Background notifications enabled.', 'success');
  } catch (err) {
    console.warn('Push subscription failed:', err);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ---------- PWA install prompt ----------
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  document.querySelectorAll('.install-btn').forEach(b => b.classList.add('show'));
});
async function installApp(btn) {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') btn.classList.remove('show');
  deferredPrompt = null;
}

// ---------- Alert sound (Web Audio siren) + vibration ----------
// Synthesized so no audio asset is needed. Browsers require a user gesture
// before audio can play, so the context is unlocked on the first interaction.
let audioCtx = null;
function ensureAudioCtx() {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch { return null; }
}
['click', 'keydown', 'touchstart', 'pointerdown'].forEach(ev =>
  window.addEventListener(ev, ensureAudioCtx, { once: true }));

// Plays an attention-grabbing siren. Critical alerts sound longer.
function playAlarm(severity) {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const critical = severity === 'critical';
  const total = critical ? 3.0 : 1.4;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  // Siren sweep: alternate between low and high pitch.
  const lo = 620, hi = critical ? 1180 : 980;
  osc.frequency.setValueAtTime(lo, now);
  const cycles = critical ? 5 : 3;
  const step = total / (cycles * 2);
  for (let i = 0; i < cycles * 2; i++) {
    osc.frequency.linearRampToValueAtTime(i % 2 === 0 ? hi : lo, now + step * (i + 1));
  }
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(critical ? 0.5 : 0.32, now + 0.05);
  gain.gain.setValueAtTime(critical ? 0.5 : 0.32, now + total - 0.15);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + total);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + total + 0.05);
}

function vibrateDevice(severity) {
  if (!('vibrate' in navigator)) return;
  try {
    navigator.vibrate(severity === 'critical'
      ? [600, 250, 600, 250, 600, 250, 600]
      : [350, 150, 350]);
  } catch { /* vibration unsupported */ }
}

// Fire both for a newly received alert.
function alertAttention(severity) {
  playAlarm(severity);
  vibrateDevice(severity);
}

// ---------- Continuous emergency siren (feature 3) ----------
// Loops an alarm until a rescuer is dispatched or an authorized user stops it.
// The server is the source of truth: /api/incidents/active-sirens lists incidents
// that are reported/verified, still unassigned, and not manually silenced.
let sirenTimer = null;
let sirenIncidents = [];
let sirenMuted = false;   // user pressed "Stop" in the banner (client-side hush)

function sirenRunning() { return sirenTimer != null; }

function startSirenLoop(severity) {
  stopSirenLoop();
  if (sirenMuted) return;
  const beep = () => { playAlarm(severity || 'critical'); vibrateDevice(severity || 'critical'); };
  beep();
  // playAlarm runs ~3s for critical; re-trigger with a short gap so it loops.
  sirenTimer = setInterval(beep, 4000);
}

function stopSirenLoop() {
  if (sirenTimer) { clearInterval(sirenTimer); sirenTimer = null; }
}

function renderSirenBanner() {
  let bar = document.getElementById('siren-banner');
  if (!sirenIncidents.length) {
    if (bar) bar.classList.add('hidden');
    stopSirenLoop();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'siren-banner';
    bar.className = 'banner-siren';
    document.body.insertBefore(bar, document.body.firstChild);
  }
  const worst = sirenIncidents.some(i => i.severity === 'critical') ? 'critical' : 'high';
  const first = sirenIncidents[0];
  const canStop = currentUser && ['admin', 'barangay_official', 'responder'].includes(currentUser.role);
  bar.classList.remove('hidden');
  bar.innerHTML = `
    <span class="siren-icon">🚨</span>
    <span class="siren-text">EMERGENCY SIREN &mdash; ${sirenIncidents.length} incident${sirenIncidents.length > 1 ? 's' : ''} awaiting rescue dispatch.
      Latest: <b>${escapeHtml((first.incident_type || '').replace('_', ' ').toUpperCase())}</b>
      ${first.barangay || first.address ? '&bull; ' + escapeHtml(first.barangay || first.address) : ''}</span>
    <span class="siren-actions">
      <button class="btn sm secondary" id="siren-mute-btn">${sirenMuted ? 'Unmute' : 'Mute'}</button>
      ${canStop ? '<button class="btn sm danger" id="siren-stop-btn">Stop Siren</button>' : ''}
    </span>`;
  const muteBtn = bar.querySelector('#siren-mute-btn');
  if (muteBtn) muteBtn.onclick = () => {
    sirenMuted = !sirenMuted;
    if (sirenMuted) stopSirenLoop(); else startSirenLoop(worst);
    renderSirenBanner();
  };
  const stopBtn = bar.querySelector('#siren-stop-btn');
  if (stopBtn) stopBtn.onclick = async () => {
    // Authorized override: acknowledge every active siren on the server.
    stopBtn.disabled = true;
    try {
      await Promise.all(sirenIncidents.map(i => api.post(`/api/incidents/${i.id}/siren-ack`)));
      toast('Emergency siren stopped.', 'success');
      await pollSirens();
    } catch (err) {
      toast('Could not stop siren: ' + err.message, 'error');
      stopBtn.disabled = false;
    }
  };
  if (!sirenMuted && !sirenRunning()) startSirenLoop(worst);
  else if (!sirenMuted && sirenRunning()) { /* keep looping */ }
}

async function pollSirens() {
  try {
    const rows = await api.get('/api/incidents/active-sirens');
    const wasEmpty = sirenIncidents.length === 0;
    sirenIncidents = Array.isArray(rows) ? rows : [];
    if (sirenIncidents.length && wasEmpty && !sirenMuted) {
      // A brand-new incident just started sounding - grab attention immediately.
      const worst = sirenIncidents.some(i => i.severity === 'critical') ? 'critical' : 'high';
      startSirenLoop(worst);
    }
    renderSirenBanner();
  } catch { /* offline or transient - keep whatever state we have */ }
}

function startSirenWatcher() {
  pollSirens();
  setInterval(pollSirens, 15000);
}

// ---------- System branding from settings (feature 6) ----------
// Applies the admin-configured name/logo/theme/contacts across any page.
let systemSettings = null;
async function applySystemSettings() {
  try {
    systemSettings = await api.get('/api/settings');
  } catch { return; }
  const s = systemSettings;
  if (s.theme_color) {
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
    meta.setAttribute('content', s.theme_color);
    // Recolor the shell: header + page background use these two vars.
    document.documentElement.style.setProperty('--navy', s.theme_color);
    document.documentElement.style.setProperty('--navy2', s.theme_color);
  }
  if (s.system_name) {
    // Set as plain text so the name wraps naturally in the header logo block.
    document.querySelectorAll('[data-brand-name]').forEach(el => { el.textContent = s.system_name; });
    if (s.short_name) document.title = `${s.short_name} - ${s.system_name}`;
  }
  if (s.logo_url) {
    document.querySelectorAll('[data-brand-logo]').forEach(el => { el.src = s.logo_url; });
    const link = document.querySelector('link[rel="icon"]');
    if (link) link.href = s.logo_url;
  }
  if (s.footer_text) {
    document.querySelectorAll('[data-brand-footer]').forEach(el => { el.textContent = s.footer_text; });
  }
  return s;
}

// ---------- Auto-refresh: poll for new alerts + notify pages ----------
const refreshHooks = [];
function onRefresh(fn) { if (typeof fn === 'function') refreshHooks.push(fn); }

function runRefreshHooks() {
  // Skip DOM reloads while a modal is open so the user's input isn't disrupted.
  if (document.querySelector('.modal-overlay.open')) return;
  for (const fn of refreshHooks) { try { fn(); } catch (e) { console.warn('refresh hook failed', e); } }
}

let lastAlertKey = null;   // signature of currently-known sent alerts
let alertWatchReady = false;

async function pollAlerts() {
  try {
    const alerts = await api.get('/api/alerts');
    const key = alerts.map(a => a.id).sort((x, y) => x - y).join(',');
    if (!alertWatchReady) { alertWatchReady = true; lastAlertKey = key; return; }
    if (key === lastAlertKey) return;
    const prev = new Set(String(lastAlertKey || '').split(',').filter(Boolean));
    const fresh = alerts.filter(a => !prev.has(String(a.id)));
    lastAlertKey = key;
    if (fresh.length) {
      const worst = fresh.some(a => a.severity === 'critical') ? 'critical'
        : fresh.some(a => a.severity === 'warning') ? 'warning' : 'info';
      alertAttention(worst);
      fresh.slice(0, 3).forEach(a => toast('🚨 ' + a.title, worst === 'info' ? '' : 'error'));
      runRefreshHooks();
    }
  } catch { /* offline or transient - ignore */ }
}

function startAlertWatcher() {
  pollAlerts();                       // set the baseline immediately
  setInterval(pollAlerts, 20000);     // new alerts -> sound + vibrate + refresh
  setInterval(runRefreshHooks, 60000); // periodic data refresh (incidents, etc.)

  // Instant in-app alarm when a background push arrives while the page is open.
  if ('serviceWorker' in navigator && navigator.serviceWorker.addEventListener) {
    navigator.serviceWorker.addEventListener('message', event => {
      const d = event.data;
      if (d && d.type === 'mdas-push') {
        alertAttention(d.severity || 'info');
        if (d.title) toast('🚨 ' + d.title, d.severity === 'info' ? '' : 'error');
        runRefreshHooks();
      }
    });
  }
}

// ---------- Chat answer rendering (preserves line breaks, shows source) ----------
function botAnswerHtml(r) {
  const text = escapeHtml(r && r.answer ? r.answer : '').replace(/\n/g, '<br>');
  const tag = r && r.source === 'gemini'
    ? '<div class="muted" style="font-size:11px;margin-top:6px">✨ Gemini AI</div>'
    : '';
  return text + tag;
}

// Boot common behavior on every page
document.addEventListener('DOMContentLoaded', () => {
  updateOnlineState();
  document.querySelectorAll('.install-btn').forEach(b => {
    b.addEventListener('click', () => installApp(b));
  });
  applySystemSettings();
  startAlertWatcher();
  startSirenWatcher();
});
