const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

const router = express.Router();
const ROLES = ['resident', 'responder', 'barangay_official', 'admin'];

// All user management is admin-only
router.use(requireRole('admin'));

router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.barangay_id, u.team_id, u.phone, u.is_active, u.created_at,
              b.name AS barangay_name, t.name AS team_name
       FROM users u
       LEFT JOIN barangays b ON b.id = u.barangay_id
       LEFT JOIN rescue_teams t ON t.id = u.team_id
       ORDER BY u.created_at DESC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load users.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, email, password, phone, barangay_id, team_id } = req.body;
    const role = ROLES.includes(req.body.role) ? req.body.role : 'resident';
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing.length) return res.status(409).json({ error: 'Email already in use.' });
    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (name, email, password_hash, role, phone, barangay_id, team_id) VALUES (?,?,?,?,?,?,?)',
      [name.trim(), email.toLowerCase(), hash, role, phone || null, barangay_id || null, team_id || null]);
    await logActivity(req, 'user.created', 'user', result.insertId, `${role}: ${email}`);
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create user.' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, phone, barangay_id, team_id, role, is_active, password } = req.body;
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    if (role !== undefined && !ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role.' });
    }
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, id]);
    }
    await pool.query(
      `UPDATE users SET
         name = COALESCE(?, name),
         phone = COALESCE(?, phone),
         barangay_id = COALESCE(?, barangay_id),
         team_id = COALESCE(?, team_id),
         role = COALESCE(?, role),
         is_active = COALESCE(?, is_active)
       WHERE id = ?`,
      [name || null, phone || null, barangay_id !== undefined ? (barangay_id || null) : null,
       team_id !== undefined ? (team_id || null) : null,
       role || null, is_active !== undefined ? (is_active ? 1 : 0) : null, id]);
    await logActivity(req, 'user.updated', 'user', id, JSON.stringify({ name, role, is_active }));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update user.' });
  }
});

module.exports = router;
