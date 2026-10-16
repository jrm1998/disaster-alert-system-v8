const express = require('express');
const pool = require('../../config/db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

const router = express.Router();
const CATEGORIES = ['food', 'water', 'medicine', 'equipment', 'bedding', 'hygiene', 'other'];

// Public: resource availability overview (transparency during disasters)
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.*, e.name AS evacuation_center,
              (r.quantity < r.minimum_level) AS below_minimum
       FROM resources r
       LEFT JOIN evacuation_centers e ON e.id = r.evacuation_center_id
       ORDER BY r.category, r.name`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load resources.' });
  }
});

router.post('/', requireRole('admin', 'barangay_official'), async (req, res) => {
  try {
    const { name, category, quantity, unit, minimum_level, storage_location, evacuation_center_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Resource name is required.' });
    const [result] = await pool.query(
      `INSERT INTO resources (name, category, quantity, unit, minimum_level, storage_location, evacuation_center_id)
       VALUES (?,?,?,?,?,?,?)`,
      [name.trim(), CATEGORIES.includes(category) ? category : 'other',
       Number(quantity) || 0, unit || 'pcs', Number(minimum_level) || 0,
       storage_location || null, evacuation_center_id || null]);
    await logActivity(req, 'resource.created', 'resource', result.insertId, name);
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create resource.' });
  }
});

// Adjust stock: delta positive (delivery) or negative (distribution)
router.post('/:id/adjust', requireRole('admin', 'barangay_official', 'responder'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const delta = Number(req.body.delta);
    if (isNaN(delta) || delta === 0) {
      return res.status(400).json({ error: 'A non-zero numeric delta is required.' });
    }
    const [rows] = await pool.query('SELECT * FROM resources WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Resource not found.' });
    const newQty = Number(rows[0].quantity) + delta;
    if (newQty < 0) {
      return res.status(400).json({ error: `Insufficient stock (have ${rows[0].quantity} ${rows[0].unit}, tried to remove ${-delta}).` });
    }
    await pool.query('UPDATE resources SET quantity = ? WHERE id = ?', [newQty, id]);
    await logActivity(req, delta > 0 ? 'resource.stock_in' : 'resource.stock_out', 'resource', id,
      `${delta > 0 ? '+' : ''}${delta} ${rows[0].unit} (${rows[0].name}) -> ${newQty}`);
    res.json({ ok: true, quantity: newQty, below_minimum: newQty < Number(rows[0].minimum_level) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to adjust resource.' });
  }
});

router.put('/:id', requireRole('admin', 'barangay_official'), async (req, res) => {
  try {
    const { name, category, unit, minimum_level, storage_location, evacuation_center_id } = req.body;
    if (category && !CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category.' });
    }
    await pool.query(
      `UPDATE resources SET
         name = COALESCE(?, name), category = COALESCE(?, category),
         unit = COALESCE(?, unit), minimum_level = COALESCE(?, minimum_level),
         storage_location = COALESCE(?, storage_location),
         evacuation_center_id = COALESCE(?, evacuation_center_id)
       WHERE id = ?`,
      [name || null, category || null, unit || null,
       minimum_level !== undefined ? Number(minimum_level) : null,
       storage_location || null, evacuation_center_id || null, req.params.id]);
    await logActivity(req, 'resource.updated', 'resource', req.params.id, name || '');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update resource.' });
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM resources WHERE id = ?', [req.params.id]);
    await logActivity(req, 'resource.deleted', 'resource', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete resource.' });
  }
});

module.exports = router;
