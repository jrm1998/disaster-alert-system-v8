const express = require('express');
const fs = require('fs');
const pool = require('../../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const aiService = require('../services/aiService');
const pdfImport = require('../services/pdfImport');
const { pdfUpload } = require('../middleware/upload');

const router = express.Router();

// AI Disaster Assistant chat (available to everyone logged in)
router.post('/chat', requireAuth, async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'Question is required.' });
    const result = await aiService.ask(question);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'AI assistant failed.' });
  }
});

// AI PDF Import: upload a bulletin PDF -> draft alert (officials/admins).
// The draft still needs review, approval, and sending through the normal flow.
router.post('/pdf-import', requireRole('admin', 'barangay_official'), pdfUpload.single('pdf'), async (req, res) => {
  const filePath = req.file ? req.file.path : null;
  try {
    if (!req.file) return res.status(400).json({ error: 'A PDF file is required (field name: "pdf").' });
    const buffer = fs.readFileSync(filePath);
    const draft = await pdfImport.parsePdfToDraft(buffer);

    // Save immediately as a draft alert
    const [result] = await pool.query(
      `INSERT INTO alerts (title, message, alert_type, severity, status, target_type, created_by, source)
       VALUES (?,?,?,?, 'draft', ?, ?, 'ai_import')`,
      [draft.title, draft.message, draft.alert_type, draft.severity,
       draft.target_type, req.session.user.id]);
    const alertId = result.insertId;
    if (draft.target_type === 'barangay') {
      for (const bid of draft.suggested_barangay_ids) {
        await pool.query('INSERT IGNORE INTO alert_barangays (alert_id, barangay_id) VALUES (?,?)', [alertId, bid]);
      }
    }
    await logActivity(req, 'alert.ai_imported', 'alert', alertId, `From PDF: ${draft.title}`);
    res.status(201).json({ alert_id: alertId, draft });
  } catch (err) {
    console.error('[ai] pdf import failed:', err.message);
    res.status(400).json({ error: `PDF import failed: ${err.message}` });
  } finally {
    if (filePath) fs.unlink(filePath, () => {});
  }
});

module.exports = router;
