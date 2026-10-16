const express = require('express');
const pool = require('../../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const { missingUpload } = require('../middleware/upload');

const router = express.Router();

// Public: published missing-person reports
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.id, m.full_name, m.age, m.gender, m.last_seen, m.description, m.photo_path,
              m.contact_name, m.contact_phone, m.status, m.created_at, m.found_date,
              b.name AS barangay
       FROM missing_persons m LEFT JOIN barangays b ON b.id = m.barangay_id
       ORDER BY m.status = 'missing' DESC, m.created_at DESC LIMIT 200`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load missing persons.' });
  }
});

// Any logged-in user can report a missing person
router.post('/', requireAuth, missingUpload.single('photo'), async (req, res) => {
  try {
    const { full_name, age, gender, last_seen, barangay_id, description, contact_name, contact_phone } = req.body;
    if (!full_name || !String(full_name).trim()) {
      return res.status(400).json({ error: 'Full name of the missing person is required.' });
    }
    const photoPath = req.file ? `/uploads/missing/${req.file.filename}` : null;
    const [result] = await pool.query(
      `INSERT INTO missing_persons (reported_by, full_name, age, gender, last_seen, barangay_id, description, photo_path, contact_name, contact_phone)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [req.session.user.id, full_name.trim(), age ? Number(age) : null,
       ['male', 'female', 'other'].includes(gender) ? gender : 'unknown',
       last_seen || null, barangay_id || null, description || null, photoPath,
       contact_name || null, contact_phone || null]);
    await logActivity(req, 'missing.reported', 'missing_person', result.insertId, full_name);
    res.status(201).json({ id: result.insertId, status: 'missing' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit missing-person report.' });
  }
});

// Mark found / reopen (staff, or the person who reported)
router.put('/:id/status', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['missing', 'found'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "missing" or "found".' });
    }
    const [rows] = await pool.query('SELECT * FROM missing_persons WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Report not found.' });
    const isStaff = ['admin', 'barangay_official', 'responder'].includes(req.session.user.role);
    if (!isStaff && rows[0].reported_by !== req.session.user.id) {
      return res.status(403).json({ error: 'You can only update reports you filed.' });
    }
    await pool.query(
      "UPDATE missing_persons SET status = ?, found_date = IF(? = 'found', NOW(), NULL) WHERE id = ?",
      [status, status, req.params.id]);
    await logActivity(req, `missing.status.${status}`, 'missing_person', req.params.id, rows[0].full_name);
    res.json({ ok: true, status });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status.' });
  }
});

// Staff management list including reporter info
router.get('/manage/list', requireRole('admin', 'barangay_official', 'responder'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.*, b.name AS barangay, u.name AS reporter_name
       FROM missing_persons m
       LEFT JOIN barangays b ON b.id = m.barangay_id
       LEFT JOIN users u ON u.id = m.reported_by
       ORDER BY m.status = 'missing' DESC, m.created_at DESC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load reports.' });
  }
});

module.exports = router;
