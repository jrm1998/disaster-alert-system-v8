const express = require('express');
const pool = require('../../config/db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

const router = express.Router();
const RISK_LEVELS = ['low', 'moderate', 'high', 'critical'];
const RISK_RANK = { low: 0, moderate: 1, high: 2, critical: 3 };
const RISK_FIELDS = ['flood_risk', 'landslide_risk', 'storm_surge_risk', 'earthquake_risk', 'overall_risk'];

// Overall risk defaults to the highest of the four hazard-specific risks.
function computeOverall(risks) {
  let max = 'low';
  for (const f of ['flood_risk', 'landslide_risk', 'storm_surge_risk', 'earthquake_risk']) {
    const v = risks[f];
    if (v && RISK_RANK[v] > RISK_RANK[max]) max = v;
  }
  return max;
}

function validRisk(v) {
  return v === undefined || v === null || RISK_LEVELS.includes(v);
}

// Public: barangay list with risk levels (Disaster Risk Dashboard data)
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.id, b.name, b.risk_level,
              b.flood_risk, b.landslide_risk, b.storm_surge_risk, b.earthquake_risk, b.overall_risk,
              b.latitude, b.longitude, b.population,
              (SELECT COUNT(*) FROM incidents i WHERE i.barangay_id = b.id AND i.status <> 'resolved') AS open_incidents,
              (SELECT COALESCE(SUM(e.occupants),0) FROM evacuation_centers e WHERE e.barangay_id = b.id) AS evacuees
       FROM barangays b
       ORDER BY FIELD(b.overall_risk,'critical','high','moderate','low'), b.name`);
    const summary = { critical: 0, high: 0, moderate: 0, low: 0 };
    for (const r of rows) summary[r.overall_risk]++;
    res.json({ barangays: rows, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load barangays.' });
  }
});

// Update risk fields / coordinates (admin)
router.put('/:id', requireRole('admin'), async (req, res) => {
  try {
    const body = req.body;
    for (const f of RISK_FIELDS) {
      if (!validRisk(body[f])) return res.status(400).json({ error: `Invalid value for ${f}.` });
    }
    if (body.risk_level && !RISK_LEVELS.includes(body.risk_level)) {
      return res.status(400).json({ error: 'Invalid risk level.' });
    }
    const [rows] = await pool.query('SELECT * FROM barangays WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Barangay not found.' });
    const current = rows[0];

    // Merge provided hazard risks with existing values.
    const merged = {};
    for (const f of ['flood_risk', 'landslide_risk', 'storm_surge_risk', 'earthquake_risk']) {
      merged[f] = body[f] || current[f];
    }
    // overall_risk: explicit value wins; otherwise recompute from the four hazards.
    // A legacy risk_level edit is treated as an explicit overall_risk.
    let overall;
    if (body.overall_risk) overall = body.overall_risk;
    else if (body.risk_level) overall = body.risk_level;
    else overall = computeOverall(merged);

    await pool.query(
      `UPDATE barangays SET
         flood_risk = ?, landslide_risk = ?, storm_surge_risk = ?, earthquake_risk = ?,
         overall_risk = ?, risk_level = ?,
         latitude = COALESCE(?, latitude),
         longitude = COALESCE(?, longitude),
         population = COALESCE(?, population)
       WHERE id = ?`,
      [merged.flood_risk, merged.landslide_risk, merged.storm_surge_risk, merged.earthquake_risk,
       overall, overall,
       body.latitude !== undefined ? Number(body.latitude) : null,
       body.longitude !== undefined ? Number(body.longitude) : null,
       body.population !== undefined ? Number(body.population) : null,
       req.params.id]);

    const changed = RISK_FIELDS.filter(f => body[f]).map(f => `${f}=${body[f]}`).join(', ');
    await logActivity(req, 'barangay.updated', 'barangay', req.params.id, changed || `overall=${overall}`);
    res.json({ ok: true, overall_risk: overall });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update barangay.' });
  }
});

router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const { name, risk_level, latitude, longitude, population } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    for (const f of RISK_FIELDS) {
      if (!validRisk(req.body[f])) return res.status(400).json({ error: `Invalid value for ${f}.` });
    }
    const merged = {
      flood_risk: req.body.flood_risk || 'low',
      landslide_risk: req.body.landslide_risk || 'low',
      storm_surge_risk: req.body.storm_surge_risk || 'low',
      earthquake_risk: req.body.earthquake_risk || 'low'
    };
    const overall = req.body.overall_risk || risk_level || computeOverall(merged);
    const [result] = await pool.query(
      `INSERT INTO barangays (name, risk_level, flood_risk, landslide_risk, storm_surge_risk, earthquake_risk, overall_risk, latitude, longitude, population)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [name.trim(), overall, merged.flood_risk, merged.landslide_risk, merged.storm_surge_risk, merged.earthquake_risk, overall,
       latitude != null ? Number(latitude) : null,
       longitude != null ? Number(longitude) : null,
       Number(population) || 0]);
    await logActivity(req, 'barangay.created', 'barangay', result.insertId, name);
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Barangay name already exists.' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create barangay.' });
  }
});

module.exports = router;
