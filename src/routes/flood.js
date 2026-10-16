const express = require('express');
const pool = require('../../config/db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const floodMonitor = require('../services/floodMonitor');

const router = express.Router();

// Public: sensors with latest readings (map + monitoring panel)
router.get('/sensors', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT s.*, b.name AS barangay,
              (SELECT r.water_level_m FROM flood_readings r WHERE r.sensor_id = s.id ORDER BY r.id DESC LIMIT 1) AS latest_level,
              (SELECT r.status FROM flood_readings r WHERE r.sensor_id = s.id ORDER BY r.id DESC LIMIT 1) AS latest_status,
              (SELECT r.recorded_at FROM flood_readings r WHERE r.sensor_id = s.id ORDER BY r.id DESC LIMIT 1) AS latest_at
       FROM flood_sensors s LEFT JOIN barangays b ON b.id = s.barangay_id
       WHERE s.is_active = 1 ORDER BY s.name`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load flood sensors.' });
  }
});

// Public: reading history for one sensor
router.get('/sensors/:id/readings', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT water_level_m, status, recorded_at FROM flood_readings WHERE sensor_id = ? ORDER BY id DESC LIMIT 100',
      [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load readings.' });
  }
});

// Staff/IoT endpoint: record a water level reading.
// Automatic warnings trigger when alert/critical thresholds are exceeded.
router.post('/readings', requireRole('admin', 'barangay_official', 'responder'), async (req, res) => {
  try {
    const { sensor_id, water_level_m } = req.body;
    const level = Number(water_level_m);
    if (!sensor_id || isNaN(level) || level < 0 || level > 50) {
      return res.status(400).json({ error: 'Valid sensor_id and water_level_m (0-50) are required.' });
    }
    const result = await floodMonitor.recordReading(Number(sensor_id), level);
    await logActivity(req, 'flood.reading', 'flood_sensor', sensor_id, `${level} m (${result.status})`);
    res.status(201).json({ ok: true, status: result.status });
  } catch (err) {
    if (err.message === 'Sensor not found or inactive') {
      return res.status(404).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to record reading.' });
  }
});

// Demo aid: simulate a realistic random-walk reading for a sensor
router.post('/sensors/:id/simulate', requireRole('admin', 'barangay_official', 'responder'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM flood_sensors WHERE id = ? AND is_active = 1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Sensor not found.' });
    const sensor = rows[0];
    const [last] = await pool.query(
      'SELECT water_level_m FROM flood_readings WHERE sensor_id = ? ORDER BY id DESC LIMIT 1', [sensor.id]);
    const current = last.length ? Number(last[0].water_level_m) : Number(sensor.alert_level_m) * 0.5;
    const delta = (Math.random() - 0.45) * Number(sensor.alert_level_m) * 0.25; // slight upward bias
    const next = Math.max(0.1, Math.min(99, current + delta));
    const result = await floodMonitor.recordReading(sensor.id, Number(next.toFixed(2)));
    await logActivity(req, 'flood.simulated', 'flood_sensor', sensor.id, `${next.toFixed(2)} m (${result.status})`);
    res.json({ ok: true, level: Number(next.toFixed(2)), status: result.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Simulation failed.' });
  }
});

// Admin: manage sensors
router.post('/sensors', requireRole('admin'), async (req, res) => {
  try {
    const { name, barangay_id, latitude, longitude, alert_level_m, critical_level_m } = req.body;
    if (!name) return res.status(400).json({ error: 'Sensor name is required.' });
    const alertLvl = Number(alert_level_m);
    const critLvl = Number(critical_level_m);
    if (isNaN(alertLvl) || isNaN(critLvl) || critLvl <= alertLvl) {
      return res.status(400).json({ error: 'critical_level_m must be greater than alert_level_m.' });
    }
    const [result] = await pool.query(
      'INSERT INTO flood_sensors (name, barangay_id, latitude, longitude, alert_level_m, critical_level_m) VALUES (?,?,?,?,?,?)',
      [name.trim(), barangay_id || null,
       latitude != null ? Number(latitude) : null, longitude != null ? Number(longitude) : null,
       alertLvl, critLvl]);
    await logActivity(req, 'flood_sensor.created', 'flood_sensor', result.insertId, name);
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create sensor.' });
  }
});

module.exports = router;
