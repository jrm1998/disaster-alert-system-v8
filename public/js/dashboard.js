// Dashboard logic - role-based panels and management features
let barangayList = [];
let teamList = [];
let activePanel = null;

const TAB_DEFS = [
  { panel: 'overview', label: 'Overview' },
  { panel: 'alerts', label: 'Alerts' },
  { panel: 'incidents', label: 'Incidents' },
  { panel: 'myreports', label: 'My Reports' },
  { panel: 'evac', label: 'Evacuation' },
  { panel: 'teams', label: 'Rescue Teams' },
  { panel: 'flood', label: 'Flood' },
  { panel: 'resources', label: 'Resources' },
  { panel: 'missing', label: 'Missing Persons' },
  { panel: 'roads', label: 'Roads' },
  { panel: 'officials', label: 'Officials' },
  { panel: 'barangays', label: 'Barangay Risk' },
  { panel: 'contacts', label: 'Contacts' },
  { panel: 'users', label: 'Users' },
  { panel: 'reports', label: 'Reports' },
  { panel: 'advisories', label: 'Advisories' },
  { panel: 'logs', label: 'Activity Logs' },
  { panel: 'settings', label: 'Settings' },
  { panel: 'ai', label: 'AI Assistant' }
];

const LOADERS = {
  overview: loadOverview, alerts: loadAlertsManage, incidents: loadIncidentsAdmin,
  myreports: loadMyReports, evac: loadEvacAdmin, teams: loadTeamsAdmin,
  flood: loadFloodAdmin, resources: loadResourcesAdmin, missing: loadMissingAdmin,
  roads: loadRoadsAdmin, officials: loadOfficialsAdmin,
  barangays: loadBarangaysAdmin, contacts: loadContactsAdmin, users: loadUsersAdmin,
  reports: () => {}, advisories: loadAdvisoriesAdmin, logs: loadLogs,
  settings: loadSettingsAdmin, ai: () => {}
};

document.addEventListener('DOMContentLoaded', async () => {
  currentUser = await loadCurrentUser();
  if (!currentUser) { location.href = '/login.html'; return; }

  barangayList = await api.get('/api/auth/barangays').catch(() => []);
  fillBarangaySelects();
  buildTabs();
  bindForms();
  initDashChat();
  renderGpsToggle();

  // Auto-refresh: reload the currently visible tab when new data/alerts arrive.
  onRefresh(() => {
    if (activePanel && LOADERS[activePanel]) {
      LOADERS[activePanel]().catch(() => {});
    }
  });

  const first = document.querySelector('.tab');
  if (first) first.click();
});

function hasRole(roles) {
  return roles.split(',').includes(currentUser.role);
}

// Header toggle for staff live GPS sharing (feature 1). Residents never see it.
function renderGpsToggle() {
  const el = document.getElementById('gps-toggle');
  if (!el) return;
  if (typeof isGpsStaff !== 'function' || !isGpsStaff()) { el.innerHTML = ''; return; }
  const on = gpsSharingEnabled();
  el.innerHTML = `<button class="btn sm ${on ? 'success' : 'secondary'}" id="gps-share-btn"
      title="${on ? 'Stop sharing your live location with dispatch' : 'Share your live location so you appear on incident maps'}">
      ${on ? '📍 Sharing location' : '📍 Share my location'}</button>`;
  const btn = el.querySelector('#gps-share-btn');
  if (btn) btn.onclick = () => setLocationSharing(!on);
}

function fillBarangaySelects() {
  const opts = '<option value="">-- none --</option>' +
    barangayList.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  ['evc-barangay', 'fs-barangay', 'mp-barangay', 'us-barangay', 'ue-barangay', 'rb-barangay', 'bo-barangay'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = opts;
  });
  const rpt = document.getElementById('rpt-barangay');
  if (rpt) rpt.innerHTML = '<option value="">All</option>' +
    barangayList.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  const wrap = document.getElementById('al-barangays');
  if (wrap) wrap.innerHTML = barangayList.map(b =>
    `<label><input type="checkbox" value="${b.id}"> ${escapeHtml(b.name)}</label>`).join('');
}

function buildTabs() {
  const tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = '';
  TAB_DEFS.forEach(def => {
    const panel = document.getElementById('panel-' + def.panel);
    if (!panel || !hasRole(panel.dataset.roles)) return;
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.textContent = def.label;
    btn.onclick = () => activateTab(def.panel);
    tabsEl.appendChild(btn);
  });
  // Hide inline buttons the user's role cannot use
  document.querySelectorAll('[data-roles-inline]').forEach(el => {
    if (!hasRole(el.dataset.rolesInline)) el.classList.add('hidden');
  });
}

function activateTab(panelName) {
  activePanel = panelName;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const panel = document.getElementById('panel-' + panelName);
  if (panel) panel.classList.add('active');
  const tabs = [...document.querySelectorAll('.tab')];
  const idx = TAB_DEFS.filter(d => {
    const p = document.getElementById('panel-' + d.panel);
    return p && hasRole(p.dataset.roles);
  }).findIndex(d => d.panel === panelName);
  if (tabs[idx]) tabs[idx].classList.add('active');
  if (LOADERS[panelName]) LOADERS[panelName]().catch(err => toast(err.message, 'error'));
}

// ================= OVERVIEW =================
async function loadOverview() {
  const s = await api.get('/api/stats');
  document.getElementById('stat-cards').innerHTML = `
    <div class="card stat"><div class="num">${s.incidents.total}</div><div class="lbl">Total Incidents</div></div>
    <div class="card stat orange"><div class="num">${Number(s.incidents.reported) + Number(s.incidents.verified) + Number(s.incidents.responding)}</div><div class="lbl">Open Incidents</div></div>
    <div class="card stat red"><div class="num">${s.evacuation.total_evacuees}</div><div class="lbl">Evacuees</div></div>
    <div class="card stat"><div class="num">${s.alerts.sent}</div><div class="lbl">Alerts Sent</div></div>
    <div class="card stat green"><div class="num">${s.teams.available}/${s.teams.total}</div><div class="lbl">Teams Available</div></div>
    <div class="card stat red"><div class="num">${s.missing.missing}</div><div class="lbl">Missing</div></div>
    <div class="card stat orange"><div class="num">${s.resources.below_minimum}</div><div class="lbl">Resources Low</div></div>
    <div class="card stat"><div class="num">${s.incidents.last_7_days}</div><div class="lbl">Incidents (7d)</div></div>`;

  const alerts = await api.get('/api/alerts/manage/list');
  const pending = alerts.filter(a => a.status === 'pending_approval');
  document.getElementById('pending-alerts').innerHTML = pending.length
    ? pending.map(a => `<div class="alert-item severity-${a.severity}">
        <h4>${escapeHtml(a.title)} <span class="badge ${a.severity}">${a.severity}</span></h4>
        <p class="meta">by ${escapeHtml(a.created_by_name || '?')} &bull; ${fmtDate(a.created_at)}</p>
        <div class="section-actions mt">
          ${currentUser.role === 'admin' ? `<button class="btn success sm" onclick="alertAction(${a.id},'approve')">Approve</button>` : ''}
          <button class="btn secondary sm" onclick="viewAlert(${a.id})">View</button>
        </div>
      </div>`).join('')
    : '<p class="empty">No alerts pending approval.</p>';

  const incidents = await api.get('/api/incidents');
  document.getElementById('recent-incidents').innerHTML = `
    <table><tr><th>ID</th><th>Type</th><th>Status</th><th>When</th></tr>
    ${incidents.slice(0, 8).map(i => `<tr>
      <td><a href="#" onclick="viewIncident(${i.id});return false">#${i.id}</a></td>
      <td>${i.incident_type.replace('_', ' ')}</td>
      <td><span class="badge ${i.status}">${i.status}</span></td>
      <td>${fmtDate(i.created_at)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">None</td></tr>'}
    </table>`;

  const teams = await api.get('/api/teams');
  document.getElementById('overview-teams').innerHTML = `
    <table><tr><th>Team</th><th>Status</th><th>Active incident</th></tr>
    ${teams.map(t => `<tr><td>${escapeHtml(t.name)}</td>
      <td><span class="badge ${t.status === 'available' ? 'resolved' : t.status === 'off_duty' ? 'info' : 'warning'}">${t.status.replace('_', ' ')}</span></td>
      <td>${t.active_incident_id ? '#' + t.active_incident_id : '-'}</td></tr>`).join('')}
    </table>`;

  const resources = await api.get('/api/resources');
  const low = resources.filter(r => Number(r.below_minimum));
  document.getElementById('low-resources').innerHTML = low.length
    ? low.map(r => `<div class="warning-item warning"><b>${escapeHtml(r.name)}</b>: ${r.quantity} ${escapeHtml(r.unit)} (min ${r.minimum_level})</div>`).join('')
    : '<p class="empty">All resources are above minimum levels.</p>';
}

// ================= ALERTS =================
let alertsCache = [];

async function loadAlertsManage() {
  alertsCache = await api.get('/api/alerts/manage/list');
  const body = document.getElementById('alerts-manage-body');
  body.innerHTML = alertsCache.map(a => `
    <tr>
      <td><b>${escapeHtml(a.title)}</b><br><small class="muted">${a.source === 'ai_import' ? 'AI imported' : a.source === 'flood_auto' ? 'Automatic (flood)' : 'Manual'}${a.barangays ? ' &bull; ' + escapeHtml(a.barangays) : ''}</small></td>
      <td><span class="badge ${a.severity}">${a.severity}</span></td>
      <td>${a.target_type}${a.target_type === 'geofence' ? ` (${a.geofence_radius_m}m)` : ''}</td>
      <td><span class="badge ${a.status === 'sent' ? 'resolved' : a.status === 'pending_approval' ? 'warning' : a.status === 'approved' ? 'info' : a.status === 'cancelled' ? 'critical' : 'info'}">${a.status.replace('_', ' ')}</span></td>
      <td>${fmtDate(a.created_at)}<br><small class="muted">${escapeHtml(a.created_by_name || '')}</small></td>
      <td>
        <div class="section-actions">
          <button class="btn secondary sm" onclick="viewAlert(${a.id})">View</button>
          ${a.status === 'draft' && canCreateAlerts() ? `<button class="btn sm" onclick="alertAction(${a.id},'submit')">Submit</button>` : ''}
          ${a.status === 'pending_approval' && currentUser.role === 'admin' && a.created_by !== currentUser.id ? `<button class="btn success sm" onclick="alertAction(${a.id},'approve')">Approve</button><button class="btn danger sm" onclick="alertAction(${a.id},'reject')">Reject</button>` : ''}
          ${a.status === 'approved' && currentUser.role === 'admin' ? `<button class="btn warning sm" onclick="alertAction(${a.id},'send')">Send Now</button>` : ''}
          ${['sent', 'approved'].includes(a.status) && currentUser.role === 'admin' ? `<button class="btn danger sm" onclick="alertAction(${a.id},'cancel')">Cancel</button>` : ''}
        </div>
      </td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">No alerts yet.</td></tr>';
}

function canCreateAlerts() {
  return ['admin', 'barangay_official'].includes(currentUser.role);
}

async function alertAction(id, action) {
  const labels = { submit: 'submit for approval', approve: 'APPROVE', reject: 'reject (return to draft)', send: 'SEND this alert to the public now', cancel: 'CANCEL this alert' };
  if (!confirm(`Are you sure you want to ${labels[action]}?`)) return;
  try {
    const r = await api.post(`/api/alerts/${id}/${action}`, {});
    toast(`Alert ${action} successful.` + (r.pushed_to !== undefined ? ` Pushed to ${r.pushed_to} device(s), ${r.barangays_affected} barangay(s).` : ''), 'success');
    loadAlertsManage();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function viewAlert(id) {
  api.get('/api/alerts/' + id).then(a => {
    const el = document.getElementById('incident-detail');
    el.innerHTML = `
      <h4>${escapeHtml(a.title)}</h4>
      <p class="mt">${escapeHtml(a.message)}</p>
      <div class="meta mt muted">
        Type: ${a.alert_type} &bull; Severity: <span class="badge ${a.severity}">${a.severity}</span> &bull; Status: ${a.status}<br>
        Target: ${a.target_type}${a.target_type === 'geofence' ? ` (center ${a.geofence_lat},${a.geofence_lng}, radius ${a.geofence_radius_m}m)` : ''}<br>
        ${a.target_barangays && a.target_barangays.length ? 'Barangays: ' + a.target_barangays.map(b => escapeHtml(b.name)).join(', ') + '<br>' : ''}
        Created: ${fmtDate(a.created_at)} &bull; Approved: ${fmtDate(a.approved_at) || '-'} &bull; Sent: ${fmtDate(a.sent_at) || '-'}
        ${a.expires_at ? '<br>Expires: ' + fmtDate(a.expires_at) : ''}
      </div>`;
    // reuse the generic detail modal
    openModal('incident-view-modal');
    document.querySelector('#incident-view-modal h3').textContent = 'Alert Details';
  }).catch(err => toast(err.message, 'error'));
}

function onAlertTargetChange() {
  const t = document.getElementById('al-target').value;
  document.getElementById('al-barangays-wrap').classList.toggle('hidden', t !== 'barangay');
  document.getElementById('al-geofence-wrap').classList.toggle('hidden', t !== 'geofence');
}

async function previewGeofence() {
  const lat = document.getElementById('al-geo-lat').value;
  const lng = document.getElementById('al-geo-lng').value;
  const radius = document.getElementById('al-geo-radius').value;
  const out = document.getElementById('geofence-preview-result');
  try {
    const r = await api.post('/api/alerts/geofence/preview', { lat: Number(lat), lng: Number(lng), radius_m: Number(radius) });
    out.textContent = r.barangays.length
      ? 'Affected barangays: ' + r.barangays.map(b => b.name).join(', ')
      : 'No barangay centers fall inside this radius (users with GPS inside the area still receive the alert).';
  } catch (err) {
    out.textContent = err.message;
  }
}

async function submitAlert(submit) {
  const target = document.getElementById('al-target').value;
  const barangayIds = [...document.querySelectorAll('#al-barangays input:checked')].map(c => Number(c.value));
  const expires = document.getElementById('al-expires').value;
  const payload = {
    title: document.getElementById('al-title').value,
    message: document.getElementById('al-message').value,
    alert_type: document.getElementById('al-type').value,
    severity: document.getElementById('al-severity').value,
    target_type: target,
    submit: !!submit,
    barangay_ids: target === 'barangay' ? barangayIds : undefined,
    geofence_lat: target === 'geofence' ? document.getElementById('al-geo-lat').value : undefined,
    geofence_lng: target === 'geofence' ? document.getElementById('al-geo-lng').value : undefined,
    geofence_radius_m: target === 'geofence' ? document.getElementById('al-geo-radius').value : undefined,
    // The datetime-local value is already Philippine wall-clock (UTC+8) and the
    // DB session runs in UTC+8, so store it verbatim (no UTC round-trip).
    expires_at: expires ? expires.replace('T', ' ') + (expires.length === 16 ? ':00' : '') : undefined
  };
  try {
    await api.post('/api/alerts', payload);
    toast(submit ? 'Alert submitted for approval.' : 'Draft saved.', 'success');
    closeModal('alert-create-modal');
    document.getElementById('alert-form').reset();
    onAlertTargetChange();
    loadAlertsManage();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ================= INCIDENTS =================
async function loadIncidentsAdmin() {
  const status = document.getElementById('inc-filter-status').value;
  const incidents = await api.get('/api/incidents' + (status ? '?status=' + status : ''));
  const body = document.getElementById('incidents-admin-body');
  const canDispatch = ['admin', 'barangay_official'].includes(currentUser.role);
  body.innerHTML = incidents.map(i => {
    const sev = i.severity || 'moderate';
    const sirenActive = ['reported', 'verified'].includes(i.status) && !i.assigned_team && !i.siren_acknowledged;
    return `
    <tr>
      <td>#${i.id}${i.auto_verified ? '<br><small class="muted">auto-verified</small>' : ''}${i.is_duplicate ? `<br><span class="badge info">dup of #${i.primary_incident_id}</span>` : ''}${i.duplicate_count > 0 ? `<br><span class="badge warning">${i.duplicate_count} dup</span>` : ''}</td>
      <td>${i.incident_type.replace('_', ' ')}${i.photo_path ? '<br><img class="thumb" src="' + i.photo_path + '" onclick="window.open(this.src)" alt="incident photo">' : ''}</td>
      <td><span class="badge ${sev === 'critical' || sev === 'high' ? sev : sev === 'moderate' ? 'warning' : 'info'}">${sev}</span></td>
      <td style="max-width:240px">${escapeHtml(i.description).slice(0, 120)}</td>
      <td>${escapeHtml(i.barangay || '-')}</td>
      <td><span class="badge ${i.status}">${i.status}</span>${i.assigned_team ? '<br><small class="muted">' + escapeHtml(i.assigned_team) + '</small>' : ''}${sirenActive ? '<br><small style="color:var(--red)">🚨 siren</small>' : ''}</td>
      <td>${fmtDate(i.created_at)}</td>
      <td>
        <div class="section-actions">
          <button class="btn secondary sm" onclick="viewIncident(${i.id})">Details</button>
          ${i.status !== 'resolved' ? `<button class="btn sm" onclick="openIncidentStatus(${i.id}, '${i.status}')">Update</button>` : ''}
          ${canDispatch && i.status !== 'resolved' ? `<button class="btn warning sm" onclick="openDispatch(${i.id}, ${i.assigned_team ? "'" + i.assigned_team.replace(/'/g, '') + "'" : 'null'})">Dispatch</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">No incidents.</td></tr>';
}

// Manual dispatch / override of the automatic assignment (safety: admin override).
async function openDispatch(id, currentTeamName) {
  try {
    teamList = await api.get('/api/teams');
    const choice = prompt(
      'Dispatch a rescue team to incident #' + id + '.\n' +
      (currentTeamName ? 'Currently assigned: ' + currentTeamName + ' (enter a new name to reassign).\n' : '') +
      'Available teams:\n' +
      teamList.map(t => `  ${t.id} - ${t.name} (${t.status.replace('_', ' ')}${t.specialty ? ', ' + t.specialty : ''})`).join('\n') +
      '\n\nEnter the team ID to dispatch:'
    );
    if (choice == null || String(choice).trim() === '') return;
    const teamId = Number(String(choice).trim());
    if (!teamId || !teamList.some(t => t.id === teamId)) return toast('Invalid team ID.', 'error');
    const r = await api.post(`/api/incidents/${id}/dispatch`, { team_id: teamId });
    toast(`Dispatched ${r.dispatched_team}. Siren silenced.`, 'success');
    loadIncidentsAdmin();
    pollSirens();
  } catch (err) { toast(err.message, 'error'); }
}

async function viewIncident(id) {
  try {
    const i = await api.get('/api/incidents/' + id);
    document.querySelector('#incident-view-modal h3').textContent = 'Incident #' + i.id;
    const steps = ['reported', 'verified', 'responding', 'resolved'];
    const curIdx = steps.indexOf(i.status);
    const sev = i.severity || 'moderate';
    const canAck = ['admin', 'barangay_official', 'responder'].includes(currentUser.role);
    const canDispatch = ['admin', 'barangay_official'].includes(currentUser.role);
    const needsAck = i.assigned_team && !i.dispatch_acknowledged_at;
    document.getElementById('incident-detail').innerHTML = `
      <div class="status-flow">${steps.map((s, idx) => `
        <span class="step ${idx <= curIdx ? 'done' : ''}">${s}</span>
        ${idx < steps.length - 1 ? '<span class="arrow">&rarr;</span>' : ''}`).join('')}</div>
      <p class="mt"><b>${i.incident_type.replace('_', ' ')}</b>
        <span class="badge ${sev === 'critical' || sev === 'high' ? sev : sev === 'moderate' ? 'warning' : 'info'}">${sev}</span>
        &bull; ${escapeHtml(i.barangay || 'unassigned')} &bull; ${fmtDate(i.created_at)}</p>
      <p class="mt">${escapeHtml(i.description)}</p>
      ${i.photo_path ? `<img src="${i.photo_path}" style="max-width:100%;border-radius:8px;margin-top:10px" alt="incident photo">` : ''}
      ${i.address ? `<p class="muted mt">📍 ${escapeHtml(i.address)} ${i.latitude != null ? `(${i.latitude}, ${i.longitude})` : ''}</p>` : ''}
      <p class="muted">Reported by: ${escapeHtml(i.reporter || 'unknown')}
        ${i.auto_verified ? ' &bull; <b>Auto-verified</b> (authorized official)' : ''}
        ${i.verified_by_name ? ' &bull; Verified by: ' + escapeHtml(i.verified_by_name) : ''}
        ${i.verified_at ? ' (' + fmtDate(i.verified_at) + ')' : ''}</p>
      ${i.assigned_team ? `<p class="muted">Rescue team: <b>${escapeHtml(i.assigned_team)}</b>
        ${i.dispatch_acknowledged_at ? '&bull; acknowledged ' + fmtDate(i.dispatch_acknowledged_at)
          : (needsAck && canAck ? `&bull; <button class="btn sm success" onclick="ackDispatch(${i.id}, ${i.dispatch_id})">Acknowledge dispatch</button>` : '&bull; awaiting acknowledgment')}</p>` : ''}
      ${i.resolved_at ? `<p class="muted" style="color:var(--green)">Resolved ${fmtDate(i.resolved_at)}${i.resolution_note ? ' &bull; ' + escapeHtml(i.resolution_note) : ''}</p>` : ''}
      ${canAck && i.status !== 'resolved' ? `
      <div class="section-actions mt">
        <button class="btn warning sm" onclick="requestBackup(${i.id})">📣 Request Backup</button>
        <span class="muted">Notifies nearby responders not on the dispatched team.</span>
      </div>` : ''}
      ${i.is_duplicate ? `<p class="mt"><span class="badge info">Consolidated</span> This report is a duplicate of incident #${i.primary_incident_id}.
        ${canDispatch ? `<button class="btn secondary sm" onclick="unconsolidate(${i.id})">Unlink</button>` : ''}</p>` : ''}
      ${canDispatch && (i.possible_duplicates && i.possible_duplicates.length) ? `
      <div class="mt dup-box">
        <b>Possible duplicate reports</b>
        <p class="muted">Same type within ~200 m and ~20 min. Select to consolidate under this incident (originals are kept as evidence).</p>
        <table>${i.possible_duplicates.map(d => `
          <tr>
            <td><input type="checkbox" class="dup-check" value="${d.id}"></td>
            <td>#${d.id}</td>
            <td>${escapeHtml(String(d.description || '').slice(0, 60))}</td>
            <td>${d.distance_m} m</td>
            <td>${fmtDate(d.created_at)}</td>
          </tr>`).join('')}</table>
        <div class="section-actions mt">
          <button class="btn sm" onclick="consolidateDuplicates(${i.id})">Consolidate Selected</button>
        </div>
      </div>` : ''}
      ${canDispatch && i.duplicates && i.duplicates.length ? `
      <div class="mt">
        <b>Consolidated duplicates (${i.duplicates.length})</b>
        <table>${i.duplicates.map(d => `
          <tr><td>#${d.id}</td><td>${escapeHtml(String(d.description || '').slice(0, 60))}</td>
          <td><span class="badge ${d.status}">${d.status}</span></td><td>${fmtDate(d.created_at)}</td>
          <td><button class="btn secondary sm" onclick="unconsolidate(${d.id})">Unlink</button></td></tr>`).join('')}</table>
      </div>` : ''}
      <div class="mt"><b>History</b>
        <table>${i.history.map(h => `<tr><td><span class="badge ${h.status}">${h.status}</span></td><td>${escapeHtml(h.note || '')}</td><td>${escapeHtml(h.changed_by || 'system')}</td><td>${fmtDate(h.created_at)}</td></tr>`).join('')}</table>
      </div>
      ${i.latitude != null && i.longitude != null ? `
      <div class="mt">
        <b>Incident map &amp; nearby responders</b>
        <div id="incident-map" style="height:300px;border-radius:8px;margin-top:8px;border:1px solid var(--line)"></div>
        <div id="nearby-responders" class="mt"><p class="muted">Loading nearby responders...</p></div>
      </div>` : ''}`;
    openModal('incident-view-modal');
    if (i.latitude != null && i.longitude != null) {
      renderIncidentMap(i);
      loadNearbyResponders(i);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// Feature 3: interactive map of the incident + nearby responders. Leaflet markers
// are (re)drawn each time; nearby-responder pins are refreshed from the server.
let incidentMap = null;
let incidentMapLayers = null;
function renderIncidentMap(incident) {
  if (typeof L === 'undefined') return;
  const el = document.getElementById('incident-map');
  if (!el) return;
  if (incidentMap) { incidentMap.remove(); incidentMap = null; }
  incidentMap = L.map('incident-map').setView([Number(incident.latitude), Number(incident.longitude)], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; OpenStreetMap contributors'
  }).addTo(incidentMap);
  incidentMapLayers = L.layerGroup().addTo(incidentMap);
  L.marker([Number(incident.latitude), Number(incident.longitude)], { icon: pinIcon('#e63946', '📍') })
    .bindPopup(`<b>Incident #${incident.id}</b><br>${escapeHtml(incident.incident_type.replace('_', ' '))}`)
    .addTo(incidentMapLayers);
  // Draw responder pins once their positions load.
  setTimeout(() => { if (incidentMap) incidentMap.invalidateSize(); }, 200);
}

function pinIcon(color, label) {
  return L.divIcon({
    className: '',
    html: `<div style="background:${color};width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)"><span style="transform:rotate(45deg);font-size:13px">${label || ''}</span></div>`,
    iconSize: [28, 28], iconAnchor: [14, 28]
  });
}

async function loadNearbyResponders(incident) {
  const panel = document.getElementById('nearby-responders');
  if (!panel) return;
  try {
    const data = await api.get(`/api/incidents/${incident.id}/nearby-responders`);
    const nearest = data.nearest || [];
    // Plot every known responder on the map (highlight the three nearest).
    if (incidentMap && incidentMapLayers) {
      (data.all || []).forEach(r => {
        const isTop = nearest.some(n => n.id === r.id);
        L.marker([r.latitude, r.longitude], { icon: pinIcon(isTop ? '#2ecc71' : '#3d8bfd', '🚑') })
          .bindPopup(`<b>${escapeHtml(r.name)}</b><br>${escapeHtml((r.role || '').replace('_', ' '))}` +
            `${r.team_name ? ' &bull; ' + escapeHtml(r.team_name) : ''}<br>` +
            `${r.distance_m != null ? (r.distance_m / 1000).toFixed(1) + ' km away' : ''}` +
            `${r.on_scene ? '<br><b style="color:#2ecc71">Already on scene</b>' : ''}` +
            `${r.phone ? `<br><a href="tel:${escapeHtml(String(r.phone).replace(/[^\d+]/g, ''))}">📞 ${escapeHtml(r.phone)}</a>` : ''}`)
          .addTo(incidentMapLayers);
      });
    }

    let html = '';
    if (data.on_scene && data.on_scene.length) {
      html += `<div class="advisory-item warning" style="margin-bottom:8px">
        <h4>⚠ ${data.on_scene.length} responder${data.on_scene.length > 1 ? 's' : ''} already on scene (not on the dispatched team)</h4>
        <p class="muted">Administrators have been notified to coordinate and avoid duplicate deployment.</p>
        ${data.on_scene.map(r => `<div>• ${escapeHtml(r.name)} ${r.team_name ? '(' + escapeHtml(r.team_name) + ')' : ''}
          ${r.phone ? `<a class="call-btn" href="tel:${escapeHtml(String(r.phone).replace(/[^\d+]/g, ''))}">📞 Call</a>` : ''}
          ${r.id ? `<button class="btn sm call-video" data-call-user="${r.id}" data-call-name="${escapeHtml(r.name)}" data-call-incident="${incident.id}">📹 Video</button>` : ''}</div>`).join('')}
      </div>`;
    }
    if (nearest.length) {
      html += `<div><b>${nearest.length} nearest responder${nearest.length > 1 ? 's' : ''}</b></div>` +
        nearest.map((r, idx) => `<div class="contact-item">
          <div><b>${idx + 1}. ${escapeHtml(r.name)}</b>
            <div class="cat">${escapeHtml((r.role || '').replace('_', ' '))}${r.team_name ? ' &bull; ' + escapeHtml(r.team_name) : ''}
            ${r.distance_m != null ? ' &bull; ' + (r.distance_m / 1000).toFixed(1) + ' km' : ''}
            ${r.on_scene ? ' &bull; <b style="color:var(--green)">on scene</b>' : ''}</div></div>
          <div class="contact-actions">
            ${r.phone ? `<a class="tel" href="tel:${escapeHtml(String(r.phone).replace(/[^\d+]/g, ''))}">${escapeHtml(r.phone)}</a>
            <a class="call-btn" href="tel:${escapeHtml(String(r.phone).replace(/[^\d+]/g, ''))}" title="Call ${escapeHtml(r.name)}">📞 Call</a>`
            : '<span class="muted">no phone</span>'}
            <button class="btn sm call-video" data-call-user="${r.id}" data-call-name="${escapeHtml(r.name)}" data-call-incident="${incident.id}" title="Video call">📹 Video</button>
          </div>
        </div>`).join('');
    } else {
      html += '<p class="empty">No responders are currently sharing their location near this incident.</p>';
    }
    panel.innerHTML = html;
    // Wire the video-call buttons (avoid inline quoting of names) and reflect
    // who is currently online for calling.
    panel.querySelectorAll('[data-call-user]').forEach(btn => {
      btn.addEventListener('click', () => startCall(
        Number(btn.getAttribute('data-call-user')),
        btn.getAttribute('data-call-name'),
        Number(btn.getAttribute('data-call-incident'))
      ));
    });
    if (typeof refreshCallableRoster === 'function') refreshCallableRoster();
  } catch (err) {
    panel.innerHTML = `<p class="empty">Unable to load nearby responders: ${escapeHtml(err.message)}</p>`;
  }
}

async function ackDispatch(incidentId, dispatchId) {
  if (!dispatchId) return toast('No active dispatch found.', 'error');
  try {
    await api.post(`/api/teams/dispatches/${dispatchId}/acknowledge`);
    toast('Dispatch acknowledged.', 'success');
    viewIncident(incidentId);
  } catch (err) { toast(err.message, 'error'); }
}

// Feature: request backup - notify nearby off-team responders.
async function requestBackup(incidentId) {
  try {
    const r = await api.post(`/api/incidents/${incidentId}/request-backup`, {});
    if (r.deduped) toast('Backup was already requested recently for this incident.', 'info');
    else if (r.notified > 0) toast(`Backup requested - ${r.notified} nearby responder(s) notified.`, 'success');
    else if (r.reason === 'no_coords') toast('This incident has no coordinates, so nearby responders cannot be located.', 'error');
    else toast('No nearby off-team responders available to notify.', 'info');
  } catch (err) { toast(err.message, 'error'); }
}

// Feature 9: consolidate selected duplicate reports under this primary incident.
async function consolidateDuplicates(primaryId) {
  const ids = [...document.querySelectorAll('.dup-check:checked')].map(c => Number(c.value));
  if (!ids.length) return toast('Select at least one duplicate report to consolidate.', 'error');
  if (!confirm(`Consolidate ${ids.length} report(s) under incident #${primaryId}? The originals are kept as evidence.`)) return;
  try {
    await api.post(`/api/incidents/${primaryId}/consolidate`, { duplicate_ids: ids });
    toast('Reports consolidated.', 'success');
    viewIncident(primaryId);
    loadIncidentsAdmin();
  } catch (err) { toast(err.message, 'error'); }
}

async function unconsolidate(dupId) {
  if (!confirm('Unlink this report so it stands alone again?')) return;
  try {
    await api.post(`/api/incidents/${dupId}/unconsolidate`, {});
    toast('Report unlinked.', 'success');
    closeModal('incident-view-modal');
    loadIncidentsAdmin();
  } catch (err) { toast(err.message, 'error'); }
}

async function openIncidentStatus(id, current) {
  document.getElementById('is-id').value = id;
  document.getElementById('is-note').value = '';
  const steps = ['reported', 'verified', 'responding', 'resolved'];
  const curIdx = steps.indexOf(current);
  document.getElementById('inc-status-flow').innerHTML = steps.map((s, idx) => `
    <span class="step ${idx <= curIdx ? 'done' : ''}">${s}</span>
    ${idx < steps.length - 1 ? '<span class="arrow">&rarr;</span>' : ''}`).join('');
  // load teams for dispatch
  teamList = await api.get('/api/teams');
  const teamSel = document.getElementById('is-team');
  teamSel.innerHTML = '<option value="">-- no team --</option>' +
    teamList.map(t => `<option value="${t.id}">${escapeHtml(t.name)} (${t.status.replace('_', ' ')})</option>`).join('');
  document.getElementById('is-team-wrap').classList.add('hidden');
  const statusSel = document.getElementById('is-status');
  const next = steps[Math.min(curIdx + 1, steps.length - 1)];
  statusSel.value = next !== current ? next : 'verified';
  toggleTeamWrap();
  openModal('incident-status-modal');
}

function toggleTeamWrap() {
  document.getElementById('is-team-wrap').classList.toggle('hidden',
    document.getElementById('is-status').value !== 'responding');
}

// ================= MY REPORTS =================
async function loadMyReports() {
  const rows = await api.get('/api/incidents/mine/list');
  const steps = ['reported', 'verified', 'responding', 'resolved'];
  document.getElementById('my-reports').innerHTML = rows.length ? rows.map(r => {
    const curIdx = steps.indexOf(r.status);
    // Feature 2: once a team is dispatched, show a live tracking map + ETA.
    const canTrack = r.status === 'responding' && r.latitude != null && r.longitude != null;
    return `<div class="alert-item">
      <h4>#${r.id} ${r.incident_type.replace('_', ' ')} <span class="badge ${r.status}">${r.status}</span></h4>
      <p>${escapeHtml(r.description).slice(0, 140)}</p>
      <div class="status-flow mt">${steps.map((s, idx) => `
        <span class="step ${idx <= curIdx ? 'done' : ''}">${s}</span>
        ${idx < steps.length - 1 ? '<span class="arrow">&rarr;</span>' : ''}`).join('')}</div>
      <div class="meta">${fmtDate(r.created_at)}${r.updated_at !== r.created_at ? ' &bull; updated ' + fmtDate(r.updated_at) : ''}</div>
      ${canTrack ? `
      <div class="mt">
        <div id="track-info-${r.id}"><p class="muted">Locating your assigned rescue team...</p></div>
        <div id="track-map-${r.id}" style="height:220px;border-radius:8px;margin-top:8px;border:1px solid var(--line)"></div>
      </div>` : ''}
    </div>`;
  }).join('') : '<p class="empty">You have not filed any incident reports yet. Use "Report an Incident" on the home page map.</p>';

  // Kick off live tracking for each report that has a dispatched team.
  rows.filter(r => r.status === 'responding' && r.latitude != null && r.longitude != null)
    .forEach(r => initTracking(r));
}

// Feature 2: polls the team's live position and renders ETA + a mini-map showing
// the responder moving toward the incident. Refreshes every 15s while mounted.
const trackingTimers = {};
const trackingMaps = {};
function initTracking(report) {
  const mapEl = document.getElementById('track-map-' + report.id);
  const infoEl = document.getElementById('track-info-' + report.id);
  if (!mapEl || typeof L === 'undefined') return;

  // Tear down any previous instance for this report (panel reloads re-render it).
  if (trackingTimers[report.id]) { clearInterval(trackingTimers[report.id]); delete trackingTimers[report.id]; }
  if (trackingMaps[report.id]) { try { trackingMaps[report.id].remove(); } catch { /* ignore */ } delete trackingMaps[report.id]; }

  let trackMap = L.map('track-map-' + report.id).setView([Number(report.latitude), Number(report.longitude)], 14);
  trackingMaps[report.id] = trackMap;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; OpenStreetMap contributors'
  }).addTo(trackMap);
  L.marker([Number(report.latitude), Number(report.longitude)],
    { icon: trackPin('#e63946', '📍') }).bindPopup('Your incident').addTo(trackMap);
  let teamMarker = null;
  let routeLine = null;

  async function update() {
    try {
      const t = await api.get(`/api/incidents/${report.id}/track`);
      if (!t || !t.position) {
        if (infoEl) infoEl.innerHTML = '<p class="muted">Rescue team dispatched; awaiting their live GPS signal.</p>';
        return;
      }
      const [tlat, tlng] = [t.position.latitude, t.position.longitude];
      if (!teamMarker) {
        teamMarker = L.marker([tlat, tlng], { icon: trackPin('#2ecc71', '🚑') })
          .bindPopup(escapeHtml(t.team ? t.team.name : 'Rescue team')).addTo(trackMap);
      } else {
        teamMarker.setLatLng([tlat, tlng]);
      }
      if (routeLine) trackMap.removeLayer(routeLine);
      routeLine = L.polyline([[tlat, tlng], [Number(report.latitude), Number(report.longitude)]],
        { color: '#3d8bfd', weight: 3, dashArray: '6 6', opacity: 0.8 }).addTo(trackMap);
      trackMap.fitBounds(routeLine.getBounds(), { padding: [30, 30] });

      const eta = t.eta_min;
      const dist = t.distance_m != null ? (t.distance_m / 1000).toFixed(1) + ' km away' : '';
      const live = t.position.source === 'live';
      if (infoEl) infoEl.innerHTML = `
        <p><b>${escapeHtml(t.team ? t.team.name : 'Rescue team')}</b> is on the way.
        ${eta === 0 ? '<b style="color:var(--green)">Arriving now / on scene.</b>'
          : eta != null ? `Estimated arrival: <b>~${eta} min</b>` : 'ETA calculating...'}
        ${dist ? ' &bull; ' + dist : ''}</p>
        <p class="muted" style="font-size:12px">${live ? '🟢 Live GPS position' : '📌 Last known team base location'}
          ${t.team && t.team.phone ? ` &bull; <a href="tel:${escapeHtml(String(t.team.phone).replace(/[^\d+]/g, ''))}">📞 ${escapeHtml(t.team.phone)}</a>` : ''}</p>`;
    } catch { /* transient - keep last render */ }
  }

  update();
  trackingTimers[report.id] = setInterval(() => {
    // Stop polling once the user navigates away from the panel (element removed).
    if (!document.getElementById('track-map-' + report.id)) {
      clearInterval(trackingTimers[report.id]);
      delete trackingTimers[report.id];
      if (trackingMaps[report.id]) { try { trackingMaps[report.id].remove(); } catch { /* ignore */ } delete trackingMaps[report.id]; }
      return;
    }
    update();
  }, 15000);
  setTimeout(() => trackMap.invalidateSize(), 200);
}

function trackPin(color, label) {
  return L.divIcon({
    className: '',
    html: `<div style="background:${color};width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)"><span style="transform:rotate(45deg);font-size:12px">${label || ''}</span></div>`,
    iconSize: [26, 26], iconAnchor: [13, 26]
  });
}

// ================= EVACUATION =================
async function loadEvacAdmin() {
  const centers = await api.get('/api/evacuation');
  document.getElementById('evac-admin-body').innerHTML = centers.map(e => {
    const pct = e.capacity > 0 ? Math.round((e.occupants / e.capacity) * 100) : 0;
    return `<tr>
      <td><b>${escapeHtml(e.name)}</b><br><small class="muted">${escapeHtml(e.address || '')}</small></td>
      <td>${escapeHtml(e.barangay || '-')}</td>
      <td><span class="badge ${e.status === 'open' ? 'resolved' : e.status === 'full' ? 'critical' : 'info'}">${e.status}</span></td>
      <td style="min-width:140px">${e.occupants}/${e.capacity} (${pct}%)
        <div class="progress"><div class="${pct >= 100 ? 'over' : pct >= 75 ? 'warn' : ''}" style="width:${Math.min(pct, 100)}%"></div></div></td>
      <td>${escapeHtml(e.contact_phone || '-')}</td>
      <td><button class="btn sm" onclick="openEvacEdit(${e.id}, ${e.occupants}, ${e.capacity}, '${e.status}')">Update</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">No centers.</td></tr>';
}

function openEvacEdit(id, occupants, capacity, status) {
  document.getElementById('ev-id').value = id;
  document.getElementById('ev-occupants').value = occupants;
  document.getElementById('ev-capacity').value = capacity;
  document.getElementById('ev-status').value = '';
  openModal('evac-edit-modal');
}

// ================= TEAMS =================
async function loadTeamsAdmin() {
  const teams = await api.get('/api/teams');
  document.getElementById('teams-admin-body').innerHTML = teams.map(t => `
    <tr>
      <td><b>${escapeHtml(t.name)}</b>${t.specialty ? '<br><small class="muted">' + escapeHtml(t.specialty) + '</small>' : ''}</td>
      <td>${escapeHtml(t.leader_name)}</td>
      <td>${t.member_count}</td>
      <td>${escapeHtml(t.phone || '-')}</td>
      <td><span class="badge ${t.status === 'available' ? 'resolved' : t.status === 'off_duty' ? 'info' : 'warning'}">${t.status.replace('_', ' ')}</span>
        ${t.active_incident_id ? '<br><small class="muted">on incident #' + t.active_incident_id + '</small>' : ''}</td>
      <td>
        <select style="max-width:150px" onchange="updateTeamStatus(${t.id}, this.value)">
          <option value="">Set status...</option>
          <option value="available">Available</option>
          <option value="on_mission">On mission</option>
          <option value="dispatched">Dispatched</option>
          <option value="off_duty">Off duty</option>
        </select>
      </td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">No teams.</td></tr>';
}

async function updateTeamStatus(id, status) {
  if (!status) return;
  try {
    await api.put('/api/teams/' + id, { status });
    toast('Team status updated.', 'success');
    loadTeamsAdmin();
  } catch (err) { toast(err.message, 'error'); }
}

// ================= FLOOD =================
async function loadFloodAdmin() {
  const sensors = await api.get('/api/flood/sensors');
  document.getElementById('flood-admin-body').innerHTML = sensors.map(s => `
    <tr>
      <td><b>${escapeHtml(s.name)}</b></td>
      <td>${escapeHtml(s.barangay || '-')}</td>
      <td>${s.latest_level != null ? `<b style="color:${s.latest_status === 'critical' ? 'var(--red)' : s.latest_status === 'alert' ? 'var(--orange)' : 'var(--green)'}">${s.latest_level} m</b> <span class="badge ${s.latest_status === 'normal' ? 'resolved' : s.latest_status === 'alert' ? 'warning' : 'critical'}">${s.latest_status}</span>` : '<span class="muted">no reading</span>'}</td>
      <td>${s.alert_level_m} / ${s.critical_level_m} m</td>
      <td>${fmtDate(s.latest_at) || '-'}</td>
      <td>
        <div class="section-actions">
          <button class="btn secondary sm" onclick="manualReading(${s.id})">Record</button>
          <button class="btn sm" onclick="simulateReading(${s.id})">Simulate</button>
        </div>
      </td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">No sensors.</td></tr>';
}

async function manualReading(sensorId) {
  const val = prompt('Water level in meters:');
  if (val == null || val.trim() === '') return;
  try {
    const r = await api.post('/api/flood/readings', { sensor_id: sensorId, water_level_m: Number(val) });
    toast(`Reading recorded. Status: ${r.status}` + (r.status !== 'normal' ? ' - automatic warning triggered!' : ''), r.status === 'normal' ? 'success' : 'error');
    loadFloodAdmin();
  } catch (err) { toast(err.message, 'error'); }
}

async function simulateReading(sensorId) {
  try {
    const r = await api.post(`/api/flood/sensors/${sensorId}/simulate`, {});
    toast(`Simulated reading: ${r.level} m (${r.status})`, 'success');
    loadFloodAdmin();
  } catch (err) { toast(err.message, 'error'); }
}

// ================= RESOURCES =================
async function loadResourcesAdmin() {
  const rows = await api.get('/api/resources');
  document.getElementById('resources-admin-body').innerHTML = rows.map(r => `
    <tr>
      <td><b>${escapeHtml(r.name)}</b></td>
      <td>${r.category}</td>
      <td style="${Number(r.below_minimum) ? 'color:var(--red);font-weight:700' : ''}">${r.quantity} ${escapeHtml(r.unit)}${Number(r.below_minimum) ? ' ⚠' : ''}</td>
      <td>${r.minimum_level} ${escapeHtml(r.unit)}</td>
      <td>${escapeHtml(r.storage_location || r.evacuation_center || '-')}</td>
      <td>
        <div class="section-actions">
          <button class="btn success sm" onclick="adjustResource(${r.id}, 1)">+ Stock in</button>
          <button class="btn warning sm" onclick="adjustResource(${r.id}, -1)">- Distribute</button>
        </div>
      </td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">No resources.</td></tr>';
}

async function adjustResource(id, sign) {
  const val = prompt(sign > 0 ? 'Quantity to ADD:' : 'Quantity to REMOVE:');
  if (val == null || val.trim() === '') return;
  const delta = Number(val) * sign;
  if (isNaN(delta) || delta === 0) return toast('Enter a valid number.', 'error');
  try {
    await api.post(`/api/resources/${id}/adjust`, { delta });
    toast('Stock updated.', 'success');
    loadResourcesAdmin();
  } catch (err) { toast(err.message, 'error'); }
}

// ================= MISSING =================
async function loadMissingAdmin() {
  const rows = currentUser.role === 'resident'
    ? await api.get('/api/missing')
    : await api.get('/api/missing/manage/list');
  document.getElementById('missing-admin-body').innerHTML = rows.map(m => `
    <tr>
      <td><b>${escapeHtml(m.full_name)}</b>${m.photo_path ? `<br><img class="thumb" src="${m.photo_path}" onclick="window.open(this.src)" alt="photo">` : ''}</td>
      <td>${m.age || '?'} / ${m.gender}</td>
      <td>${escapeHtml(m.last_seen || '-')}${m.barangay ? '<br><small class="muted">' + escapeHtml(m.barangay) + '</small>' : ''}</td>
      <td>${escapeHtml(m.contact_phone || '-')}<br><small class="muted">${escapeHtml(m.contact_name || '')}</small></td>
      <td><span class="badge ${m.status === 'missing' ? 'warning' : 'resolved'}">${m.status}</span></td>
      <td>${fmtDate(m.created_at)}</td>
      <td>
        ${m.status === 'missing'
          ? `<button class="btn success sm" onclick="markFound(${m.id})">Mark Found</button>`
          : `<button class="btn secondary sm" onclick="markMissing(${m.id})">Reopen</button>`}
      </td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">No missing-person reports.</td></tr>';
}

async function setMissingStatus(id, status) {
  try {
    await api.put(`/api/missing/${id}/status`, { status });
    toast(`Report marked as ${status}.`, 'success');
    loadMissingAdmin();
  } catch (err) { toast(err.message, 'error'); }
}
const markFound = id => setMissingStatus(id, 'found');
const markMissing = id => setMissingStatus(id, 'missing');

// ================= ROADS (blocked-road blockages) =================
const ROAD_STATUS_BADGE = { blocked: 'critical', partial: 'warning', cleared: 'resolved' };
let roadList = [];

async function loadRoadsAdmin() {
  roadList = await api.get('/api/roads?all=1');
  const canDelete = currentUser.role === 'admin';
  document.getElementById('roads-admin-body').innerHTML = roadList.map(r => `
    <tr>
      <td><b>${escapeHtml(r.road_name)}</b>${r.description ? `<br><small class="muted">${escapeHtml(String(r.description).slice(0, 80))}</small>` : ''}</td>
      <td>${escapeHtml(r.barangay || '-')}</td>
      <td><span class="badge ${ROAD_STATUS_BADGE[r.status] || 'info'}">${r.status}</span></td>
      <td><span class="badge ${r.severity}">${r.severity}</span></td>
      <td>${escapeHtml(r.cause || '-')}</td>
      <td>${fmtDate(r.updated_at)}</td>
      <td>
        ${r.status !== 'cleared' ? `<button class="btn success sm" onclick="setRoadStatus(${r.id}, 'cleared')">Mark Cleared</button>` : ''}
        ${r.status === 'cleared' ? `<button class="btn warning sm" onclick="setRoadStatus(${r.id}, 'blocked')">Reopen</button>` : ''}
        ${canDelete ? `<button class="btn danger sm" onclick="deleteRoad(${r.id})">Delete</button>` : ''}
      </td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">No road blockages reported.</td></tr>';
}

async function setRoadStatus(id, status) {
  try {
    await api.put('/api/roads/' + id, { status });
    toast(`Road marked ${status}.`, 'success');
    loadRoadsAdmin();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteRoad(id) {
  if (!confirm('Permanently delete this road blockage record?')) return;
  try {
    await api.del('/api/roads/' + id);
    toast('Road blockage deleted.', 'success');
    loadRoadsAdmin();
  } catch (err) { toast(err.message, 'error'); }
}

// ================= BARANGAY OFFICIALS =================
async function loadOfficialsAdmin() {
  const rows = await api.get('/api/officials');
  const canDelete = currentUser.role === 'admin';
  document.getElementById('officials-admin-body').innerHTML = rows.map(o => `
    <tr>
      <td><b>${escapeHtml(o.name)}</b></td>
      <td>${escapeHtml(o.position || '-')}</td>
      <td>${escapeHtml(o.barangay || '-')}</td>
      <td>${o.phone ? `<a class="tel" href="tel:${escapeHtml(String(o.phone).replace(/[^\d+]/g, ''))}">${escapeHtml(o.phone)}</a>` : '<span class="muted">-</span>'}</td>
      <td>${o.is_active ? '<span class="badge resolved">active</span>' : '<span class="badge">inactive</span>'}</td>
      <td>
        <button class="btn secondary sm" onclick='editOfficial(${JSON.stringify(o).replace(/'/g, "&#39;")})'>Edit</button>
        ${canDelete ? `<button class="btn danger sm" onclick="deleteOfficial(${o.id})">Delete</button>` : ''}
      </td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">No barangay officials listed.</td></tr>';
}

function editOfficial(o) {
  const name = prompt('Name:', o.name);
  if (name === null) return;
  const position = prompt('Position:', o.position || '');
  if (position === null) return;
  const phone = prompt('Hotline / phone:', o.phone || '');
  if (phone === null) return;
  const active = confirm('Keep this official active? (Cancel = mark inactive)');
  saveOfficialEdit(o.id, { name, position, phone, is_active: active });
}

async function saveOfficialEdit(id, body) {
  try {
    await api.put('/api/officials/' + id, body);
    toast('Official updated.', 'success');
    loadOfficialsAdmin();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteOfficial(id) {
  if (!confirm('Delete this official?')) return;
  try {
    await api.del('/api/officials/' + id);
    toast('Official deleted.', 'success');
    loadOfficialsAdmin();
  } catch (err) { toast(err.message, 'error'); }
}

// ================= BARANGAYS =================
const RISK_OPTIONS = ['low', 'moderate', 'high', 'critical'];

// Builds a <select> that saves one risk field on change.
function riskSelect(id, field, value) {
  return `<select style="max-width:120px" onchange="updateRiskField(${id}, '${field}', this.value)">
    ${RISK_OPTIONS.map(r => `<option value="${r}" ${value === r ? 'selected' : ''}>${r}</option>`).join('')}
  </select>`;
}

// Google Maps link for a lat/lng pair (requirement: clickable coordinates).
function mapsLink(lat, lng) {
  if (lat == null || lng == null) return '<span class="muted">-</span>';
  const url = `https://www.google.com/maps?q=${lat},${lng}`;
  return `<a href="${url}" target="_blank" rel="noopener noreferrer" title="Open in Google Maps">${lat}, ${lng} 🗺️</a>`;
}

async function loadBarangaysAdmin() {
  const { barangays } = await api.get('/api/barangays');
  document.getElementById('barangays-admin-body').innerHTML = barangays.map(b => `
    <tr>
      <td><b>${escapeHtml(b.name)}</b><br><small class="muted">open: ${b.open_incidents} &bull; evacuees: ${b.evacuees}</small></td>
      <td>${riskSelect(b.id, 'flood_risk', b.flood_risk)}</td>
      <td>${riskSelect(b.id, 'landslide_risk', b.landslide_risk)}</td>
      <td>${riskSelect(b.id, 'storm_surge_risk', b.storm_surge_risk)}</td>
      <td>${riskSelect(b.id, 'earthquake_risk', b.earthquake_risk)}</td>
      <td>${riskSelect(b.id, 'overall_risk', b.overall_risk)}<br><span class="badge ${b.overall_risk}">${b.overall_risk}</span></td>
      <td>${b.population}</td>
      <td>${mapsLink(b.latitude, b.longitude)}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">No barangays.</td></tr>';
}

async function updateRiskField(id, field, value) {
  try {
    const r = await api.put('/api/barangays/' + id, { [field]: value });
    toast(`${field.replace(/_/g, ' ')} set to ${value}.` + (field !== 'overall_risk' ? ` Overall: ${r.overall_risk}.` : ''), 'success');
    loadBarangaysAdmin();
  } catch (err) { toast(err.message, 'error'); }
}

// ================= CONTACTS =================
async function loadContactsAdmin() {
  const rows = await api.get('/api/contacts');
  document.getElementById('contacts-admin-body').innerHTML = rows.map(c => `
    <tr>
      <td><b>${escapeHtml(c.name)}</b></td>
      <td>${c.category}</td>
      <td>${escapeHtml(c.phone)}</td>
      <td>${escapeHtml(c.address || '-')}</td>
      <td><button class="btn danger sm" onclick="deleteContact(${c.id})">Delete</button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">No contacts.</td></tr>';
}

async function deleteContact(id) {
  if (!confirm('Delete this contact?')) return;
  try {
    await api.del('/api/contacts/' + id);
    toast('Contact deleted.', 'success');
    loadContactsAdmin();
  } catch (err) { toast(err.message, 'error'); }
}

// ================= USERS =================
async function loadUsersAdmin() {
  const [rows, teams] = await Promise.all([
    api.get('/api/users'),
    teamList.length ? Promise.resolve(teamList) : api.get('/api/teams').catch(() => [])
  ]);
  teamList = teams;
  fillTeamSelect('us-team', null);
  document.getElementById('users-admin-body').innerHTML = rows.map(u => `
    <tr>
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.email)}</td>
      <td><span class="badge info">${u.role.replace('_', ' ')}</span></td>
      <td>${escapeHtml(u.barangay_name || '-')}</td>
      <td>${escapeHtml(u.team_name || '-')}</td>
      <td>${u.is_active ? '<span style="color:var(--green)">yes</span>' : '<span style="color:var(--red)">no</span>'}</td>
      <td><button class="btn sm" onclick='openUserEdit(${JSON.stringify(u).replace(/'/g, '&#39;')})'>Edit</button></td>
    </tr>`).join('');
}

function openUserEdit(u) {
  document.getElementById('ue-id').value = u.id;
  document.getElementById('ue-name').value = u.name;
  document.getElementById('ue-role').value = u.role;
  document.getElementById('ue-barangay').value = u.barangay_id || '';
  fillTeamSelect('ue-team', u.team_id);
  document.getElementById('ue-password').value = '';
  document.getElementById('ue-active').checked = !!u.is_active;
  openModal('user-edit-modal');
}

// Populates a <select> with rescue teams (cached in teamList) and selects one.
function fillTeamSelect(selectId, selectedTeamId) {
  const el = document.getElementById(selectId);
  if (!el) return;
  const opts = ['<option value="">-- none --</option>'].concat(
    teamList.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`));
  el.innerHTML = opts.join('');
  el.value = selectedTeamId ? String(selectedTeamId) : '';
}

// ================= REPORTS =================
function downloadReport(format) {
  const q = new URLSearchParams();
  const from = document.getElementById('rpt-from').value;
  const to = document.getElementById('rpt-to').value;
  const status = document.getElementById('rpt-status').value;
  const barangay = document.getElementById('rpt-barangay').value;
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if (status) q.set('status', status);
  if (barangay) q.set('barangay_id', barangay);
  window.location = `/api/reports/${format}?${q.toString()}`;
  toast(`Generating ${format.toUpperCase()} report...`, 'success');
}

// ================= LOGS =================
async function loadLogs() {
  const rows = await api.get('/api/logs?limit=200');
  document.getElementById('logs-body').innerHTML = rows.map(l => `
    <tr>
      <td>${fmtDate(l.created_at)}</td>
      <td>${escapeHtml(l.user_name || 'system')}</td>
      <td><code>${escapeHtml(l.action)}</code></td>
      <td>${escapeHtml(l.entity_type || '-')}${l.entity_id ? ' #' + l.entity_id : ''}</td>
      <td style="max-width:260px"><small>${escapeHtml(l.details || '')}</small></td>
      <td><small class="muted">${escapeHtml(l.ip_address || '')}</small></td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">No activity yet.</td></tr>';
}

// ================= ADVISORIES =================
const ADV_LEVEL_CLASS = { critical: 'critical', warning: 'warning', info: 'info' };

async function loadAdvisoriesAdmin() {
  const agency = document.getElementById('adv-filter-agency').value;
  const rows = await api.get('/api/advisories?limit=60' + (agency ? '&agency=' + agency : ''));
  const canDelete = currentUser.role === 'admin';
  document.getElementById('advisories-admin-list').innerHTML = rows.length ? rows.map(a => {
    const lvl = ADV_LEVEL_CLASS[a.alert_level] || 'info';
    return `
    <div class="advisory-item ${lvl}">
      <h4><span class="adv-agency">${escapeHtml(a.agency)}</span>${escapeHtml(a.title)}
        ${a.alert_level ? `<span class="badge ${lvl === 'info' ? 'info' : lvl}">${escapeHtml(a.alert_level)}</span>` : ''}
        ${a.auto ? '<span class="badge info">auto</span>' : ''}</h4>
      ${a.affected_areas ? `<p>📍 ${escapeHtml(a.affected_areas)}</p>` : ''}
      ${a.details ? (a.advisory_type === 'daily_report'
        ? `<pre class="daily-report">${escapeHtml(a.details)}</pre>`
        : `<p>${escapeHtml(String(a.details).slice(0, 400))}</p>`) : ''}
      <div class="adv-meta">
        ${a.advisory_type ? escapeHtml(a.advisory_type.replace('_', ' ')) + ' &bull; ' : ''}
        ${a.issued_at ? 'Issued ' + fmtDate(a.issued_at) : ''}
        ${a.created_by_name ? ' &bull; by ' + escapeHtml(a.created_by_name) : ''}
        ${a.source_url ? ` &bull; <a href="${escapeHtml(a.source_url)}" target="_blank" rel="noopener noreferrer">source</a>` : ''}
        ${canDelete ? ` &bull; <a href="#" onclick="deleteAdvisory(${a.id});return false" style="color:var(--red)">delete</a>` : ''}
      </div>
    </div>`;
  }).join('') : '<p class="empty">No advisories yet. Use "Refresh Feeds" to pull the latest earthquake advisories, or post one manually.</p>';
}

async function refreshAdvisories() {
  toast('Refreshing official feeds...');
  try {
    const r = await api.post('/api/advisories/refresh');
    toast(`Feed refresh complete. ${r.added} new advisory(ies) added.`, 'success');
    loadAdvisoriesAdmin();
  } catch (err) { toast(err.message, 'error'); }
}

async function generateDailyReport() {
  toast('Building today\'s multi-hazard situation report...');
  try {
    const r = await api.post('/api/advisories/daily-report');
    toast(`Daily report generated (status: ${String(r.level).toUpperCase()}).`, 'success');
    loadAdvisoriesAdmin();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteAdvisory(id) {
  if (!confirm('Delete this advisory?')) return;
  try {
    await api.del('/api/advisories/' + id);
    toast('Advisory deleted.', 'success');
    loadAdvisoriesAdmin();
  } catch (err) { toast(err.message, 'error'); }
}

// ================= SETTINGS =================
const SETTING_KEYS = ['system_name', 'short_name', 'municipality_name', 'logo_url', 'theme_color',
  'contact_email', 'contact_phone', 'hotline', 'address', 'footer_text',
  'map_center_lat', 'map_center_lng', 'map_zoom'];

async function loadSettingsAdmin() {
  try {
    const s = await api.get('/api/settings');
    for (const k of SETTING_KEYS) {
      const el = document.getElementById('set-' + k);
      if (el) el.value = s[k] != null ? s[k] : '';
    }
  } catch (err) { toast(err.message, 'error'); }
}

// ================= AI CHAT (dashboard) =================
function initDashChat() {
  const log = document.getElementById('dash-chat-log');
  const input = document.getElementById('dash-chat-input');
  const send = async () => {
    const q = input.value.trim();
    if (!q) return;
    log.innerHTML += `<div class="chat-msg user">${escapeHtml(q)}</div>`;
    input.value = '';
    log.scrollTop = log.scrollHeight;
    try {
      const r = await api.post('/api/ai/chat', { question: q });
      log.innerHTML += `<div class="chat-msg bot">${botAnswerHtml(r)}</div>`;
    } catch (err) {
      log.innerHTML += `<div class="chat-msg bot">Error: ${escapeHtml(err.message)}</div>`;
    }
    log.scrollTop = log.scrollHeight;
  };
  document.getElementById('dash-chat-send').addEventListener('click', send);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
}

// ================= FORM BINDINGS =================
function bindForms() {
  document.getElementById('alert-form').addEventListener('submit', e => { e.preventDefault(); submitAlert(true); });
  document.getElementById('is-status').addEventListener('change', toggleTeamWrap);

  document.getElementById('incident-status-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('is-id').value;
    try {
      await api.post(`/api/incidents/${id}/status`, {
        status: document.getElementById('is-status').value,
        note: document.getElementById('is-note').value,
        team_id: document.getElementById('is-status').value === 'responding' ? (document.getElementById('is-team').value || undefined) : undefined
      });
      toast('Incident status updated.', 'success');
      closeModal('incident-status-modal');
      loadIncidentsAdmin();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('pdf-import-form').addEventListener('submit', async e => {
    e.preventDefault();
    const file = document.getElementById('pdf-file').files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('pdf', file);
    const out = document.getElementById('pdf-import-result');
    out.innerHTML = '<p class="empty">Analyzing PDF with AI...</p>';
    try {
      const r = await api.postForm('/api/ai/pdf-import', fd);
      out.innerHTML = `<div class="alert-item severity-${r.draft.severity}">
        <h4>Draft created (Alert #${r.alert_id})</h4>
        <p><b>${escapeHtml(r.draft.title)}</b></p>
        <p>${escapeHtml(r.draft.message).slice(0, 300)}...</p>
        <div class="meta">Severity: ${r.draft.severity} &bull; Type: ${r.draft.alert_type} &bull;
          Target: ${r.draft.target_type}${r.draft.suggested_barangay_names.length ? ' (' + r.draft.suggested_barangay_names.join(', ') + ')' : ''}</div>
        <p class="muted mt">Review it in the alerts table, then Submit → Approve → Send.</p>
      </div>`;
      toast('PDF analyzed - draft alert created.', 'success');
      loadAlertsManage();
    } catch (err) {
      out.innerHTML = `<p class="warning-item critical">${escapeHtml(err.message)}</p>`;
    }
  });

  document.getElementById('evac-edit-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('ev-id').value;
    try {
      await api.put('/api/evacuation/' + id, {
        occupants: Number(document.getElementById('ev-occupants').value),
        capacity: Number(document.getElementById('ev-capacity').value),
        status: document.getElementById('ev-status').value || undefined
      });
      toast('Evacuation center updated.', 'success');
      closeModal('evac-edit-modal');
      loadEvacAdmin();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('evac-create-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.post('/api/evacuation', {
        name: document.getElementById('evc-name').value,
        barangay_id: document.getElementById('evc-barangay').value || null,
        address: document.getElementById('evc-address').value,
        latitude: document.getElementById('evc-lat').value || null,
        longitude: document.getElementById('evc-lng').value || null,
        capacity: document.getElementById('evc-capacity').value,
        contact_phone: document.getElementById('evc-phone').value
      });
      toast('Evacuation center created.', 'success');
      closeModal('evac-create-modal');
      e.target.reset();
      loadEvacAdmin();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('team-create-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.post('/api/teams', {
        name: document.getElementById('tm-name').value,
        leader_name: document.getElementById('tm-leader').value,
        member_count: document.getElementById('tm-count').value,
        phone: document.getElementById('tm-phone').value,
        specialty: document.getElementById('tm-specialty').value || null
      });
      toast('Rescue team created.', 'success');
      closeModal('team-create-modal');
      e.target.reset();
      loadTeamsAdmin();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('sensor-create-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.post('/api/flood/sensors', {
        name: document.getElementById('fs-name').value,
        barangay_id: document.getElementById('fs-barangay').value || null,
        latitude: document.getElementById('fs-lat').value || null,
        longitude: document.getElementById('fs-lng').value || null,
        alert_level_m: document.getElementById('fs-alert').value,
        critical_level_m: document.getElementById('fs-critical').value
      });
      toast('Flood sensor created.', 'success');
      closeModal('sensor-create-modal');
      e.target.reset();
      loadFloodAdmin();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('resource-create-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.post('/api/resources', {
        name: document.getElementById('rs-name').value,
        category: document.getElementById('rs-category').value,
        quantity: document.getElementById('rs-qty').value,
        unit: document.getElementById('rs-unit').value,
        minimum_level: document.getElementById('rs-min').value,
        storage_location: document.getElementById('rs-location').value
      });
      toast('Resource added.', 'success');
      closeModal('resource-create-modal');
      e.target.reset();
      loadResourcesAdmin();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('missing-create-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData();
    fd.append('full_name', document.getElementById('mp-name').value);
    fd.append('age', document.getElementById('mp-age').value);
    fd.append('gender', document.getElementById('mp-gender').value);
    fd.append('last_seen', document.getElementById('mp-lastseen').value);
    fd.append('barangay_id', document.getElementById('mp-barangay').value);
    fd.append('description', document.getElementById('mp-desc').value);
    fd.append('contact_name', document.getElementById('mp-cname').value);
    fd.append('contact_phone', document.getElementById('mp-cphone').value);
    const photo = document.getElementById('mp-photo').files[0];
    if (photo) fd.append('photo', photo);
    try {
      await api.postForm('/api/missing', fd);
      toast('Missing-person report submitted.', 'success');
      closeModal('missing-create-modal');
      e.target.reset();
      loadMissingAdmin();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('contact-create-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.post('/api/contacts', {
        name: document.getElementById('ct-name').value,
        category: document.getElementById('ct-category').value,
        phone: document.getElementById('ct-phone').value,
        address: document.getElementById('ct-address').value
      });
      toast('Contact added.', 'success');
      closeModal('contact-create-modal');
      e.target.reset();
      loadContactsAdmin();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('user-create-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.post('/api/users', {
        name: document.getElementById('us-name').value,
        email: document.getElementById('us-email').value,
        password: document.getElementById('us-password').value,
        role: document.getElementById('us-role').value,
        barangay_id: document.getElementById('us-barangay').value || null,
        team_id: document.getElementById('us-team').value || null,
        phone: document.getElementById('us-phone').value
      });
      toast('User created.', 'success');
      closeModal('user-create-modal');
      e.target.reset();
      loadUsersAdmin();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('user-edit-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('ue-id').value;
    const body = {
      name: document.getElementById('ue-name').value,
      role: document.getElementById('ue-role').value,
      barangay_id: document.getElementById('ue-barangay').value || null,
      team_id: document.getElementById('ue-team').value || null,
      is_active: document.getElementById('ue-active').checked
    };
    const pw = document.getElementById('ue-password').value;
    if (pw) body.password = pw;
    try {
      await api.put('/api/users/' + id, body);
      toast('User updated.', 'success');
      closeModal('user-edit-modal');
      loadUsersAdmin();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('advisory-create-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.post('/api/advisories', {
        agency: document.getElementById('ad-agency').value,
        advisory_type: document.getElementById('ad-type').value,
        title: document.getElementById('ad-title').value,
        alert_level: document.getElementById('ad-level').value,
        affected_areas: document.getElementById('ad-areas').value,
        details: document.getElementById('ad-details').value,
        issued_at: document.getElementById('ad-issued').value || undefined,
        source_url: document.getElementById('ad-url').value
      });
      toast('Advisory posted.', 'success');
      closeModal('advisory-create-modal');
      e.target.reset();
      loadAdvisoriesAdmin();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('settings-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = {};
    for (const k of SETTING_KEYS) {
      const el = document.getElementById('set-' + k);
      if (el) body[k] = el.value;
    }
    try {
      await api.put('/api/settings', body);
      toast('Settings saved. Branding updates across the site.', 'success');
      applySystemSettings();
    } catch (err) { toast(err.message, 'error'); }
  });

  // Report a blocked road (auto-fill coordinates from GPS).
  const rbGps = document.getElementById('rb-use-gps');
  if (rbGps) rbGps.addEventListener('click', () => {
    if (!('geolocation' in navigator)) return toast('Geolocation is not supported.', 'error');
    navigator.geolocation.getCurrentPosition(pos => {
      document.getElementById('rb-lat').value = pos.coords.latitude.toFixed(6);
      document.getElementById('rb-lng').value = pos.coords.longitude.toFixed(6);
      toast('Location captured.', 'success');
    }, err => toast('Could not get location: ' + err.message, 'error'),
    { enableHighAccuracy: true, timeout: 15000 });
  });

  document.getElementById('road-create-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.post('/api/roads', {
        road_name: document.getElementById('rb-name').value,
        barangay_id: document.getElementById('rb-barangay').value || null,
        cause: document.getElementById('rb-cause').value || null,
        severity: document.getElementById('rb-severity').value,
        latitude: document.getElementById('rb-lat').value || null,
        longitude: document.getElementById('rb-lng').value || null,
        description: document.getElementById('rb-desc').value || null
      });
      toast('Road blockage reported.', 'success');
      closeModal('road-create-modal');
      e.target.reset();
      loadRoadsAdmin();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('official-create-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api.post('/api/officials', {
        barangay_id: document.getElementById('bo-barangay').value || null,
        name: document.getElementById('bo-name').value,
        position: document.getElementById('bo-position').value || null,
        phone: document.getElementById('bo-phone').value || null,
        sort_order: Number(document.getElementById('bo-sort').value) || 0
      });
      toast('Official added.', 'success');
      closeModal('official-create-modal');
      e.target.reset();
      loadOfficialsAdmin();
    } catch (err) { toast(err.message, 'error'); }
  });
}
