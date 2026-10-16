const express = require('express');
const pool = require('../../config/db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Disaster statistics overview (staff dashboard)
router.get('/', requireRole('admin', 'barangay_official', 'responder'), async (req, res) => {
  try {
    const [[inc]] = await pool.query(
      `SELECT
         COUNT(*) AS total,
         SUM(status = 'reported') AS reported,
         SUM(status = 'verified') AS verified,
         SUM(status = 'responding') AS responding,
         SUM(status = 'resolved') AS resolved
       FROM incidents`);
    const [[recent]] = await pool.query(
      `SELECT COUNT(*) AS last7d FROM incidents WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`);
    const [byType] = await pool.query(
      'SELECT incident_type, COUNT(*) AS count FROM incidents GROUP BY incident_type ORDER BY count DESC');
    const [byBarangay] = await pool.query(
      `SELECT b.name AS barangay, COUNT(i.id) AS incidents,
              SUM(i.status <> 'resolved') AS open
       FROM incidents i JOIN barangays b ON b.id = i.barangay_id
       GROUP BY b.id ORDER BY incidents DESC LIMIT 10`);
    const [[evac]] = await pool.query(
      `SELECT COALESCE(SUM(occupants),0) AS total_evacuees,
              COALESCE(SUM(capacity),0) AS total_capacity,
              SUM(status = 'open') AS open_centers
       FROM evacuation_centers`);
    const [[alerts]] = await pool.query(
      `SELECT
         SUM(status = 'sent') AS sent,
         SUM(status = 'pending_approval') AS pending,
         SUM(status = 'sent' AND sent_at > DATE_SUB(NOW(), INTERVAL 7 DAY)) AS sent_last7d
       FROM alerts`);
    const [[teams]] = await pool.query(
      `SELECT COUNT(*) AS total, SUM(status = 'available') AS available,
              SUM(status IN ('dispatched','on_mission')) AS deployed
       FROM rescue_teams`);
    const [[missing]] = await pool.query(
      `SELECT SUM(status = 'missing') AS missing, SUM(status = 'found') AS found FROM missing_persons`);
    const [[resources]] = await pool.query(
      `SELECT COUNT(*) AS items, SUM(quantity < minimum_level) AS below_minimum FROM resources`);

    res.json({
      incidents: { ...inc, last_7_days: recent.last7d, by_type: byType, by_barangay: byBarangay },
      evacuation: evac,
      alerts: { sent: alerts.sent || 0, pending_approval: alerts.pending || 0, sent_last_7_days: alerts.sent_last7d || 0 },
      teams: { total: teams.total || 0, available: teams.available || 0, deployed: teams.deployed || 0 },
      missing: { missing: missing.missing || 0, found: missing.found || 0 },
      resources: { items: resources.items || 0, below_minimum: resources.below_minimum || 0 }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load statistics.' });
  }
});

module.exports = router;
