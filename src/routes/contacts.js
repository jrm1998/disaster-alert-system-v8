const express = require('express');
const pool = require('../../config/db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

const router = express.Router();
const CATEGORIES = ['police', 'fire', 'ambulance', 'mdrrmo', 'hospital', 'barangay', 'other'];

// Public: quick-access emergency directory (cached offline by the PWA)
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM emergency_contacts ORDER BY sort_order, name');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load contacts.' });
  }
});

router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const { name, category, phone, address, sort_order } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required.' });
    const [result] = await pool.query(
      'INSERT INTO emergency_contacts (name, category, phone, address, sort_order) VALUES (?,?,?,?,?)',
      [name.trim(), CATEGORIES.includes(category) ? category : 'other', phone.trim(),
       address || null, Number(sort_order) || 0]);
    await logActivity(req, 'contact.created', 'emergency_contact', result.insertId, name);
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create contact.' });
  }
});

router.put('/:id', requireRole('admin'), async (req, res) => {
  try {
    const { name, category, phone, address, sort_order } = req.body;
    if (category && !CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category.' });
    }
    await pool.query(
      `UPDATE emergency_contacts SET
         name = COALESCE(?, name), category = COALESCE(?, category),
         phone = COALESCE(?, phone), address = COALESCE(?, address),
         sort_order = COALESCE(?, sort_order)
       WHERE id = ?`,
      [name || null, category || null, phone || null, address || null,
       sort_order !== undefined ? Number(sort_order) : null, req.params.id]);
    await logActivity(req, 'contact.updated', 'emergency_contact', req.params.id, name || '');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update contact.' });
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM emergency_contacts WHERE id = ?', [req.params.id]);
    await logActivity(req, 'contact.deleted', 'emergency_contact', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete contact.' });
  }
});

module.exports = router;
