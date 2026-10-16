// Public homepage logic
let map = null;
const mapLayers = { incidents: null, evac: null, sensors: null, geofence: null, barangays: null, roads: null };

const RISK_COLORS = { critical: '#e63946', high: '#ff9f1c', moderate: '#f4d35e', low: '#2ecc71' };
const INCIDENT_ICONS = {
  fire: '🔥', flood: '🌊', landslide: '⛰️', medical: '🚑',
  accident: '🚗', storm_damage: '🌪️', earthquake: '🌍', other: '⚠️'
};

document.addEventListener('DOMContentLoaded', async () => {
  initMap();
  applyMapSettings();
  await loadCurrentUser();
  updateReportButton();
  initPWA(true);

  loadAlerts();
  loadMapData();
  loadWeather();
  loadContacts();
  loadOfficials();
  loadAdvisories();
  loadEvacuation();
  loadMissing();
  loadRisk();
  initChat();

  // Auto-refresh: when new alerts/data arrive, update the live sections.
  onRefresh(() => {
    loadAlerts();
    loadMapData();
    loadWeather();
    loadAdvisories();
    loadEvacuation();
    loadMissing();
    loadRisk();
  });

  document.getElementById('enable-push-btn').addEventListener('click', async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return toast('Push notifications are not supported in this browser.', 'error');
    }
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return toast('Service worker not ready yet, try again in a moment.', 'error');
    await subscribePush(reg);
  });

  document.getElementById('report-incident-btn').addEventListener('click', () => {
    if (!currentUser) { location.href = '/login.html?redirect=report'; return; }
    openModal('incident-modal');
  });
  document.getElementById('use-gps').addEventListener('click', useGps);
  document.getElementById('incident-form').addEventListener('submit', submitIncident);
});

function updateReportButton() {
  document.getElementById('report-hint').textContent =
    currentUser ? 'Reports are tracked: Reported → Verified → Responding → Resolved' : '(login required)';
}

// ---------- Map ----------
function initMap() {
  map = L.map('map').setView([10.394278, 125.198427], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
}

// Recenter the map from admin-configured settings (feature 6), if present.
async function applyMapSettings() {
  try {
    const s = systemSettings || await api.get('/api/settings');
    if (s && s.map_center_lat && s.map_center_lng && map) {
      map.setView([Number(s.map_center_lat), Number(s.map_center_lng)], Number(s.map_zoom) || 13);
    }
  } catch { /* keep the default view */ }
}

function circleIcon(color, label) {
  return L.divIcon({
    className: '',
    html: `<div style="background:${color};width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)">${label || ''}</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13]
  });
}

async function loadMapData() {
  try {
    const [incidents, evac, sensors, alerts, barangays, roads] = await Promise.all([
      api.get('/api/incidents'),
      api.get('/api/evacuation'),
      api.get('/api/flood/sensors'),
      api.get('/api/alerts'),
      api.get('/api/barangays'),
      api.get('/api/roads').catch(() => [])
    ]);

    Object.values(mapLayers).forEach(l => l && map.removeLayer(l));

    // Barangay risk markers
    mapLayers.barangays = L.layerGroup();
    (barangays.barangays || []).forEach(b => {
      if (b.latitude == null) return;
      L.marker([b.latitude, b.longitude], {
        icon: circleIcon(RISK_COLORS[b.overall_risk] || '#9b59b6', ''),
        opacity: 0.75
      }).bindPopup(`<b>Brgy. ${escapeHtml(b.name)}</b><br>
          Overall: <span class="badge ${b.overall_risk}">${b.overall_risk}</span><br>
          Flood: ${b.flood_risk} &bull; Landslide: ${b.landslide_risk}<br>
          Storm surge: ${b.storm_surge_risk} &bull; Earthquake: ${b.earthquake_risk}<br>
          Population: ${b.population} &bull; Open incidents: ${b.open_incidents}<br>
          <a href="https://www.google.com/maps?q=${b.latitude},${b.longitude}" target="_blank" rel="noopener noreferrer">Open in Google Maps 🗺️</a>`)
        .addTo(mapLayers.barangays);
    });

    // Open incidents
    mapLayers.incidents = L.layerGroup();
    incidents.filter(i => i.latitude != null && i.status !== 'resolved').forEach(i => {
      L.marker([i.latitude, i.longitude], { icon: circleIcon('#e63946', INCIDENT_ICONS[i.incident_type] || '⚠️') })
        .bindPopup(`<b>${i.incident_type.replace('_', ' ').toUpperCase()}</b> <span class="badge ${i.status}">${i.status}</span><br>${escapeHtml(i.description).slice(0, 160)}<br><small>${escapeHtml(i.address || i.barangay || '')} &bull; ${fmtDate(i.created_at)}</small>`)
        .addTo(mapLayers.incidents);
    });

    // Evacuation centers
    mapLayers.evac = L.layerGroup();
    evac.forEach(e => {
      if (e.latitude == null) return;
      const pct = e.capacity > 0 ? Math.round((e.occupants / e.capacity) * 100) : 0;
      L.marker([e.latitude, e.longitude], { icon: circleIcon('#2ecc71', '🏠') })
        .bindPopup(`<b>${escapeHtml(e.name)}</b><br>Status: ${e.status.toUpperCase()}<br>Occupants: ${e.occupants}/${e.capacity} (${pct}%)<br>${escapeHtml(e.address || '')}<br>${e.contact_phone ? '📞 ' + escapeHtml(e.contact_phone) : ''}`)
        .addTo(mapLayers.evac);
    });

    // Flood sensors
    mapLayers.sensors = L.layerGroup();
    sensors.forEach(s => {
      if (s.latitude == null) return;
      const color = s.latest_status === 'critical' ? '#e63946' : s.latest_status === 'alert' ? '#ff9f1c' : '#3d8bfd';
      L.marker([s.latitude, s.longitude], { icon: circleIcon(color, '💧') })
        .bindPopup(`<b>${escapeHtml(s.name)}</b><br>Latest: ${s.latest_level != null ? s.latest_level + ' m (' + s.latest_status + ')' : 'no reading'}<br>Alert: ${s.alert_level_m} m &bull; Critical: ${s.critical_level_m} m`)
        .addTo(mapLayers.sensors);
    });

    // Geofenced alerts
    mapLayers.geofence = L.layerGroup();
    alerts.filter(a => a.target_type === 'geofence' && a.geofence_lat != null).forEach(a => {
      L.circle([a.geofence_lat, a.geofence_lng], {
        radius: a.geofence_radius_m || 1000,
        color: '#ff9f1c', fillColor: '#ff9f1c', fillOpacity: 0.2, weight: 2, dashArray: '6 4'
      }).bindPopup(`<b>⚠ ${escapeHtml(a.title)}</b><br>${escapeHtml(a.message).slice(0, 200)}`)
        .addTo(mapLayers.geofence);
    });

    // Blocked / impassable roads
    mapLayers.roads = L.layerGroup();
    (roads || []).forEach(r => {
      const color = r.status === 'blocked' ? '#e63946' : r.status === 'partial' ? '#ff9f1c' : '#2ecc71';
      const popup = `<b>🚧 ${escapeHtml(r.road_name)}</b> <span class="badge ${r.status === 'blocked' ? 'critical' : 'warning'}">${r.status}</span><br>` +
        `${r.cause ? 'Cause: ' + escapeHtml(r.cause) + '<br>' : ''}` +
        `${r.description ? escapeHtml(String(r.description).slice(0, 160)) + '<br>' : ''}` +
        `<small>${escapeHtml(r.barangay || '')}${r.updated_at ? ' &bull; ' + fmtDate(r.updated_at) : ''}</small>`;
      // Draw a line if a path was supplied, otherwise drop a marker at the point.
      let path = null;
      if (r.path) { try { path = JSON.parse(r.path); } catch { path = null; } }
      if (Array.isArray(path) && path.length >= 2) {
        L.polyline(path, { color, weight: 6, opacity: 0.85, dashArray: r.status === 'partial' ? '8 6' : null })
          .bindPopup(popup).addTo(mapLayers.roads);
      }
      if (r.latitude != null && r.longitude != null) {
        L.marker([r.latitude, r.longitude], { icon: circleIcon(color, '🚧') })
          .bindPopup(popup).addTo(mapLayers.roads);
      }
    });

    Object.values(mapLayers).forEach(l => l && l.addTo(map));
  } catch (err) {
    console.error('Map data load failed:', err);
  }
}

// ---------- Alerts feed ----------
async function loadAlerts() {
  try {
    const alerts = await api.get('/api/alerts');
    const feed = document.getElementById('alerts-feed');
    const banner = document.getElementById('critical-banner');
    if (!alerts.length) {
      feed.innerHTML = '<p class="empty">No active alerts. The municipality is currently in normal status.</p>';
      banner.classList.add('hidden');
      return;
    }
    const critical = alerts.find(a => a.severity === 'critical');
    if (critical) {
      banner.textContent = `⚠ EMERGENCY: ${critical.title}`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
    feed.innerHTML = alerts.map(a => `
      <div class="alert-item severity-${a.severity}">
        <h4>${escapeHtml(a.title)} <span class="badge ${a.severity}">${a.severity}</span> <span class="badge info">${a.alert_type.replace('_', ' ')}</span></h4>
        <p>${escapeHtml(a.message)}</p>
        <div class="meta">
          ${a.barangays ? '📍 ' + escapeHtml(a.barangays) : (a.target_type === 'geofence' ? '📍 Geofenced danger area' : '📍 Municipality-wide')}
          &bull; ${fmtDate(a.sent_at)}
          ${a.expires_at ? ' &bull; until ' + fmtDate(a.expires_at) : ''}
        </div>
      </div>`).join('');
  } catch (err) {
    document.getElementById('alerts-feed').innerHTML = '<p class="empty">Unable to load alerts.</p>';
  }
}

// ---------- Weather ----------
async function loadWeather() {
  const area = document.getElementById('weather-area');
  try {
    const w = await api.get('/api/weather');
    if (w.error) { area.innerHTML = `<p class="empty">${escapeHtml(w.error)}</p>`; return; }
    const c = w.current || {};
    area.innerHTML = `
      <div class="weather-now">
        <div>
          <div class="weather-temp">${c.temperature_c != null ? Math.round(c.temperature_c) + '°C' : '--'}</div>
          <div class="weather-cond">${escapeHtml(c.condition || '')} &bull; ${escapeHtml(w.location)}</div>
        </div>
        <div class="weather-details">
          <span>Feels like</span><b>${c.feels_like_c != null ? Math.round(c.feels_like_c) + '°C' : '--'}</b>
          <span>Humidity</span><b>${c.humidity_pct != null ? c.humidity_pct + '%' : '--'}</b>
          <span>Wind</span><b>${c.wind_kph != null ? Math.round(c.wind_kph) + ' kph' : '--'}</b>
          <span>Gusts</span><b>${c.gusts_kph != null ? Math.round(c.gusts_kph) + ' kph' : '--'}</b>
        </div>
      </div>
      <div class="mt">
        ${(w.warnings || []).map(x => `<div class="warning-item ${x.level}">${escapeHtml(x.text)}</div>`).join('')}
      </div>
      ${w.forecast && w.forecast.length ? `
      <div class="forecast">
        ${w.forecast.map(f => `
          <div class="forecast-day">
            <div>${new Date(f.date).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', weekday: 'short' })}</div>
            <div>${escapeHtml(f.condition)}</div>
            <div><span class="tmax">${Math.round(f.temp_max)}°</span> / <span class="tmin">${Math.round(f.temp_min)}°</span></div>
            <div class="muted">${f.precipitation_mm} mm</div>
          </div>`).join('')}
      </div>` : ''}
      ${w.offline ? '<p class="muted mt">Showing cached weather data.</p>' : ''}`;
  } catch {
    area.innerHTML = '<p class="empty">Weather unavailable offline.</p>';
  }
}

// ---------- Emergency contacts ----------
async function loadContacts() {
  try {
    const contacts = await api.get('/api/contacts');
    document.getElementById('contacts-area').innerHTML = contacts.length
      ? contacts.map(c => {
          const dial = escapeHtml(String(c.phone).replace(/[^\d+]/g, ''));
          return `
        <div class="contact-item">
          <div><b>${escapeHtml(c.name)}</b><div class="cat">${escapeHtml(c.category)}</div></div>
          <div class="contact-actions">
            <a class="tel" href="tel:${dial}">${escapeHtml(c.phone)}</a>
            <a class="call-btn" href="tel:${dial}" title="Call ${escapeHtml(c.name)}">📞 Call</a>
          </div>
        </div>`;
        }).join('')
      : '<p class="empty">No contacts listed.</p>';
  } catch {
    document.getElementById('contacts-area').innerHTML = '<p class="empty">Unable to load contacts.</p>';
  }
}

// ---------- My barangay officials + hotlines (residents) ----------
async function loadOfficials() {
  const card = document.getElementById('officials-card');
  const area = document.getElementById('officials-area');
  if (!card || !area) return;
  // Only show to a logged-in user who has a barangay (their own officials).
  if (!currentUser || !currentUser.barangay_id) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  try {
    const rows = await api.get('/api/officials?mine=1');
    area.innerHTML = rows.length
      ? rows.map(o => {
          const dial = escapeHtml(String(o.phone || '').replace(/[^\d+]/g, ''));
          return `
        <div class="contact-item">
          <div><b>${escapeHtml(o.name)}</b><div class="cat">${escapeHtml(o.position || 'Official')}</div></div>
          <div class="contact-actions">
            ${o.phone ? `<a class="tel" href="tel:${dial}">${escapeHtml(o.phone)}</a>
            <a class="call-btn" href="tel:${dial}" title="Call ${escapeHtml(o.name)}">📞 Call</a>`
              : '<span class="muted">No hotline listed</span>'}
          </div>
        </div>`;
        }).join('')
      : '<p class="empty">No officials listed for your barangay yet.</p>';
  } catch {
    area.innerHTML = '<p class="empty">Unable to load barangay officials.</p>';
  }
}

// ---------- Official disaster advisories (feature 5) ----------
const ADVISORY_LEVEL_CLASS = { critical: 'critical', warning: 'warning', info: 'info' };
async function loadAdvisories() {
  const area = document.getElementById('advisories-area');
  if (!area) return;
  try {
    const rows = await api.get('/api/advisories?limit=12');
    if (!rows.length) {
      area.innerHTML = '<p class="empty">No official advisories at this time.</p>';
      return;
    }
    area.innerHTML = rows.map(a => {
      const lvl = ADVISORY_LEVEL_CLASS[a.alert_level] || 'info';
      return `
      <div class="advisory-item ${lvl}">
        <h4><span class="adv-agency">${escapeHtml(a.agency)}</span>${escapeHtml(a.title)}
          ${a.alert_level ? `<span class="badge ${lvl === 'info' ? 'info' : lvl}">${escapeHtml(a.alert_level)}</span>` : ''}</h4>
        ${a.affected_areas ? `<p>📍 ${escapeHtml(a.affected_areas)}</p>` : ''}
        ${a.details ? (a.advisory_type === 'daily_report'
          ? `<pre class="daily-report">${escapeHtml(a.details)}</pre>`
          : `<p>${escapeHtml(String(a.details).slice(0, 240))}</p>`) : ''}
        <div class="adv-meta">
          ${a.advisory_type ? escapeHtml(a.advisory_type.replace('_', ' ')) + ' &bull; ' : ''}
          ${a.issued_at ? 'Issued ' + fmtDate(a.issued_at) : ''}
          ${a.source_url ? ` &bull; <a href="${escapeHtml(a.source_url)}" target="_blank" rel="noopener noreferrer">source</a>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch {
    area.innerHTML = '<p class="empty">Unable to load advisories.</p>';
  }
}

// ---------- Evacuation centers ----------
async function loadEvacuation() {
  try {
    const centers = await api.get('/api/evacuation');
    document.getElementById('evac-area').innerHTML = centers.length ? `
      <table>
        <tr><th>Center</th><th>Barangay</th><th>Status</th><th>Occupancy</th></tr>
        ${centers.map(e => {
          const pct = e.capacity > 0 ? Math.round((e.occupants / e.capacity) * 100) : 0;
          const cls = pct >= 100 ? 'over' : pct >= 75 ? 'warn' : '';
          return `<tr>
            <td><b>${escapeHtml(e.name)}</b></td>
            <td>${escapeHtml(e.barangay || '-')}</td>
            <td><span class="badge ${e.status === 'open' ? 'resolved' : e.status === 'full' ? 'critical' : 'info'}">${e.status}</span></td>
            <td style="min-width:130px">${e.occupants}/${e.capacity}
              <div class="progress"><div class="${cls}" style="width:${Math.min(pct, 100)}%"></div></div>
            </td>
          </tr>`;
        }).join('')}
      </table>` : '<p class="empty">No evacuation centers listed.</p>';
  } catch {
    document.getElementById('evac-area').innerHTML = '<p class="empty">Unable to load.</p>';
  }
}

// ---------- Missing persons ----------
async function loadMissing() {
  try {
    const rows = await api.get('/api/missing');
    const area = document.getElementById('missing-area');
    const active = rows.filter(r => r.status === 'missing');
    area.innerHTML = (active.length || rows.length) ? rows.slice(0, 8).map(m => `
      <div class="alert-item missing-card" style="border-left-color:${m.status === 'missing' ? '#ff9f1c' : '#2ecc71'}">
        ${m.photo_path ? `<img class="missing-photo" src="${escapeHtml(m.photo_path)}" alt="Photo of ${escapeHtml(m.full_name)}" loading="lazy">` : ''}
        <div class="missing-body">
          <h4>${escapeHtml(m.full_name)} ${m.age ? '(' + m.age + ')' : ''}
            <span class="badge ${m.status === 'missing' ? 'warning' : 'resolved'}">${m.status}</span></h4>
          <p>${escapeHtml((m.description || '').slice(0, 120))}</p>
          <div class="meta">Last seen: ${escapeHtml(m.last_seen || m.barangay || 'unknown')} &bull; ${m.contact_phone ? 'Contact: ' + escapeHtml(m.contact_phone) : ''}</div>
        </div>
      </div>`).join('') : '<p class="empty">No missing-person reports. </p>';
  } catch {
    document.getElementById('missing-area').innerHTML = '<p class="empty">Unable to load.</p>';
  }
}

// ---------- Risk dashboard (public summary) ----------
function riskMapsLink(lat, lng) {
  if (lat == null || lng == null) return '<span class="muted">-</span>';
  return `<a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener noreferrer" title="Open in Google Maps">${lat}, ${lng} 🗺️</a>`;
}

async function loadRisk() {
  try {
    const { barangays, summary } = await api.get('/api/barangays');
    document.getElementById('risk-area').innerHTML = `
      <div class="grid cols-4" style="margin-bottom:12px">
        <div class="card stat red" style="padding:10px"><div class="num">${summary.critical}</div><div class="lbl">Critical</div></div>
        <div class="card stat orange" style="padding:10px"><div class="num">${summary.high}</div><div class="lbl">High</div></div>
        <div class="card stat" style="padding:10px"><div class="num" style="color:var(--yellow)">${summary.moderate}</div><div class="lbl">Moderate</div></div>
        <div class="card stat green" style="padding:10px"><div class="num">${summary.low}</div><div class="lbl">Low</div></div>
      </div>
      <div class="table-wrap"><table>
        <tr><th>Barangay</th><th>Flood</th><th>Landslide</th><th>Surge</th><th>Quake</th><th>Overall</th><th>Coordinates</th></tr>
        ${barangays.map(b => `
          <tr>
            <td>${escapeHtml(b.name)}</td>
            <td><span class="badge ${b.flood_risk}">${b.flood_risk}</span></td>
            <td><span class="badge ${b.landslide_risk}">${b.landslide_risk}</span></td>
            <td><span class="badge ${b.storm_surge_risk}">${b.storm_surge_risk}</span></td>
            <td><span class="badge ${b.earthquake_risk}">${b.earthquake_risk}</span></td>
            <td><span class="badge ${b.overall_risk}">${b.overall_risk}</span></td>
            <td>${riskMapsLink(b.latitude, b.longitude)}</td>
          </tr>`).join('')}
      </table></div>`;
  } catch {
    document.getElementById('risk-area').innerHTML = '<p class="empty">Unable to load.</p>';
  }
}

// ---------- AI assistant ----------
function initChat() {
  const log = document.getElementById('chat-log');
  const input = document.getElementById('chat-input');
  const send = async () => {
    const q = input.value.trim();
    if (!q) return;
    if (!currentUser) { toast('Please login to use the AI assistant.', 'error'); location.href = '/login.html'; return; }
    log.innerHTML += `<div class="chat-msg user">${escapeHtml(q)}</div>`;
    input.value = '';
    log.scrollTop = log.scrollHeight;
    try {
      const r = await api.post('/api/ai/chat', { question: q });
      log.innerHTML += `<div class="chat-msg bot">${botAnswerHtml(r)}</div>`;
    } catch (err) {
      log.innerHTML += `<div class="chat-msg bot">Sorry, I could not process that. ${escapeHtml(err.message)}</div>`;
    }
    log.scrollTop = log.scrollHeight;
  };
  document.getElementById('chat-send').addEventListener('click', send);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
}

// ---------- Incident reporting ----------
function useGps() {
  if (!navigator.geolocation) return toast('Geolocation is not supported by this browser.', 'error');
  toast('Getting your location...');
  navigator.geolocation.getCurrentPosition(pos => {
    document.getElementById('inc-lat').value = pos.coords.latitude.toFixed(6);
    document.getElementById('inc-lng').value = pos.coords.longitude.toFixed(6);
    toast('Location captured.', 'success');
  }, () => toast('Could not get GPS location. You can still submit without it.', 'error'));
}

async function submitIncident(e) {
  e.preventDefault();
  const fd = new FormData();
  fd.append('incident_type', document.getElementById('inc-type').value);
  fd.append('description', document.getElementById('inc-desc').value);
  fd.append('address', document.getElementById('inc-address').value);
  const sev = document.getElementById('inc-severity').value;
  if (sev) fd.append('severity', sev);
  const lat = document.getElementById('inc-lat').value;
  const lng = document.getElementById('inc-lng').value;
  if (lat && lng) { fd.append('latitude', lat); fd.append('longitude', lng); }
  const photo = document.getElementById('inc-photo').files[0];
  if (photo) fd.append('photo', photo);
  try {
    const r = await api.postForm('/api/incidents', fd);
    closeModal('incident-modal');
    let msg = `Report submitted (ID #${r.id}). Status: ${r.status}.`;
    if (r.auto_verified) msg = `Report auto-verified (ID #${r.id}).`;
    if (r.dispatched_team) msg += ` Rescue team dispatched: ${r.dispatched_team}.`;
    else if (!r.auto_verified) msg += ' Staff will verify it shortly.';
    toast(msg, 'success');
    e.target.reset();
    loadMapData();
  } catch (err) {
    toast(err.message, 'error');
  }
}
