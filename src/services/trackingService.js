// Real-time responder GPS tracking, ETA and on-scene coordination helpers.
//
// Staff accounts (responder / barangay_official / admin) periodically POST their
// browser GPS position, which is upserted into user_locations (one row per user,
// always the latest fix). From those fixes we derive:
//   - the live position + ETA of a dispatched rescue team (via users.team_id)
//   - the nearest responders to any incident (for the map + call buttons)
//   - "on scene" responders who arrived but are NOT on the dispatched team, so the
//     admin can coordinate and avoid duplicate deployments.
// All helpers are read-mostly and never throw out to callers that render UI.
const pool = require('../../config/db');
const pushService = require('./pushService');

// A location fix older than this is considered stale and ignored for tracking.
const FRESH_MINUTES = 10;
// Average urban response speed used for ETA (~30 km/h == 500 m/min).
const METERS_PER_MIN = 500;
// Within this radius of an incident a responder counts as "already on scene".
const ON_SCENE_RADIUS_M = 200;
// Roles that share live location and appear as responders on the map.
const STAFF_ROLES = "('responder','barangay_official','admin')";

function clampLat(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= -90 && n <= 90 ? n : null;
}
function clampLng(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= -180 && n <= 180 ? n : null;
}

// Stores (or refreshes) a staff user's latest position.
async function saveUserLocation(userId, lat, lng, accuracyM) {
  const la = clampLat(lat);
  const ln = clampLng(lng);
  if (la == null || ln == null) return false;
  const acc = accuracyM != null && Number.isFinite(Number(accuracyM))
    ? Math.min(Number(accuracyM), 999999) : null;
  await pool.query(
    `INSERT INTO user_locations (user_id, latitude, longitude, accuracy_m)
     VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE latitude = VALUES(latitude),
       longitude = VALUES(longitude), accuracy_m = VALUES(accuracy_m)`,
    [userId, la, ln, acc]);
  return true;
}

// ETA in whole minutes for a straight-line distance, min 1 once moving.
function etaMinutes(distanceM) {
  if (distanceM == null || !Number.isFinite(distanceM)) return null;
  if (distanceM <= ON_SCENE_RADIUS_M) return 0;
  return Math.max(1, Math.round(distanceM / METERS_PER_MIN));
}

// Latest live position for a team: the most recent fresh fix among its members,
// falling back to the team's registered base coordinates. Returns null if unknown.
async function getTeamLivePosition(teamId, db) {
  const conn = db || pool;
  const [rows] = await conn.query(
    `SELECT ul.latitude, ul.longitude, ul.updated_at
     FROM user_locations ul
     JOIN users u ON u.id = ul.user_id
     WHERE u.team_id = ? AND u.is_active = 1
       AND ul.updated_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)
     ORDER BY ul.updated_at DESC LIMIT 1`, [teamId, FRESH_MINUTES]);
  if (rows.length) {
    return {
      latitude: Number(rows[0].latitude),
      longitude: Number(rows[0].longitude),
      updated_at: rows[0].updated_at,
      source: 'live'
    };
  }
  const [t] = await conn.query(
    'SELECT base_latitude, base_longitude FROM rescue_teams WHERE id = ?', [teamId]);
  if (t.length && t[0].base_latitude != null && t[0].base_longitude != null) {
    return {
      latitude: Number(t[0].base_latitude),
      longitude: Number(t[0].base_longitude),
      updated_at: null,
      source: 'base'
    };
  }
  return null;
}

// All staff with a fresh location fix, each annotated with distance to a point.
async function getNearbyResponders(lat, lng, opts = {}) {
  const limit = Number(opts.limit) || 0; // 0 == no limit
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.role, u.phone, u.team_id, t.name AS team_name, t.status AS team_status,
            ul.latitude, ul.longitude, ul.accuracy_m, ul.updated_at
     FROM user_locations ul
     JOIN users u ON u.id = ul.user_id
     LEFT JOIN rescue_teams t ON t.id = u.team_id
     WHERE u.is_active = 1 AND u.role IN ${STAFF_ROLES}
       AND ul.updated_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)`, [FRESH_MINUTES]);
  const la = Number(lat);
  const ln = Number(lng);
  const out = rows.map(r => {
    const rlat = Number(r.latitude);
    const rlng = Number(r.longitude);
    const distance_m = (Number.isFinite(la) && Number.isFinite(ln))
      ? Math.round(pushService.haversineMeters(la, ln, rlat, rlng)) : null;
    return {
      id: r.id, name: r.name, role: r.role, phone: r.phone,
      team_id: r.team_id, team_name: r.team_name, team_status: r.team_status,
      latitude: rlat, longitude: rlng,
      accuracy_m: r.accuracy_m != null ? Number(r.accuracy_m) : null,
      updated_at: r.updated_at,
      distance_m, eta_min: etaMinutes(distance_m),
      on_scene: distance_m != null && distance_m <= ON_SCENE_RADIUS_M
    };
  });
  out.sort((a, b) => (a.distance_m == null ? Infinity : a.distance_m) -
                      (b.distance_m == null ? Infinity : b.distance_m));
  return limit > 0 ? out.slice(0, limit) : out;
}

// Responders already at the scene who are NOT part of the dispatched team.
// Used to warn the admin about potential duplicate deployments.
async function findOnSceneResponders(incident, dispatchedTeamId) {
  if (incident.latitude == null || incident.longitude == null) return [];
  const nearby = await getNearbyResponders(Number(incident.latitude), Number(incident.longitude));
  return nearby.filter(r =>
    r.on_scene && (!dispatchedTeamId || Number(r.team_id) !== Number(dispatchedTeamId)));
}

// Notifies admins/officials about off-team responders already on scene. Deduped:
// skips if an equivalent notification was sent within the last 15 minutes.
async function notifyAdminsOnScene(incident, responder) {
  const title = 'Responder already on scene';
  const marker = `incident #${incident.id} responder #${responder.id}`;
  try {
    const [dupe] = await pool.query(
      `SELECT id FROM notifications
       WHERE title = ? AND body LIKE ?
         AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE) LIMIT 1`,
      [title, `%${marker}%`]);
    if (dupe.length) return 0;

    const body = `${responder.name} (${String(responder.role).replace('_', ' ')}` +
      `${responder.team_name ? ', ' + responder.team_name : ''}) is already at ` +
      `incident #${incident.id} but is not on the dispatched team. ` +
      `Coordinate to avoid duplicate deployment. [${marker}]`;
    const link = `/dashboard.html#incident-${incident.id}`;
    const [admins] = await pool.query(
      `SELECT id FROM users WHERE role IN ('admin','barangay_official') AND is_active = 1`);
    for (const a of admins) {
      await pool.query('INSERT INTO notifications (user_id, title, body, link) VALUES (?,?,?,?)',
        [a.id, title, body, link]);
    }
    if (pushService.isPushConfigured()) {
      const [subs] = await pool.query(
        `SELECT ps.* FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id
         WHERE u.role IN ('admin','barangay_official') AND u.is_active = 1`);
      const payload = { title, body: body.slice(0, 180), url: link, severity: 'info', kind: 'on-scene' };
      await Promise.all(subs.map(s => pushService.sendToSubscription(s, payload)));
    }
    return admins.length;
  } catch (err) {
    console.error('[tracking] on-scene admin notification failed:', err.message);
    return 0;
  }
}

// Request backup for an incident: notify nearby responders who are NOT already on
// the dispatched team, with the exact location so they can converge. Deduped so
// repeated taps within 10 minutes do not spam the same people.
async function requestBackup(incident, opts = {}) {
  const radiusM = Number(opts.radius_m) || 5000; // consider responders within 5 km
  const title = 'Backup requested';
  const marker = `incident #${incident.id}`;
  try {
    if (incident.latitude == null || incident.longitude == null) {
      return { notified: 0, reason: 'no_coords' };
    }
    const lat = Number(incident.latitude);
    const lng = Number(incident.longitude);
    const nearby = await getNearbyResponders(lat, lng);
    // Exclude members of the already-dispatched team and anyone beyond the radius.
    const targets = nearby.filter(r =>
      r.distance_m != null && r.distance_m <= radiusM &&
      (!incident.assigned_team_id || Number(r.team_id) !== Number(incident.assigned_team_id)));

    // Dedupe: skip if a backup notification for this incident went out in the last 10 min.
    const [dupe] = await pool.query(
      `SELECT id FROM notifications
       WHERE title = ? AND body LIKE ?
         AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE) LIMIT 1`,
      [title, `%${marker}%`]);
    if (dupe.length) return { notified: 0, deduped: true, candidates: targets.length };

    const loc = incident.address || incident.barangay_name || incident.barangay || 'the incident scene';
    const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
    const body = `Additional assistance needed at ${loc} (${marker}). ` +
      `GPS: ${lat.toFixed(5)}, ${lng.toFixed(5)}. ` +
      `${targets.length} responder(s) nearby. Respond if you are available.`;
    const link = `/dashboard.html#incident-${incident.id}`;

    for (const t of targets) {
      await pool.query('INSERT INTO notifications (user_id, title, body, link) VALUES (?,?,?,?)',
        [t.id, title, body, link]);
    }
    if (pushService.isPushConfigured() && targets.length) {
      const ids = targets.map(t => t.id);
      const [subs] = await pool.query(
        `SELECT ps.* FROM push_subscriptions ps
         WHERE ps.user_id IN (${ids.map(() => '?').join(',')})`, ids);
      const payload = {
        title, body: body.slice(0, 180), url: link, severity: 'warning',
        kind: 'backup', incidentId: incident.id, latitude: lat, longitude: lng, mapsUrl
      };
      await Promise.all(subs.map(s => pushService.sendToSubscription(s, payload)));
    }
    return { notified: targets.length, candidates: targets.length };
  } catch (err) {
    console.error('[tracking] backup request failed:', err.message);
    return { notified: 0, error: err.message };
  }
}

module.exports = {
  FRESH_MINUTES,
  ON_SCENE_RADIUS_M,
  STAFF_ROLES,
  saveUserLocation,
  etaMinutes,
  getTeamLivePosition,
  getNearbyResponders,
  findOnSceneResponders,
  notifyAdminsOnScene,
  requestBackup
};
