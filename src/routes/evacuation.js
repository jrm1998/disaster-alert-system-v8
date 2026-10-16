const express = require('express');
const pool = require('../../config/db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

const router = express.Router();
const STATUSES = ['standby', 'open', 'full', 'closed'];

// Public: centers with capacity + occupancy for the map and info pages
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT e.*, b.name AS barangay
       FROM evacuation_centers e LEFT JOIN barangays b ON b.id = e.barangay_id
       ORDER BY e.status = 'open' DESC, e.name`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load evacuation centers.' });
  }
});

// Staff: create / update centers and occupancy
router.post('/', requireRole('admin', 'barangay_official'), async (req, res) => {
  try {
    const { name, barangay_id, address, latitude, longitude, capacity, contact_phone, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    const [result] = await pool.query(
      `INSERT INTO evacuation_centers (name, barangay_id, address, latitude, longitude, capacity, contact_phone, notes)
       VALUES (?,?,?,?,?,?,?,?)`,
      [name.trim(), barangay_id || null, address || null,
       latitude != null ? Number(latitude) : null, longitude != null ? Number(longitude) : null,
       Number(capacity) || 0, contact_phone || null, notes || null]);
    await logActivity(req, 'evac_center.created', 'evacuation_center', result.insertId, name);
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create evacuation center.' });
  }
});

router.put('/:id', requireRole('admin', 'barangay_official', 'responder'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query('SELECT * FROM evacuation_centers WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Evacuation center not found.' });
    const { name, address, capacity, occupants, status, contact_phone, notes, latitude, longitude, barangay_id } = req.body;
    if (status && !STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }
    const newCapacity = capacity !== undefined ? Number(capacity) : rows[0].capacity;
    const newOccupants = occupants !== undefined ? Number(occupants) : rows[0].occupants;
    if (isNaN(newOccupants) || newOccupants < 0) {
      return res.status(400).json({ error: 'Occupants must be a non-negative number.' });
    }
    if (newOccupants > newCapacity) {
      return res.status(400).json({ error: `Occupants (${newOccupants}) exceed capacity (${newCapacity}).` });
    }
    let effectiveStatus = status || rows[0].status;
    if (occupants !== undefined || capacity !== undefined) {
      effectiveStatus = newOccupants >= newCapacity && newCapacity > 0 ? 'full' : (newOccupants > 0 ? 'open' : rows[0].status);
      if (status && STATUSES.includes(status)) effectiveStatus = status;
    }
    await pool.query(
      `UPDATE evacuation_centers SET
         name = COALESCE(?, name), address = COALESCE(?, address),
         capacity = ?, occupants = ?, status = ?,
         contact_phone = COALESCE(?, contact_phone), notes = COALESCE(?, notes),
         latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude),
         barangay_id = COALESCE(?, barangay_id)
       WHERE id = ?`,
      [name || null, address || null, newCapacity, newOccupants, effectiveStatus,
       contact_phone || null, notes || null,
       latitude != null ? Number(latitude) : null, longitude != null ? Number(longitude) : null,
       barangay_id || null, id]);
    await logActivity(req, 'evac_center.updated', 'evacuation_center', id,
      `occupants=${newOccupants}/${newCapacity} status=${effectiveStatus}`);
    res.json({ ok: true, status: effectiveStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update evacuation center.' });
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM evacuation_centers WHERE id = ?', [req.params.id]);
    await logActivity(req, 'evac_center.deleted', 'evacuation_center', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete evacuation center.' });
  }
});

module.exports = router;
