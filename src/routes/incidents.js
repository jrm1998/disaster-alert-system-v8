const express = require('express');
const pool = require('../../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const { incidentUpload } = require('../middleware/upload');
const { haversineMeters } = require('../services/pushService');
const dispatchService = require('../services/dispatchService');
const trackingService = require('../services/trackingService');

const router = express.Router();

const STATUSES = ['reported', 'verified', 'responding', 'resolved'];
const INCIDENT_TYPES = ['fire', 'flood', 'landslide', 'medical', 'accident', 'storm_damage', 'earthquake', 'other'];
// Roles whose incident reports are trusted and auto-verified (feature 1 + safety note).
const OFFICIAL_ROLES = ['barangay_official', 'admin'];

// Find the nearest barangay to a coordinate (used to auto-tag incidents)
async function nearestBarangay(lat, lng) {
  const [rows] = await pool.query(
    'SELECT id, name, latitude, longitude FROM barangays WHERE latitude IS NOT NULL');
  let best = null;
  let bestDist = Infinity;
  for (const b of rows) {
    const d = haversineMeters(lat, lng, Number(b.latitude), Number(b.longitude));
    if (d < bestDist) { bestDist = d; best = b; }
  }
  return bestDist <= 15000 ? best : null; // only auto-tag within 15 km
}

// Feature 9: detect likely duplicate reports - same incident type, close in time
// and space - so the control room can consolidate them WITHOUT deleting the
// originals (each duplicate keeps its own evidence, linked to a primary).
const DUP_WINDOW_MIN = 20;   // minutes
const DUP_RADIUS_M = 200;    // meters
async function findNearDuplicates(incident) {
  if (incident.latitude == null || incident.longitude == null) return [];
  const [rows] = await pool.query(
    `SELECT i.id, i.incident_type, i.description, i.latitude, i.longitude, i.address,
            i.status, i.created_at, i.is_duplicate, i.primary_incident_id, b.name AS barangay
     FROM incidents i LEFT JOIN barangays b ON b.id = i.barangay_id
     WHERE i.id <> ? AND i.incident_type = ? AND i.is_duplicate = 0
       AND i.latitude IS NOT NULL AND i.longitude IS NOT NULL
       AND i.created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)
       AND i.status <> 'resolved'
     ORDER BY i.created_at DESC LIMIT 50`,
    [incident.id, incident.incident_type, DUP_WINDOW_MIN]);
  const lat = Number(incident.latitude);
  const lng = Number(incident.longitude);
  return rows
    .map(r => ({ ...r, distance_m: Math.round(haversineMeters(lat, lng, Number(r.latitude), Number(r.longitude))) }))
    .filter(r => r.distance_m <= DUP_RADIUS_M)
    .sort((a, b) => a.distance_m - b.distance_m);
}

// ---------- Public ----------

// Map + list feed.
router.get('/', async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.query.status && STATUSES.includes(req.query.status)) {
      where = 'WHERE i.status = ?';
      params.push(req.query.status);
    }
    const [rows] = await pool.query(
      `SELECT i.id, i.incident_type, i.severity, i.description, i.latitude, i.longitude, i.address,
              i.photo_path, i.status, i.auto_verified, i.verified_at, i.resolved_at,
              i.siren_acknowledged, i.is_duplicate, i.primary_incident_id, i.created_at, i.updated_at,
              b.name AS barangay, t.name AS assigned_team,
              (SELECT COUNT(*) FROM incidents d WHERE d.primary_incident_id = i.id AND d.is_duplicate = 1) AS duplicate_count
       FROM incidents i
       LEFT JOIN barangays b ON b.id = i.barangay_id
       LEFT JOIN rescue_teams t ON t.id = i.assigned_team_id
       ${where}
       ORDER BY i.created_at DESC LIMIT 200`, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load incidents.' });
  }
});

// Incidents that should be sounding the emergency siren (feature 3): newly
// reported/verified, no rescuer dispatched yet, not manually silenced, recent.
// Declared before '/:id' so the literal path is not captured as an id.
router.get('/active-sirens', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT i.id, i.incident_type, i.severity, i.description, i.address,
              i.latitude, i.longitude, i.created_at, b.name AS barangay
       FROM incidents i
       LEFT JOIN barangays b ON b.id = i.barangay_id
       WHERE i.status IN ('reported','verified')
         AND i.assigned_team_id IS NULL
         AND i.siren_acknowledged = 0
         AND i.created_at > DATE_SUB(NOW(), INTERVAL 12 HOUR)
       ORDER BY i.created_at DESC LIMIT 20`);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load active sirens.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT i.*, b.name AS barangay, u.name AS reporter, t.name AS assigned_team,
              v.name AS verified_by_name,
              (SELECT td.id FROM team_dispatches td
               WHERE td.incident_id = i.id ORDER BY td.id DESC LIMIT 1) AS dispatch_id,
              (SELECT td.acknowledged_at FROM team_dispatches td
               WHERE td.incident_id = i.id ORDER BY td.id DESC LIMIT 1) AS dispatch_acknowledged_at
       FROM incidents i
       LEFT JOIN barangays b ON b.id = i.barangay_id
       LEFT JOIN users u ON u.id = i.reporter_id
       LEFT JOIN rescue_teams t ON t.id = i.assigned_team_id
       LEFT JOIN users v ON v.id = i.verified_by
       WHERE i.id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Incident not found.' });
    const [history] = await pool.query(
      `SELECT h.status, h.note, h.created_at, u.name AS changed_by
       FROM incident_history h LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.incident_id = ? ORDER BY h.id`, [req.params.id]);

    // Reports already consolidated under this incident (evidence preserved).
    const [linked] = await pool.query(
      `SELECT id, incident_type, description, status, created_at, address
       FROM incidents WHERE primary_incident_id = ? AND is_duplicate = 1 ORDER BY created_at`,
      [req.params.id]);
    // Suggested near-duplicates the control room could consolidate (staff view only).
    let possibleDuplicates = [];
    const isStaff = ['admin', 'barangay_official', 'responder'].includes(
      req.session.user && req.session.user.role);
    if (isStaff && !rows[0].is_duplicate) {
      possibleDuplicates = await findNearDuplicates(rows[0]);
    }

    res.json({ ...rows[0], history, duplicates: linked, possible_duplicates: possibleDuplicates });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load incident.' });
  }
});

// Live tracking for one incident (feature 2): the assigned team's current position
// and ETA toward the scene. Visible to the resident who filed it and to staff.
router.get('/:id/track', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT i.id, i.status, i.latitude, i.longitude, i.address, i.assigned_team_id,
              i.reporter_id, t.name AS team_name, t.phone AS team_phone
       FROM incidents i
       LEFT JOIN rescue_teams t ON t.id = i.assigned_team_id
       WHERE i.id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Incident not found.' });
    const inc = rows[0];

    const isStaff = ['admin', 'barangay_official', 'responder'].includes(req.session.user.role);
    const isOwner = Number(inc.reporter_id) === Number(req.session.user.id);
    if (!isStaff && !isOwner) {
      return res.status(403).json({ error: 'You cannot track this incident.' });
    }

    const out = {
      incident_id: inc.id,
      status: inc.status,
      latitude: inc.latitude != null ? Number(inc.latitude) : null,
      longitude: inc.longitude != null ? Number(inc.longitude) : null,
      address: inc.address,
      team: null,
      position: null,
      distance_m: null,
      eta_min: null
    };

    if (inc.assigned_team_id) {
      out.team = { id: inc.assigned_team_id, name: inc.team_name, phone: inc.team_phone };
      const pos = await trackingService.getTeamLivePosition(inc.assigned_team_id);
      if (pos) {
        out.position = pos;
        if (out.latitude != null && out.longitude != null) {
          const d = Math.round(haversineMeters(pos.latitude, pos.longitude, out.latitude, out.longitude));
          out.distance_m = d;
          out.eta_min = trackingService.etaMinutes(d);
        }
      }
    }
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load tracking data.' });
  }
});

// Nearby responders for the incident map (feature 3): the three closest with call
// info, plus any off-team responders already on scene (admins get notified).
router.get('/:id/nearby-responders', requireRole('admin', 'barangay_official', 'responder'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, latitude, longitude, assigned_team_id FROM incidents WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Incident not found.' });
    const inc = rows[0];
    if (inc.latitude == null || inc.longitude == null) {
      return res.json({ incident_lat: null, incident_lng: null, nearest: [], on_scene: [] });
    }

    const lat = Number(inc.latitude);
    const lng = Number(inc.longitude);
    const all = await trackingService.getNearbyResponders(lat, lng);
    const nearest = all.slice(0, 3);
    const onScene = await trackingService.findOnSceneResponders(
      { id: inc.id, latitude: lat, longitude: lng }, inc.assigned_team_id);

    // Notify admins about off-team responders already present (deduped inside).
    for (const r of onScene) {
      await trackingService.notifyAdminsOnScene({ id: inc.id }, r);
    }

    res.json({ incident_lat: lat, incident_lng: lng, nearest, on_scene: onScene, all });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load nearby responders.' });
  }
});

// ---------- Reporting (any logged-in user, including residents) ----------

router.post('/', requireAuth, incidentUpload.single('photo'), async (req, res) => {
  try {
    const { incident_type, description, latitude, longitude, address, severity } = req.body;
    if (!description || !String(description).trim()) {
      return res.status(400).json({ error: 'Description is required.' });
    }
    if (incident_type && !INCIDENT_TYPES.includes(incident_type)) {
      return res.status(400).json({ error: 'Invalid incident type.' });
    }
    const type = INCIDENT_TYPES.includes(incident_type) ? incident_type : 'other';
    const sev = dispatchService.normalizeSeverity(severity, type);

    let barangay_id = req.body.barangay_id ? Number(req.body.barangay_id) : null;
    const lat = latitude ? Number(latitude) : null;
    const lng = longitude ? Number(longitude) : null;
    if (!barangay_id && lat != null && lng != null) {
      const nb = await nearestBarangay(lat, lng);
      if (nb) barangay_id = nb.id;
    }
    const photoPath = req.file ? `/uploads/incidents/${req.file.filename}` : null;

    // Feature 1: reports filed by an authenticated, authorized barangay official
    // (or admin) are verified automatically - no separate admin approval needed.
    const isOfficial = OFFICIAL_ROLES.includes(req.session.user.role);
    const status = isOfficial ? 'verified' : 'reported';

    const [result] = await pool.query(
      `INSERT INTO incidents
         (reporter_id, incident_type, severity, description, latitude, longitude, address,
          photo_path, barangay_id, status, auto_verified, verified_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.session.user.id, type, sev, String(description).trim(), lat, lng, address || null,
       photoPath, barangay_id, status, isOfficial ? 1 : 0, isOfficial ? req.session.user.id : null]);
    const incidentId = result.insertId;

    if (isOfficial) {
      await pool.query('UPDATE incidents SET verified_at = NOW() WHERE id = ?', [incidentId]);
    }
    await pool.query(
      'INSERT INTO incident_history (incident_id, status, changed_by, note) VALUES (?,?,?,?)',
      [incidentId, status, req.session.user.id,
       isOfficial ? 'Auto-verified (submitted by an authorized barangay official)' : 'Report submitted']);
    await logActivity(req, isOfficial ? 'incident.reported.auto_verified' : 'incident.reported',
      'incident', incidentId, `${type} (${sev})`);

    // Feature 7: notify every responder about the new incident.
    let barangay_name = null;
    if (barangay_id) {
      const [b] = await pool.query('SELECT name FROM barangays WHERE id = ?', [barangay_id]);
      if (b.length) barangay_name = b[0].name;
    }
    await dispatchService.notifyResponders({
      id: incidentId, incident_type: type, severity: sev,
      description: String(description).trim(), address: address || null,
      barangay_name, latitude: lat, longitude: lng
    });

    // Feature 2: a verified incident gets an automatic rescuer assignment.
    let finalStatus = status;
    let dispatchedTeam = null;
    if (isOfficial) {
      const team = await dispatchService.autoDispatch(incidentId, req.session.user.id);
      if (team) { finalStatus = 'responding'; dispatchedTeam = team.name; }
    }

    res.status(201).json({
      id: incidentId, status: finalStatus, severity: sev,
      auto_verified: isOfficial, dispatched_team: dispatchedTeam
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit report.' });
  }
});

// My reports (tracking for the resident who filed them)
router.get('/mine/list', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT i.id, i.incident_type, i.severity, i.description, i.status, i.photo_path,
              i.latitude, i.longitude, i.address, i.created_at, i.updated_at, b.name AS barangay
       FROM incidents i LEFT JOIN barangays b ON b.id = i.barangay_id
       WHERE i.reporter_id = ? ORDER BY i.created_at DESC`, [req.session.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load your reports.' });
  }
});

// ---------- Status tracking (staff roles) ----------

// Reported -> Verified -> Responding -> Resolved
router.post('/:id/status', requireRole('admin', 'barangay_official', 'responder'), async (req, res) => {
  const { status, note, team_id } = req.body;
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Use: reported, verified, responding, resolved.' });
  }
  const conn = await pool.getConnection();
  let finalStatus = status;
  let dispatchedTeam = null;
  try {
    const [rows] = await conn.query('SELECT * FROM incidents WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Incident not found.' });
    const incident = rows[0];

    await conn.beginTransaction();
    await conn.query('UPDATE incidents SET status = ? WHERE id = ?', [status, incident.id]);
    await conn.query(
      'INSERT INTO incident_history (incident_id, status, changed_by, note) VALUES (?,?,?,?)',
      [incident.id, status, req.session.user.id, note || null]);

    if (status === 'verified') {
      await conn.query('UPDATE incidents SET verified_by = ?, verified_at = NOW() WHERE id = ?',
        [req.session.user.id, incident.id]);
    }

    // Explicit manual dispatch/override when moving to 'responding' with a team.
    if (status === 'responding' && team_id) {
      const [teams] = await conn.query('SELECT * FROM rescue_teams WHERE id = ?', [team_id]);
      if (!teams.length) {
        await conn.rollback();
        return res.status(400).json({ error: 'Rescue team not found.' });
      }
      if (incident.assigned_team_id && Number(incident.assigned_team_id) !== Number(team_id)) {
        await dispatchService.overrideTeam(conn, incident, Number(team_id), req.session.user.id);
      } else if (!incident.assigned_team_id) {
        const r = await dispatchService.assignTeam(conn, incident.id, Number(team_id), req.session.user.id, false);
        if (!r.ok) {
          await conn.rollback();
          return res.status(400).json({ error: 'Incident already has an active dispatch.' });
        }
      }
      await conn.query('UPDATE incidents SET siren_acknowledged = 1 WHERE id = ?', [incident.id]);
      dispatchedTeam = teams[0].name;
    }

    // Feature 8: resolving releases the rescuer and records completion details.
    if (status === 'resolved') {
      await dispatchService.releaseOnResolve(conn, incident, note);
    }

    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    console.error(err);
    return res.status(500).json({ error: 'Failed to update incident status.' });
  } finally {
    conn.release();
  }

  // Feature 2: verification (or a bare 'responding' with no team chosen) triggers
  // automatic rescuer selection. Runs after commit on its own connection.
  if (status === 'verified' || (status === 'responding' && !team_id)) {
    const team = await dispatchService.autoDispatch(Number(req.params.id), req.session.user.id);
    if (team) { finalStatus = 'responding'; dispatchedTeam = team.name; }
  }

  await logActivity(req, `incident.status.${status}`, 'incident', req.params.id,
    note || (dispatchedTeam ? `dispatched ${dispatchedTeam}` : ''));
  res.json({ ok: true, status: finalStatus, dispatched_team: dispatchedTeam });
});

// Manual dispatch / override of the automatic assignment (admins & officials).
router.post('/:id/dispatch', requireRole('admin', 'barangay_official'), async (req, res) => {
  const team_id = Number(req.body.team_id);
  if (!team_id) return res.status(400).json({ error: 'team_id is required.' });
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query('SELECT * FROM incidents WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Incident not found.' });
    const incident = rows[0];
    const [teams] = await conn.query('SELECT * FROM rescue_teams WHERE id = ?', [team_id]);
    if (!teams.length) return res.status(404).json({ error: 'Rescue team not found.' });

    await conn.beginTransaction();
    if (incident.assigned_team_id && Number(incident.assigned_team_id) !== team_id) {
      await dispatchService.overrideTeam(conn, incident, team_id, req.session.user.id);
    } else if (!incident.assigned_team_id) {
      const r = await dispatchService.assignTeam(conn, incident.id, team_id, req.session.user.id, false);
      if (!r.ok) {
        await conn.rollback();
        return res.status(400).json({ error: 'Incident already has an active dispatch.' });
      }
    }
    await conn.query("UPDATE incidents SET status = 'responding', siren_acknowledged = 1 WHERE id = ?", [incident.id]);
    await conn.query(
      'INSERT INTO incident_history (incident_id, status, changed_by, note) VALUES (?,?,?,?)',
      [incident.id, 'responding', req.session.user.id,
       `${incident.assigned_team_id && Number(incident.assigned_team_id) !== team_id ? 'Reassigned' : 'Dispatched'} ${teams[0].name} (manual)`]);
    await conn.commit();
    await logActivity(req, 'incident.dispatched', 'incident', incident.id, teams[0].name);
    res.json({ ok: true, status: 'responding', dispatched_team: teams[0].name });
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    console.error(err);
    res.status(500).json({ error: 'Failed to dispatch team.' });
  } finally {
    conn.release();
  }
});

// Request backup: notify nearby off-team responders with the exact location.
router.post('/:id/request-backup', requireRole('admin', 'barangay_official', 'responder'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT i.id, i.latitude, i.longitude, i.address, i.assigned_team_id, b.name AS barangay
       FROM incidents i LEFT JOIN barangays b ON b.id = i.barangay_id WHERE i.id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Incident not found.' });
    const result = await trackingService.requestBackup(rows[0], { radius_m: req.body.radius_m });
    await logActivity(req, 'incident.backup_requested', 'incident', req.params.id,
      `notified ${result.notified} responder(s)`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to request backup.' });
  }
});

// Feature 9: consolidate duplicate reports under a primary incident. The duplicates
// are LINKED (is_duplicate + primary_incident_id), never deleted, so every original
// report and its evidence are preserved and remain queryable.
router.post('/:id/consolidate', requireRole('admin', 'barangay_official'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const primaryId = Number(req.params.id);
    const dupIds = (Array.isArray(req.body.duplicate_ids) ? req.body.duplicate_ids : [])
      .map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== primaryId);
    if (!dupIds.length) return res.status(400).json({ error: 'No duplicate reports selected.' });

    const [primary] = await conn.query('SELECT id FROM incidents WHERE id = ?', [primaryId]);
    if (!primary.length) return res.status(404).json({ error: 'Primary incident not found.' });

    await conn.beginTransaction();
    for (const did of dupIds) {
      await conn.query(
        'UPDATE incidents SET is_duplicate = 1, primary_incident_id = ? WHERE id = ? AND id <> ?',
        [primaryId, did, primaryId]);
      await conn.query(
        'INSERT INTO incident_history (incident_id, status, changed_by, note) VALUES (?,?,?,?)',
        [did, 'consolidated', req.session.user.id, `Marked as duplicate of incident #${primaryId}`]);
    }
    await conn.query(
      'INSERT INTO incident_history (incident_id, status, changed_by, note) VALUES (?,?,?,?)',
      [primaryId, 'consolidated', req.session.user.id,
       `Consolidated ${dupIds.length} duplicate report(s): #${dupIds.join(', #')}`]);
    await conn.commit();
    await logActivity(req, 'incident.consolidated', 'incident', primaryId,
      `merged duplicates #${dupIds.join(', #')}`);
    res.json({ ok: true, consolidated: dupIds.length });
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    console.error(err);
    res.status(500).json({ error: 'Failed to consolidate reports.' });
  } finally {
    conn.release();
  }
});

// Undo a consolidation: unlink a duplicate so it stands alone again (evidence kept).
router.post('/:id/unconsolidate', requireRole('admin', 'barangay_official'), async (req, res) => {
  try {
    const dupId = Number(req.params.id);
    const [rows] = await pool.query('SELECT id FROM incidents WHERE id = ?', [dupId]);
    if (!rows.length) return res.status(404).json({ error: 'Incident not found.' });
    await pool.query('UPDATE incidents SET is_duplicate = 0, primary_incident_id = NULL WHERE id = ?', [dupId]);
    await pool.query(
      'INSERT INTO incident_history (incident_id, status, changed_by, note) VALUES (?,?,?,?)',
      [dupId, 'reported', req.session.user.id, 'Unlinked from primary (consolidation reverted)']);
    await logActivity(req, 'incident.unconsolidated', 'incident', dupId);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to revert consolidation.' });
  }
});

// Authorized manual stop / override for the emergency siren (safety note).
router.post('/:id/siren-ack', requireRole('admin', 'barangay_official', 'responder'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id FROM incidents WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Incident not found.' });
    await pool.query('UPDATE incidents SET siren_acknowledged = 1, siren_acknowledged_by = ? WHERE id = ?',
      [req.session.user.id, req.params.id]);
    await logActivity(req, 'incident.siren_stopped', 'incident', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to stop siren.' });
  }
});

module.exports = router;
