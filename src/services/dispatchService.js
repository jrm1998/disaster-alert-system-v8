// Incident dispatch orchestration:
//   - default/normalized severity per incident type
//   - automatic rescuer (team) selection by availability + proximity + suitability
//   - duplicate-safe assignment, admin override, and release on resolution
//   - notifications to all responders when a new incident is filed
// All DB writes here are additive and guarded; failures are logged, never thrown,
// so a dispatch problem can never break incident reporting.
const pool = require('../../config/db');
const pushService = require('./pushService');

const SEVERITIES = ['low', 'moderate', 'high', 'critical'];

// Default severity when the reporter does not choose one.
const SEVERITY_BY_TYPE = {
  fire: 'critical', medical: 'critical', landslide: 'critical', earthquake: 'critical',
  flood: 'high', storm_damage: 'high', accident: 'moderate', other: 'moderate'
};

// Team specialties that suit each incident type (suitability matching).
const SPECIALTY_FOR_TYPE = {
  fire: ['fire'],
  medical: ['medical'],
  flood: ['water', 'rescue'],
  landslide: ['rescue'],
  earthquake: ['rescue', 'medical'],
  storm_damage: ['rescue'],
  accident: ['rescue', 'medical'],
  other: []
};

// Staff roles that receive new-incident notifications.
const RESPONDER_ROLES = "('responder','admin','barangay_official')";

function defaultSeverity(type) {
  return SEVERITY_BY_TYPE[type] || 'moderate';
}

function normalizeSeverity(sev, type) {
  return SEVERITIES.includes(sev) ? sev : defaultSeverity(type);
}

// Picks the most appropriate AVAILABLE team: prefers one whose specialty suits
// the incident, then the closest by base coordinates. Returns null if none free.
async function findBestTeam(incident, conn) {
  const db = conn || pool;
  const [teams] = await db.query("SELECT * FROM rescue_teams WHERE status = 'available'");
  if (!teams.length) return null;

  let lat = incident.latitude != null ? Number(incident.latitude) : null;
  let lng = incident.longitude != null ? Number(incident.longitude) : null;
  if ((lat == null || lng == null) && incident.barangay_id) {
    const [b] = await db.query('SELECT latitude, longitude FROM barangays WHERE id = ?', [incident.barangay_id]);
    if (b.length && b[0].latitude != null) { lat = Number(b[0].latitude); lng = Number(b[0].longitude); }
  }

  const suited = SPECIALTY_FOR_TYPE[incident.incident_type] || [];
  let best = null;
  let bestScore = Infinity;
  for (const t of teams) {
    let dist;
    if (lat != null && lng != null && t.base_latitude != null && t.base_longitude != null) {
      dist = pushService.haversineMeters(lat, lng, Number(t.base_latitude), Number(t.base_longitude));
    } else {
      dist = 5000; // unknown position: neutral mid-range value
    }
    const specialty = String(t.specialty || '').toLowerCase();
    const suits = suited.length === 0 || !specialty || specialty === 'general' || suited.includes(specialty);
    // 20 km penalty for a mismatched specialty: suited teams win locally, but a
    // far-away specialist still loses to a nearby general team.
    const score = dist + (suits ? 0 : 20000);
    if (score < bestScore) { bestScore = score; best = t; }
  }
  return best;
}

// Assigns a team to an incident inside the caller's transaction. Duplicate-safe:
// refuses if the incident already has an open dispatch.
async function assignTeam(conn, incidentId, teamId, actorUserId, auto) {
  const [open] = await conn.query(
    'SELECT id FROM team_dispatches WHERE incident_id = ? AND returned_at IS NULL LIMIT 1', [incidentId]);
  if (open.length) return { ok: false, reason: 'already_dispatched' };

  await conn.query('UPDATE incidents SET assigned_team_id = ? WHERE id = ?', [teamId, incidentId]);
  await conn.query("UPDATE rescue_teams SET status = 'dispatched' WHERE id = ?", [teamId]);
  await conn.query(
    'INSERT INTO team_dispatches (team_id, incident_id, dispatched_by, auto_assigned) VALUES (?,?,?,?)',
    [teamId, incidentId, actorUserId || null, auto ? 1 : 0]);
  return { ok: true };
}

// Admin/official override: releases the previous team and dispatches a new one.
async function overrideTeam(conn, incident, newTeamId, actorUserId) {
  if (incident.assigned_team_id && Number(incident.assigned_team_id) !== Number(newTeamId)) {
    await conn.query("UPDATE rescue_teams SET status = 'available' WHERE id = ?", [incident.assigned_team_id]);
  }
  await conn.query(
    'UPDATE team_dispatches SET returned_at = NOW() WHERE incident_id = ? AND returned_at IS NULL', [incident.id]);
  await conn.query("UPDATE incidents SET assigned_team_id = ?, status = 'responding' WHERE id = ?",
    [newTeamId, incident.id]);
  await conn.query("UPDATE rescue_teams SET status = 'dispatched' WHERE id = ?", [newTeamId]);
  await conn.query(
    'INSERT INTO team_dispatches (team_id, incident_id, dispatched_by, auto_assigned) VALUES (?,?,?,0)',
    [newTeamId, incident.id, actorUserId || null]);
}

// Releases the assigned team and stamps resolution details (feature 8).
async function releaseOnResolve(conn, incident, note) {
  if (incident.assigned_team_id) {
    await conn.query("UPDATE rescue_teams SET status = 'available' WHERE id = ?", [incident.assigned_team_id]);
    await conn.query(
      'UPDATE team_dispatches SET returned_at = NOW() WHERE incident_id = ? AND returned_at IS NULL',
      [incident.id]);
  }
  await conn.query(
    'UPDATE incidents SET resolved_at = NOW(), resolution_note = ? WHERE id = ?',
    [note || null, incident.id]);
}

// After an incident becomes verified, auto-select and dispatch the best team.
// Runs post-commit on its own connection. Returns the assigned team or null.
async function autoDispatch(incidentId, actorUserId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM incidents WHERE id = ?', [incidentId]);
    if (!rows.length) { await conn.rollback(); return null; }
    const cur = rows[0];
    if (cur.assigned_team_id) { await conn.rollback(); return null; } // already handled

    const team = await findBestTeam(cur, conn);
    if (!team) { await conn.commit(); return null; } // none free: stays verified, siren continues

    await assignTeam(conn, cur.id, team.id, actorUserId, true);
    await conn.query("UPDATE incidents SET status = 'responding', siren_acknowledged = 1 WHERE id = ?", [cur.id]);
    await conn.query(
      'INSERT INTO incident_history (incident_id, status, changed_by, note) VALUES (?,?,?,?)',
      [cur.id, 'responding', actorUserId || null,
       `Auto-dispatched ${team.name} (nearest available${team.specialty ? ' ' + team.specialty : ''} team)`]);
    await conn.commit();
    return team;
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    console.error('[dispatch] auto-dispatch failed:', err.message);
    return null;
  } finally {
    conn.release();
  }
}

// Notifies every responder/admin/official (in-app rows + background push) about
// a newly filed incident, so nearby responders can assist even if auto-assigned.
async function notifyResponders(incident) {
  const typeLabel = String(incident.incident_type || 'other').replace('_', ' ');
  const loc = incident.address || incident.barangay_name || incident.barangay || 'location pending';
  const title = `New ${typeLabel.toUpperCase()} incident #${incident.id}`;
  // Feature 1: include the EXACT location so responders can navigate straight there.
  const hasCoords = incident.latitude != null && incident.longitude != null;
  const coordText = hasCoords
    ? ` | GPS: ${Number(incident.latitude).toFixed(5)}, ${Number(incident.longitude).toFixed(5)}`
    : '';
  const mapsUrl = hasCoords
    ? `https://www.google.com/maps?q=${Number(incident.latitude)},${Number(incident.longitude)}`
    : null;
  const body = `${String(incident.description || '').slice(0, 120)} | ${loc}${coordText} | severity: ${incident.severity || 'moderate'}`;
  const link = '/dashboard.html';
  try {
    const [users] = await pool.query(
      `SELECT id FROM users WHERE role IN ${RESPONDER_ROLES} AND is_active = 1`);
    for (const u of users) {
      await pool.query('INSERT INTO notifications (user_id, title, body, link) VALUES (?,?,?,?)',
        [u.id, title, body, link]);
    }
    if (pushService.isPushConfigured()) {
      const [subs] = await pool.query(
        `SELECT ps.* FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id
         WHERE u.role IN ${RESPONDER_ROLES} AND u.is_active = 1`);
      const payload = {
        title, body, url: link,
        severity: incident.severity || 'moderate',
        incidentId: incident.id, kind: 'incident',
        latitude: hasCoords ? Number(incident.latitude) : null,
        longitude: hasCoords ? Number(incident.longitude) : null,
        mapsUrl
      };
      await Promise.all(subs.map(s => pushService.sendToSubscription(s, payload)));
    }
    return users.length;
  } catch (err) {
    console.error('[dispatch] responder notification failed:', err.message);
    return 0;
  }
}

module.exports = {
  SEVERITIES,
  defaultSeverity,
  normalizeSeverity,
  findBestTeam,
  assignTeam,
  overrideTeam,
  releaseOnResolve,
  autoDispatch,
  notifyResponders
};
