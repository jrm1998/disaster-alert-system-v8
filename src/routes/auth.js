const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

const router = express.Router();

const PUBLIC_USER_FIELDS = 'id, name, email, role, barangay_id, phone, is_active';

// Self-registration: residents and responders only.
// Barangay officials and admins are created by an administrator.
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone, barangay_id } = req.body;
    const role = ['resident', 'responder'].includes(req.body.role) ? req.body.role : 'resident';
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing.length) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (name, email, password_hash, role, phone, barangay_id) VALUES (?,?,?,?,?,?)',
      [name.trim(), email.toLowerCase(), hash, role, phone || null, barangay_id || null]);
    req.session.user = { id: result.insertId, name: name.trim(), email: email.toLowerCase(), role, barangay_id: barangay_id || null };
    await logActivity(req, 'user.registered', 'user', result.insertId, `New ${role} account`);
    res.status(201).json({ id: result.insertId, name: name.trim(), email: email.toLowerCase(), role, barangay_id: barangay_id || null });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const [rows] = await pool.query(
      `SELECT id, name, email, password_hash, role, barangay_id, is_active
       FROM users WHERE email = ? LIMIT 1`, [email.toLowerCase()]);
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (!rows[0].is_active) {
      return res.status(403).json({ error: 'This account has been deactivated.' });
    }
    const u = rows[0];
    req.session.user = { id: u.id, name: u.name, email: u.email, role: u.role, barangay_id: u.barangay_id };
    await logActivity(req, 'user.login', 'user', u.id);
    res.json({ id: u.id, name: u.name, email: u.email, role: u.role, barangay_id: u.barangay_id });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Logout failed.' });
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json(req.session.user);
});

router.get('/barangays', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name FROM barangays ORDER BY name');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load barangays.' });
  }
});

// Expose whether push notifications can work (VAPID configured)
router.get('/push-key', (req, res) => {
  res.json({ vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null });
});

module.exports = router;
