const express = require('express');
const pool = require('../../config/db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// System activity logs (admin + officials)
router.get('/', requireRole('admin', 'barangay_official'), async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const params = [];
    let where = '';
    if (req.query.user_id) { where = 'WHERE user_id = ?'; params.push(Number(req.query.user_id)); }
    else if (req.query.entity_type) { where = 'WHERE entity_type = ?'; params.push(req.query.entity_type); }
    else if (req.query.action) { where = 'WHERE action LIKE ?'; params.push(`%${req.query.action}%`); }
    const [rows] = await pool.query(
      `SELECT * FROM activity_logs ${where} ORDER BY id DESC LIMIT ${limit}`, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load activity logs.' });
  }
});

module.exports = router;
