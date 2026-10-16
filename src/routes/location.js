// Live GPS location sharing for staff (responders, barangay officials, admins).
//   POST /api/location/update  - share my current position (permission-gated in UI)
//   GET  /api/location/nearby  - staff positions near a point (admin/official view)
// Residents never appear here: only STAFF_ROLES share and are listed.
const express = require('express');
const pool = require('../../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const trackingService = require('../services/trackingService');

const router = express.Router();

// Share the caller's own live position. Any authenticated staff role may update.
router.post('/update', requireRole('responder', 'barangay_official', 'admin'), async (req, res) => {
  try {
    const { latitude, longitude, accuracy } = req.body;
    const ok = await trackingService.saveUserLocation(
      req.session.user.id, latitude, longitude, accuracy);
    if (!ok) return res.status(400).json({ error: 'Valid latitude and longitude are required.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save location.' });
  }
});

// My own last known fix (so the UI can show sharing state on load).
router.get('/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT latitude, longitude, accuracy_m, updated_at
       FROM user_locations WHERE user_id = ?`, [req.session.user.id]);
    res.json(rows.length ? rows[0] : null);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load your location.' });
  }
});

// Nearby staff around a point, ordered by distance. Admins/officials only: this
// exposes responder positions and phone numbers for coordination.
router.get('/nearby', requireRole('admin', 'barangay_official'), async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat and lng query parameters are required.' });
    }
    const limit = Math.min(Number(req.query.limit) || 0, 100);
    const responders = await trackingService.getNearbyResponders(lat, lng, { limit });
    res.json(responders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load nearby responders.' });
  }
});

module.exports = router;
