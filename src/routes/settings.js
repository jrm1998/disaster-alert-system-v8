const express = require('express');
const pool = require('../../config/db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

const router = express.Router();

// Keys an administrator is allowed to customize (feature 6). Values are all
// non-secret and safe to expose publicly for branding.
const ALLOWED_KEYS = [
  'system_name', 'short_name', 'municipality_name', 'logo_url', 'theme_color',
  'contact_email', 'contact_phone', 'hotline', 'address', 'footer_text',
  'map_center_lat', 'map_center_lng', 'map_zoom'
];

// Public: read all settings as a { key: value } object.
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM system_settings');
    const out = {};
    for (const r of rows) out[r.setting_key] = r.setting_value;
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load settings.' });
  }
});

// Admin: update one or more settings.
router.put('/', requireRole('admin'), async (req, res) => {
  try {
    const updates = [];
    const params = [];
    for (const key of ALLOWED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        updates.push(key);
        params.push(req.body[key] == null ? null : String(req.body[key]));
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid settings provided.' });
    for (let i = 0; i < updates.length; i++) {
      await pool.query(
        `INSERT INTO system_settings (setting_key, setting_value) VALUES (?,?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [updates[i], params[i]]);
    }
    await logActivity(req, 'settings.updated', 'system_settings', null, updates.join(', '));
    res.json({ ok: true, updated: updates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

module.exports = router;
