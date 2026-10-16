const express = require('express');
const pool = require('../../config/db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

const router = express.Router();
const STATUSES = ['available', 'dispatched', 'on_mission', 'off_duty'];

// Public list (transparency) with current dispatch info
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT t.*,
              (SELECT i.id FROM team_dispatches td JOIN incidents i ON i.id = td.incident_id
               WHERE td.team_id = t.id AND td.returned_at IS NULL ORDER BY td.id DESC LIMIT 1) AS active_incident_id
       FROM rescue_teams t ORDER BY t.name`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load rescue teams.' });
  }
});

router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const { name, leader_name, member_count, phone, specialty, base_latitude, base_longitude } = req.body;
    if (!name || !leader_name) return res.status(400).json({ error: 'Team name and leader are required.' });
    const [result] = await pool.query(
      'INSERT INTO rescue_teams (name, leader_name, member_count, phone, specialty, base_latitude, base_longitude) VALUES (?,?,?,?,?,?,?)',
      [name.trim(), leader_name.trim(), Number(member_count) || 1, phone || null, specialty || null,
       base_latitude != null ? Number(base_latitude) : null,
       base_longitude != null ? Number(base_longitude) : null]);
    await logActivity(req, 'rescue_team.created', 'rescue_team', result.insertId, name);
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create rescue team.' });
  }
});

router.put('/:id', requireRole('admin', 'barangay_official'), async (req, res) => {
  try {
    const { status, name, leader_name, member_count, phone, specialty } = req.body;
    if (status && !STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid team status.' });
    }
    const [rows] = await pool.query('SELECT id FROM rescue_teams WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Rescue team not found.' });
    await pool.query(
      `UPDATE rescue_teams SET
         status = COALESCE(?, status), name = COALESCE(?, name),
         leader_name = COALESCE(?, leader_name), member_count = COALESCE(?, member_count),
         phone = COALESCE(?, phone), specialty = COALESCE(?, specialty)
       WHERE id = ?`,
      [status || null, name || null, leader_name || null,
       member_count !== undefined ? Number(member_count) : null, phone || null,
       specialty !== undefined ? (specialty || null) : null, req.params.id]);
    await logActivity(req, 'rescue_team.updated', 'rescue_team', req.params.id, status || 'details updated');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update rescue team.' });
  }
});

// Dispatch history for a team
router.get('/:id/dispatches', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT td.*, i.incident_type, i.description, i.status AS incident_status, u.name AS dispatched_by_name
       FROM team_dispatches td
       JOIN incidents i ON i.id = td.incident_id
       LEFT JOIN users u ON u.id = td.dispatched_by
       WHERE td.team_id = ? ORDER BY td.dispatched_at DESC LIMIT 50`, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load dispatch history.' });
  }
});

// Rescuer acknowledgment of a dispatch (safety note: track acknowledgments).
router.post('/dispatches/:id/acknowledge', requireRole('admin', 'barangay_official', 'responder'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id FROM team_dispatches WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Dispatch not found.' });
    await pool.query('UPDATE team_dispatches SET acknowledged_at = NOW() WHERE id = ?', [req.params.id]);
    await logActivity(req, 'dispatch.acknowledged', 'team_dispatch', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to acknowledge dispatch.' });
  }
});

module.exports = router;
