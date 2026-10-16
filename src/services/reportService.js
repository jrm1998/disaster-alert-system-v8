const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const pool = require('../../config/db');

async function gatherReportData(filters = {}) {
  const where = [];
  const params = [];
  if (filters.from) { where.push('i.created_at >= ?'); params.push(filters.from + ' 00:00:00'); }
  if (filters.to) { where.push('i.created_at <= ?'); params.push(filters.to + ' 23:59:59'); }
  if (filters.status) { where.push('i.status = ?'); params.push(filters.status); }
  if (filters.barangay_id) { where.push('i.barangay_id = ?'); params.push(filters.barangay_id); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const [incidents] = await pool.query(
    `SELECT i.id, i.incident_type, i.description, i.status, i.address, i.created_at, i.updated_at,
            b.name AS barangay, u.name AS reporter
     FROM incidents i
     LEFT JOIN barangays b ON b.id = i.barangay_id
     LEFT JOIN users u ON u.id = i.reporter_id
     ${whereSql} ORDER BY i.created_at DESC`, params);

  const [alerts] = await pool.query(
    `SELECT a.id, a.title, a.severity, a.status, a.sent_at, a.created_at, uc.name AS created_by_name
     FROM alerts a LEFT JOIN users uc ON uc.id = a.created_by
     ORDER BY a.created_at DESC LIMIT 100`);

  const [evacCenters] = await pool.query(
    `SELECT e.name, e.capacity, e.occupants, e.status, b.name AS barangay
     FROM evacuation_centers e LEFT JOIN barangays b ON b.id = e.barangay_id`);

  const [riskRows] = await pool.query(
    `SELECT name, risk_level, flood_risk, landslide_risk, storm_surge_risk, earthquake_risk, overall_risk, population
     FROM barangays
     ORDER BY FIELD(overall_risk, 'critical','high','moderate','low'), name`);

  const [stats] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM incidents) AS total_incidents,
       (SELECT COUNT(*) FROM incidents WHERE status <> 'resolved') AS open_incidents,
       (SELECT COUNT(*) FROM alerts WHERE status = 'sent') AS alerts_sent,
       (SELECT COALESCE(SUM(occupants),0) FROM evacuation_centers) AS total_evacuees,
       (SELECT COUNT(*) FROM missing_persons WHERE status = 'missing') AS missing_count`);

  return {
    // Render the generation time in Philippine Time (UTC+8) for reports.
    generated_at: new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }),
    filters,
    incidents,
    alerts,
    evacCenters,
    riskRows,
    stats: stats[0]
  };
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

function toCsv(data) {
  const lines = [];
  lines.push('MUNICIPALITY DISASTER ALERT SYSTEM - REPORT');
  lines.push('Generated,' + csvEscape(data.generated_at));
  lines.push('');
  lines.push('SUMMARY');
  lines.push('Total Incidents,' + data.stats.total_incidents);
  lines.push('Open Incidents,' + data.stats.open_incidents);
  lines.push('Alerts Sent,' + data.stats.alerts_sent);
  lines.push('Total Evacuees,' + data.stats.total_evacuees);
  lines.push('Missing Persons,' + data.stats.missing_count);
  lines.push('');
  lines.push('INCIDENTS');
  lines.push(['ID', 'Type', 'Status', 'Barangay', 'Address', 'Reporter', 'Reported At', 'Description'].map(csvEscape).join(','));
  for (const i of data.incidents) {
    lines.push([i.id, i.incident_type, i.status, i.barangay, i.address, i.reporter, i.created_at, i.description].map(csvEscape).join(','));
  }
  lines.push('');
  lines.push('ALERTS');
  lines.push(['ID', 'Title', 'Severity', 'Status', 'Sent At', 'Created By'].map(csvEscape).join(','));
  for (const a of data.alerts) {
    lines.push([a.id, a.title, a.severity, a.status, a.sent_at, a.created_by_name].map(csvEscape).join(','));
  }
  lines.push('');
  lines.push('EVACUATION CENTERS');
  lines.push(['Name', 'Barangay', 'Capacity', 'Occupants', 'Status'].map(csvEscape).join(','));
  for (const e of data.evacCenters) {
    lines.push([e.name, e.barangay, e.capacity, e.occupants, e.status].map(csvEscape).join(','));
  }
  lines.push('');
  lines.push('BARANGAY RISK LEVELS');
  lines.push(['Barangay', 'Flood', 'Landslide', 'Storm Surge', 'Earthquake', 'Overall', 'Population'].map(csvEscape).join(','));
  for (const r of data.riskRows) {
    lines.push([r.name, r.flood_risk, r.landslide_risk, r.storm_surge_risk, r.earthquake_risk, r.overall_risk, r.population].map(csvEscape).join(','));
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

async function toExcel(data) {
  const wb = new ExcelJS.Workbook();

  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ header: 'Metric', key: 'm', width: 30 }, { header: 'Value', key: 'v', width: 20 }];
  summary.addRows([
    { m: 'Generated At', v: data.generated_at },
    { m: 'Total Incidents', v: data.stats.total_incidents },
    { m: 'Open Incidents', v: data.stats.open_incidents },
    { m: 'Alerts Sent', v: data.stats.alerts_sent },
    { m: 'Total Evacuees', v: data.stats.total_evacuees },
    { m: 'Missing Persons', v: data.stats.missing_count }
  ]);
  summary.getRow(1).font = { bold: true };

  const inc = wb.addWorksheet('Incidents');
  inc.columns = [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Type', key: 'type', width: 15 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Barangay', key: 'bgy', width: 18 },
    { header: 'Address', key: 'addr', width: 25 },
    { header: 'Reporter', key: 'rep', width: 18 },
    { header: 'Reported At', key: 'at', width: 20 },
    { header: 'Description', key: 'desc', width: 60 }
  ];
  for (const i of data.incidents) {
    inc.addRow({ id: i.id, type: i.incident_type, status: i.status, bgy: i.barangay, addr: i.address, rep: i.reporter, at: i.created_at, desc: i.description });
  }
  inc.getRow(1).font = { bold: true };

  const al = wb.addWorksheet('Alerts');
  al.columns = [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Title', key: 'title', width: 50 },
    { header: 'Severity', key: 'sev', width: 12 },
    { header: 'Status', key: 'status', width: 15 },
    { header: 'Sent At', key: 'sent', width: 20 },
    { header: 'Created By', key: 'by', width: 20 }
  ];
  for (const a of data.alerts) {
    al.addRow({ id: a.id, title: a.title, sev: a.severity, status: a.status, sent: a.sent_at, by: a.created_by_name });
  }
  al.getRow(1).font = { bold: true };

  const ec = wb.addWorksheet('Evacuation Centers');
  ec.columns = [
    { header: 'Name', key: 'n', width: 35 },
    { header: 'Barangay', key: 'b', width: 18 },
    { header: 'Capacity', key: 'c', width: 12 },
    { header: 'Occupants', key: 'o', width: 12 },
    { header: 'Status', key: 's', width: 12 }
  ];
  for (const e of data.evacCenters) {
    ec.addRow({ n: e.name, b: e.barangay, c: e.capacity, o: e.occupants, s: e.status });
  }
  ec.getRow(1).font = { bold: true };

  const risk = wb.addWorksheet('Barangay Risk');
  risk.columns = [
    { header: 'Barangay', key: 'n', width: 25 },
    { header: 'Flood', key: 'f', width: 12 },
    { header: 'Landslide', key: 'l', width: 12 },
    { header: 'Storm Surge', key: 'ss', width: 13 },
    { header: 'Earthquake', key: 'e', width: 12 },
    { header: 'Overall', key: 'o', width: 12 },
    { header: 'Population', key: 'p', width: 15 }
  ];
  for (const r of data.riskRows) {
    risk.addRow({ n: r.name, f: r.flood_risk, l: r.landslide_risk, ss: r.storm_surge_risk, e: r.earthquake_risk, o: r.overall_risk, p: r.population });
  }
  risk.getRow(1).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function toPdf(data, res) {
  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  doc.pipe(res);

  const H1 = { font: 'Helvetica-Bold', size: 16 };
  const H2 = { font: 'Helvetica-Bold', size: 12 };
  const BODY = { font: 'Helvetica', size: 9 };

  doc.font(H1.font).fontSize(H1.size).text('MUNICIPALITY DISASTER ALERT SYSTEM', { align: 'center' });
  doc.font(H2.font).fontSize(H2.size).text('Disaster Operations Report', { align: 'center' });
  doc.font(BODY.font).fontSize(BODY.size).text(`Generated: ${data.generated_at}`, { align: 'center' });
  if (data.filters.from || data.filters.to) {
    doc.text(`Period: ${data.filters.from || 'beginning'} to ${data.filters.to || 'now'}`, { align: 'center' });
  }
  doc.moveDown();

  doc.font(H2.font).fontSize(H2.size).text('Summary Statistics');
  doc.font(BODY.font).fontSize(BODY.size);
  const s = data.stats;
  doc.text(`Total incidents: ${s.total_incidents}    Open incidents: ${s.open_incidents}`);
  doc.text(`Alerts sent: ${s.alerts_sent}    Current evacuees: ${s.total_evacuees}    Missing persons: ${s.missing_count}`);
  doc.moveDown();

  const drawTable = (title, headers, widths, rows) => {
    if (doc.y > 700) doc.addPage();
    doc.font(H2.font).fontSize(H2.size).text(title);
    doc.font('Helvetica-Bold').fontSize(8);
    let x = doc.page.margins.left;
    const y0 = doc.y;
    headers.forEach((h, i) => { doc.text(h, x + 2, y0, { width: widths[i] - 4 }); x += widths[i]; });
    doc.y = y0 + 14;
    doc.font(BODY.font).fontSize(8);
    rows.forEach(r => {
      if (doc.y > 760) {
        doc.addPage();
        doc.font(BODY.font).fontSize(8);
      }
      x = doc.page.margins.left;
      const rowY = doc.y;
      let maxLines = 1;
      r.forEach((cell, i) => {
        const text = cell == null ? '' : String(cell);
        maxLines = Math.max(maxLines, doc.heightOfString(text, { width: widths[i] - 4 }) / 10);
      });
      const rowH = Math.max(12, Math.ceil(maxLines) * 10 + 2);
      r.forEach((cell, i) => {
        doc.text(cell == null ? '' : String(cell), x + 2, rowY, { width: widths[i] - 4, height: rowH, ellipsis: true });
        x += widths[i];
      });
      doc.y = rowY + rowH;
    });
    doc.moveDown();
  };

  drawTable(
    'Incidents',
    ['ID', 'Type', 'Status', 'Barangay', 'Reported', 'Description'],
    [25, 60, 60, 75, 95, 200],
    data.incidents.slice(0, 60).map(i => [i.id, i.incident_type, i.status, i.barangay, i.created_at, i.description])
  );

  drawTable(
    'Alerts',
    ['ID', 'Title', 'Severity', 'Status', 'Sent At'],
    [25, 260, 55, 75, 100],
    data.alerts.slice(0, 40).map(a => [a.id, a.title, a.severity, a.status, a.sent_at])
  );

  drawTable(
    'Evacuation Centers',
    ['Name', 'Barangay', 'Capacity', 'Occupants', 'Status'],
    [185, 95, 60, 65, 110],
    data.evacCenters.map(e => [e.name, e.barangay, e.capacity, e.occupants, e.status])
  );

  drawTable(
    'Barangay Risk Levels',
    ['Barangay', 'Flood', 'Landslide', 'Storm Surge', 'Earthquake', 'Overall', 'Population'],
    [140, 62, 72, 82, 78, 66, 70],
    data.riskRows.map(r => [r.name, r.flood_risk, r.landslide_risk, r.storm_surge_risk, r.earthquake_risk, r.overall_risk, r.population])
  );

  doc.end();
}

module.exports = { gatherReportData, toCsv, toExcel, toPdf };
