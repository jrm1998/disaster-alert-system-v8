const express = require('express');
const pool = require('../../config/db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

const router = express.Router();
const STATUSES = ['blocked', 'partial', 'cleared'];
const SEVERITIES = ['low', 'moderate', 'high', 'critical'];

// Public: active road blockages for the interactive disaster map.
// `all=1` (staff) includes cleared blockages for the management list.
router.get('/', async (req, res) => {
  try {
    const includeCleared = req.query.all === '1';
    const where = includeCleared ? '' : "WHERE r.status <> 'cleared'";
    const [rows] = await pool.query(
      `SELECT r.id, r.road_name, r.description, r.barangay_id, r.latitude, r.longitude,
              r.path, r.status, r.severity, r.cause, r.cleared_at, r.created_at, r.updated_at,
              b.name AS barangay
       FROM road_blockages r LEFT JOIN barangays b ON b.id = r.barangay_id
       ${where}
       ORDER BY FIELD(r.status,'blocked','partial','cleared'), r.created_at DESC LIMIT 300`);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load road blockages.' });
  }
});

// Staff: report a blocked road.
router.post('/', requireRole('admin', 'barangay_official', 'responder'), async (req, res) => {
  try {
    const { road_name, description, barangay_id, latitude, longitude, path, severity, cause } = req.body;
    if (!road_name || !String(road_name).trim()) {
      return res.status(400).json({ error: 'Road name is required.' });
    }
    const lat = latitude != null && latitude !== '' ? Number(latitude) : null;
    const lng = longitude != null && longitude !== '' ? Number(longitude) : null;
    if ((lat != null && (isNaN(lat) || lat < -90 || lat > 90)) ||
        (lng != null && (isNaN(lng) || lng < -180 || lng > 180))) {
      return res.status(400).json({ error: 'Invalid coordinates.' });
    }
    const [result] = await pool.query(
      `INSERT INTO road_blockages
         (road_name, description, barangay_id, latitude, longitude, path, status, severity, cause, reported_by)
       VALUES (?,?,?,?,?,?,?, ?,?, ?)`,
      [String(road_name).trim().slice(0, 200), description || null,
       barangay_id ? Number(barangay_id) : null, lat, lng,
       path ? JSON.stringify(path).slice(0, 4000) : null,
       'blocked', SEVERITIES.includes(severity) ? severity : 'high',
       cause ? String(cause).slice(0, 60) : null, req.session.user.id]);
    await logActivity(req, 'road_blockage.created', 'road_blockage', result.insertId, road_name);
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to report road blockage.' });
  }
});

// Staff: update a blockage (status/severity/details). Setting status to 'cleared'
// stamps cleared_at so the map can drop it while history is retained.
router.put('/:id', requireRole('admin', 'barangay_official', 'responder'), async (req, res) => {
  try {
    const { road_name, description, status, severity, cause, barangay_id, latitude, longitude, path } = req.body;
    if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    if (severity && !SEVERITIES.includes(severity)) return res.status(400).json({ error: 'Invalid severity.' });
    const lat = latitude !== undefined ? (latitude === null || latitude === '' ? null : Number(latitude)) : undefined;
    const lng = longitude !== undefined ? (longitude === null || longitude === '' ? null : Number(longitude)) : undefined;
    await pool.query(
      `UPDATE road_blockages SET
         road_name = COALESCE(?, road_name),
         description = COALESCE(?, description),
         status = COALESCE(?, status),
         severity = COALESCE(?, severity),
         cause = COALESCE(?, cause),
         barangay_id = COALESCE(?, barangay_id),
         latitude = COALESCE(?, latitude),
         longitude = COALESCE(?, longitude),
         path = COALESCE(?, path),
         cleared_at = CASE WHEN ? = 'cleared' THEN NOW()
                           WHEN ? IS NOT NULL AND ? <> 'cleared' THEN NULL
                           ELSE cleared_at END
       WHERE id = ?`,
      [road_name || null, description || null, status || null, severity || null, cause || null,
       barangay_id !== undefined ? (barangay_id || null) : null,
       lat, lng,
       path ? JSON.stringify(path).slice(0, 4000) : null,
       status || null, status || null, status || null, req.params.id]);
    await logActivity(req, 'road_blockage.updated', 'road_blockage', req.params.id, status || '');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update road blockage.' });
  }
});

// Admin: permanently delete a blockage record.
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM road_blockages WHERE id = ?', [req.params.id]);
    await logActivity(req, 'road_blockage.deleted', 'road_blockage', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete road blockage.' });
  }
});

module.exports = router;
