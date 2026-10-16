const express = require('express');
const pool = require('../../config/db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

const router = express.Router();

// Public: barangay officials + hotlines.
//  - ?barangay_id=N  -> officials for that barangay
//  - ?mine=1 (logged-in resident) -> officials for the caller's own barangay
//  - no filter (staff) -> all officials, grouped by barangay
router.get('/', async (req, res) => {
  try {
    const params = [];
    let where = 'WHERE o.is_active = 1';
    let bid = req.query.barangay_id ? Number(req.query.barangay_id) : null;

    // A resident asking for "my" officials resolves to their own barangay.
    if (req.query.mine === '1') {
      if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      const u = req.session.user;
      bid = u.barangay_id != null ? Number(u.barangay_id) : null;
      if (bid == null) return res.json([]); // no barangay assigned -> nothing to show
    }

    if (bid) { where += ' AND o.barangay_id = ?'; params.push(bid); }

    const [rows] = await pool.query(
      `SELECT o.id, o.barangay_id, o.name, o.position, o.phone, o.sort_order,
              b.name AS barangay
       FROM barangay_officials o JOIN barangays b ON b.id = o.barangay_id
       ${where}
       ORDER BY b.name, o.sort_order, o.name LIMIT 500`, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load barangay officials.' });
  }
});

// Admin/official: add an official.
router.post('/', requireRole('admin', 'barangay_official'), async (req, res) => {
  try {
    const { barangay_id, name, position, phone, sort_order } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required.' });
    // Officials may only manage their own barangay unless they are an admin.
    let bid = barangay_id ? Number(barangay_id) : null;
    if (req.session.user.role !== 'admin') {
      bid = req.session.user.barangay_id != null ? Number(req.session.user.barangay_id) : null;
      if (bid == null) return res.status(400).json({ error: 'Your account has no barangay assigned.' });
    }
    if (!bid) return res.status(400).json({ error: 'Barangay is required.' });
    const [result] = await pool.query(
      'INSERT INTO barangay_officials (barangay_id, name, position, phone, sort_order) VALUES (?,?,?,?,?)',
      [bid, String(name).trim().slice(0, 160), position ? String(position).slice(0, 120) : null,
       phone ? String(phone).slice(0, 30) : null, Number(sort_order) || 0]);
    await logActivity(req, 'barangay_official.created', 'barangay_official', result.insertId, name);
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add official.' });
  }
});

// Admin/official: update an official.
router.put('/:id', requireRole('admin', 'barangay_official'), async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM barangay_officials WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Official not found.' });
    if (req.session.user.role !== 'admin' &&
        Number(rows[0].barangay_id) !== Number(req.session.user.barangay_id)) {
      return res.status(403).json({ error: 'You can only manage officials in your own barangay.' });
    }
    const { name, position, phone, is_active, sort_order } = req.body;
    await pool.query(
      `UPDATE barangay_officials SET
         name = COALESCE(?, name), position = COALESCE(?, position),
         phone = COALESCE(?, phone), sort_order = COALESCE(?, sort_order),
         is_active = COALESCE(?, is_active)
       WHERE id = ?`,
      [name || null, position !== undefined ? (position || null) : null,
       phone !== undefined ? (phone || null) : null,
       sort_order !== undefined ? Number(sort_order) : null,
       is_active !== undefined ? (is_active ? 1 : 0) : null, req.params.id]);
    await logActivity(req, 'barangay_official.updated', 'barangay_official', req.params.id, name || '');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update official.' });
  }
});

// Admin: delete an official.
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM barangay_officials WHERE id = ?', [req.params.id]);
    await logActivity(req, 'barangay_official.deleted', 'barangay_official', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete official.' });
  }
});

module.exports = router;
