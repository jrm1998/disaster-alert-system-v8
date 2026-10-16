const express = require('express');
const pool = require('../../config/db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const advisoryService = require('../services/advisoryService');

const router = express.Router();
const AGENCIES = ['PAGASA', 'PHIVOLCS', 'NDRRMC', 'DENR', 'LGU', 'OTHER'];

// Public feed of official advisories affecting the municipality (feature 5).
router.get('/', async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.query.agency && AGENCIES.includes(req.query.agency)) {
      where = 'WHERE agency = ?';
      params.push(req.query.agency);
    }
    const limit = Math.min(Number(req.query.limit) || 40, 100);
    const [rows] = await pool.query(
      `SELECT a.id, a.agency, a.advisory_type, a.title, a.affected_areas, a.alert_level,
              a.details, a.issued_at, a.source_url, a.auto, a.created_at, u.name AS created_by_name
       FROM official_advisories a
       LEFT JOIN users u ON u.id = a.created_by
       ${where}
       ORDER BY COALESCE(a.issued_at, a.created_at) DESC, a.id DESC
       LIMIT ${limit}`, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load advisories.' });
  }
});

// Admin: force an immediate refresh of the automated feeds.
router.post('/refresh', requireRole('admin', 'barangay_official'), async (req, res) => {
  try {
    const added = await advisoryService.refresh();
    await logActivity(req, 'advisories.refreshed', 'official_advisories', null, `${added} new`);
    res.json({ ok: true, added });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Advisory refresh failed.' });
  }
});

// Admin/official: generate (or regenerate) today's multi-hazard situation report.
router.post('/daily-report', requireRole('admin', 'barangay_official'), async (req, res) => {
  try {
    const report = await advisoryService.buildDailyReport();
    await logActivity(req, 'advisories.daily_report', 'official_advisories', null,
      `${report.externalId} (${report.level})`);
    res.json({ ok: true, ...report });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build the daily report.' });
  }
});

// Officials/admins: post an official advisory (e.g. pasted from a PAGASA/DENR bulletin).
router.post('/', requireRole('admin', 'barangay_official'), async (req, res) => {
  try {
    const { agency, advisory_type, title, affected_areas, alert_level, details, issued_at, source_url } = req.body;
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required.' });
    const ag = AGENCIES.includes(agency) ? agency : 'OTHER';
    // issued_at may arrive as "YYYY-MM-DDTHH:MM" from a datetime-local input.
    const issuedSql = issued_at ? String(issued_at).replace('T', ' ') : null;
    const [result] = await pool.query(
      `INSERT INTO official_advisories
         (agency, advisory_type, title, affected_areas, alert_level, details, issued_at, source_url, auto, created_by)
       VALUES (?,?,?,?,?,?,?,?,0,?)`,
      [ag, (advisory_type || 'advisory').toString().slice(0, 60), String(title).trim().slice(0, 220),
       affected_areas || null, alert_level || null, details || null,
       issuedSql ? (issuedSql.length === 16 ? issuedSql + ':00' : issuedSql) : null,
       source_url || null, req.session.user.id]);
    await logActivity(req, 'advisory.created', 'official_advisories', result.insertId, `${ag}: ${title}`);
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to post advisory.' });
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM official_advisories WHERE id = ?', [req.params.id]);
    await logActivity(req, 'advisory.deleted', 'official_advisories', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete advisory.' });
  }
});

module.exports = router;
