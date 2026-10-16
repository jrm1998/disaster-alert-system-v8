const express = require('express');
const pool = require('../../config/db');
const { requireAuth } = require('../middleware/auth');
const pushService = require('../services/pushService');

const router = express.Router();

// Subscribe the current browser to background push notifications.
// Anonymous visitors can subscribe too (user_id NULL) for municipality-wide alerts.
router.post('/subscribe', async (req, res) => {
  try {
    if (!pushService.isPushConfigured()) {
      return res.status(503).json({ error: 'Push notifications are not configured on this server.' });
    }
    const userId = req.session && req.session.user ? req.session.user.id : null;
    await pushService.saveSubscription(userId, req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Failed to save subscription.' });
  }
});

router.post('/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'Endpoint is required.' });
    await pushService.removeSubscription(endpoint);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove subscription.' });
  }
});

// In-app notification feed for the logged-in user:
// global notifications + notifications for their barangay
router.get('/notifications', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const [rows] = await pool.query(
      `SELECT * FROM notifications
       WHERE user_id = ? OR (user_id IS NULL AND (barangay_id IS NULL OR barangay_id = ?))
       ORDER BY id DESC LIMIT 50`,
      [user.id, user.barangay_id || 0]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load notifications.' });
  }
});

// Public feed used by the homepage/offline cache: latest notifications for a barangay
router.get('/public-notifications', async (req, res) => {
  try {
    const bid = Number(req.query.barangay_id) || null;
    const [rows] = await pool.query(
      `SELECT id, title, body, created_at FROM notifications
       WHERE user_id IS NULL AND (barangay_id IS NULL OR barangay_id = ?)
       ORDER BY id DESC LIMIT 30`,
      [bid]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load notifications.' });
  }
});

router.post('/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read = 1 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark as read.' });
  }
});

module.exports = router;
