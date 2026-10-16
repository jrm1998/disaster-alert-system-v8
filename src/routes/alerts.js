const express = require('express');
const pool = require('../../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const pushService = require('../services/pushService');

const router = express.Router();

const SEVERITIES = ['info', 'warning', 'critical'];
const TYPES = ['warning', 'advisory', 'evacuation', 'all_clear', 'information'];
const TARGET_TYPES = ['all', 'barangay', 'geofence'];

// ---------- Public ----------

// Public feed: sent alerts, newest first
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.id, a.title, a.message, a.alert_type, a.severity, a.target_type,
              a.geofence_lat, a.geofence_lng, a.geofence_radius_m, a.sent_at, a.expires_at,
              GROUP_CONCAT(b.name ORDER BY b.name SEPARATOR ', ') AS barangays
       FROM alerts a
       LEFT JOIN alert_barangays ab ON ab.alert_id = a.id
       LEFT JOIN barangays b ON b.id = ab.barangay_id
       WHERE a.status = 'sent' AND (a.expires_at IS NULL OR a.expires_at > NOW())
       GROUP BY a.id
       ORDER BY a.sent_at DESC, a.id DESC
       LIMIT 50`);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load alerts.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM alerts WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Alert not found.' });
    const [targets] = await pool.query(
      `SELECT b.id, b.name FROM alert_barangays ab
       JOIN barangays b ON b.id = ab.barangay_id WHERE ab.alert_id = ?`, [req.params.id]);
    res.json({ ...rows[0], target_barangays: targets });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load alert.' });
  }
});

// ---------- Management (officials, admins) ----------

router.get('/manage/list', requireRole('admin', 'barangay_official'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, uc.name AS created_by_name, ua.name AS approved_by_name,
              GROUP_CONCAT(b.name ORDER BY b.name SEPARATOR ', ') AS barangays
       FROM alerts a
       LEFT JOIN users uc ON uc.id = a.created_by
       LEFT JOIN users ua ON ua.id = a.approved_by
       LEFT JOIN alert_barangays ab ON ab.alert_id = a.id
       LEFT JOIN barangays b ON b.id = ab.barangay_id
       GROUP BY a.id
       ORDER BY a.created_at DESC LIMIT 200`);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load alerts.' });
  }
});

function validateAlertBody(body) {
  const errors = [];
  if (!body.title || !String(body.title).trim()) errors.push('Title is required.');
  if (!body.message || !String(body.message).trim()) errors.push('Message is required.');
  if (body.severity && !SEVERITIES.includes(body.severity)) errors.push('Invalid severity.');
  if (body.alert_type && !TYPES.includes(body.alert_type)) errors.push('Invalid alert type.');
  if (body.target_type && !TARGET_TYPES.includes(body.target_type)) errors.push('Invalid target type.');
  if (body.target_type === 'barangay' && (!Array.isArray(body.barangay_ids) || !body.barangay_ids.length)) {
    errors.push('Select at least one target barangay.');
  }
  if (body.target_type === 'geofence') {
    const lat = Number(body.geofence_lat);
    const lng = Number(body.geofence_lng);
    const rad = Number(body.geofence_radius_m);
    if (isNaN(lat) || lat < -90 || lat > 90) errors.push('Invalid geofence latitude.');
    if (isNaN(lng) || lng < -180 || lng > 180) errors.push('Invalid geofence longitude.');
    if (isNaN(rad) || rad < 100 || rad > 20000) errors.push('Geofence radius must be 100-20000 meters.');
  }
  return errors;
}

// Create alert (draft or submit for approval)
router.post('/', requireRole('admin', 'barangay_official'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const body = req.body;
    const errors = validateAlertBody(body);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });

    const status = body.submit ? 'pending_approval' : 'draft';
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO alerts (title, message, alert_type, severity, status, target_type,
         geofence_lat, geofence_lng, geofence_radius_m, created_by, source, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        body.title.trim(), body.message.trim(),
        TYPES.includes(body.alert_type) ? body.alert_type : 'advisory',
        SEVERITIES.includes(body.severity) ? body.severity : 'info',
        status,
        body.target_type || 'all',
        body.target_type === 'geofence' ? Number(body.geofence_lat) : null,
        body.target_type === 'geofence' ? Number(body.geofence_lng) : null,
        body.target_type === 'geofence' ? Number(body.geofence_radius_m) : null,
        req.session.user.id,
        body.source === 'ai_import' ? 'ai_import' : 'manual',
        body.expires_at || null
      ]);
    const alertId = result.insertId;
    if (body.target_type === 'barangay') {
      for (const bid of body.barangay_ids) {
        await conn.query('INSERT IGNORE INTO alert_barangays (alert_id, barangay_id) VALUES (?,?)',
          [alertId, Number(bid)]);
      }
    }
    await conn.commit();
    await logActivity(req, `alert.created${body.submit ? '.submitted' : ''}`, 'alert', alertId, body.title);
    res.status(201).json({ id: alertId, status });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Failed to create alert.' });
  } finally {
    conn.release();
  }
});

// Submit a draft for approval
router.post('/:id/submit', requireRole('admin', 'barangay_official'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM alerts WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Alert not found.' });
    if (rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Only draft alerts can be submitted for approval.' });
    }
    await pool.query("UPDATE alerts SET status = 'pending_approval' WHERE id = ?", [req.params.id]);
    await logActivity(req, 'alert.submitted', 'alert', rows[0].id, rows[0].title);
    res.json({ ok: true, status: 'pending_approval' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit alert.' });
  }
});

// Approval workflow: only admins approve; self-approval is blocked so a second
// authorized person always reviews an alert before it can go out.
router.post('/:id/approve', requireRole('admin'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM alerts WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Alert not found.' });
    if (rows[0].status !== 'pending_approval') {
      return res.status(400).json({ error: 'Alert is not pending approval.' });
    }
    if (rows[0].created_by === req.session.user.id) {
      return res.status(403).json({ error: 'You cannot approve an alert you created. Another authorized person must approve it.' });
    }
    await pool.query(
      "UPDATE alerts SET status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ?",
      [req.session.user.id, rows[0].id]);
    await logActivity(req, 'alert.approved', 'alert', rows[0].id, rows[0].title);
    res.json({ ok: true, status: 'approved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to approve alert.' });
  }
});

router.post('/:id/reject', requireRole('admin'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT status FROM alerts WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Alert not found.' });
    if (rows[0].status !== 'pending_approval') {
      return res.status(400).json({ error: 'Alert is not pending approval.' });
    }
    await pool.query("UPDATE alerts SET status = 'draft' WHERE id = ?", [req.params.id]);
    await logActivity(req, 'alert.rejected', 'alert', req.params.id, req.body.reason || 'Returned to draft');
    res.json({ ok: true, status: 'draft' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject alert.' });
  }
});

// Send an approved alert -> notifications + background web push
router.post('/:id/send', requireRole('admin'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM alerts WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Alert not found.' });
    if (rows[0].status !== 'approved') {
      return res.status(400).json({ error: 'Only approved alerts can be sent.' });
    }
    await pool.query("UPDATE alerts SET status = 'sent', sent_at = NOW() WHERE id = ?", [req.params.id]);
    const result = await pushService.dispatchAlert(rows[0]);
    await logActivity(req, 'alert.sent', 'alert', rows[0].id,
      `${rows[0].title} (push: ${result.pushed}, barangays: ${result.barangayCount})`);
    res.json({ ok: true, status: 'sent', pushed_to: result.pushed, barangays_affected: result.barangayCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send alert.' });
  }
});

router.post('/:id/cancel', requireRole('admin'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT status FROM alerts WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Alert not found.' });
    if (!['sent', 'approved'].includes(rows[0].status)) {
      return res.status(400).json({ error: 'Only sent or approved alerts can be cancelled.' });
    }
    await pool.query("UPDATE alerts SET status = 'cancelled' WHERE id = ?", [req.params.id]);
    await logActivity(req, 'alert.cancelled', 'alert', req.params.id);
    res.json({ ok: true, status: 'cancelled' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel alert.' });
  }
});

// Geofence preview: which barangays fall inside the danger circle
router.post('/geofence/preview', requireAuth, async (req, res) => {
  try {
    const { lat, lng, radius_m } = req.body;
    if (isNaN(Number(lat)) || isNaN(Number(lng))) {
      return res.status(400).json({ error: 'Valid lat and lng are required.' });
    }
    const barangays = await pushService.getBarangaysInRadius(Number(lat), Number(lng), Number(radius_m) || 1000);
    res.json({ barangays });
  } catch (err) {
    res.status(500).json({ error: 'Geofence preview failed.' });
  }
});

module.exports = router;
