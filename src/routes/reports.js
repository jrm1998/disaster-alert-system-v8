const express = require('express');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const reportService = require('../services/reportService');

const router = express.Router();

// Report generation: PDF, Excel, CSV (staff roles only)
router.use(requireRole('admin', 'barangay_official', 'responder'));

function filtersFrom(req) {
  return {
    from: req.query.from || null,   // YYYY-MM-DD
    to: req.query.to || null,
    status: req.query.status || null,
    barangay_id: req.query.barangay_id ? Number(req.query.barangay_id) : null
  };
}

function stamp() {
  // Philippine Time (UTC+8) wall-clock, formatted for a filename.
  return new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Manila' })
    .slice(0, 19)
    .replace(/[:T]/g, '-');
}

router.get('/csv', async (req, res) => {
  try {
    const data = await reportService.gatherReportData(filtersFrom(req));
    await logActivity(req, 'report.generated.csv', 'report', null, JSON.stringify(data.filters));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="mdas-report-${stamp()}.csv"`);
    res.send(reportService.toCsv(data));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'CSV report generation failed.' });
  }
});

router.get('/excel', async (req, res) => {
  try {
    const data = await reportService.gatherReportData(filtersFrom(req));
    await logActivity(req, 'report.generated.excel', 'report', null, JSON.stringify(data.filters));
    const buf = await reportService.toExcel(data);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="mdas-report-${stamp()}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Excel report generation failed.' });
  }
});

router.get('/pdf', async (req, res) => {
  try {
    const data = await reportService.gatherReportData(filtersFrom(req));
    await logActivity(req, 'report.generated.pdf', 'report', null, JSON.stringify(data.filters));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="mdas-report-${stamp()}.pdf"`);
    reportService.toPdf(data, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'PDF report generation failed.' });
  }
});

module.exports = router;
