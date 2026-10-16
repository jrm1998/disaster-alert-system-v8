const pdfParse = require('pdf-parse');
const pool = require('../../config/db');

// Parses bulletin text into a draft alert. The result is a SUGGESTION:
// an authorized user must still review, edit, and approve it.
async function parsePdfToDraft(buffer) {
  // pdf.js mis-reads the xref table when handed a pooled Node Buffer (non-zero
  // byteOffset into a shared ArrayBuffer), so copy into a clean Uint8Array.
  const data = await pdfParse(new Uint8Array(buffer));
  const text = String(data.text || '').replace(/\r/g, '').trim();
  if (!text) throw new Error('No readable text found in the PDF (it may be a scanned image).');

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const lower = text.toLowerCase();

  // Title: first line that looks like a headline, else first line truncated
  let title = lines[0] || 'Imported Bulletin';
  const headline = lines.find(l =>
    /bulletin|warning|advisory|alert|signal|typhoon|tropical|flood|landslide|storm/i.test(l) && l.length <= 120);
  if (headline) title = headline;
  title = title.replace(/\s+/g, ' ').slice(0, 190);

  // Severity classification from bulletin keywords
  let severity = 'info';
  if (/signal no\.?\s*[345]|red alert|catastrophic|life[- ]threatening|extreme danger/i.test(lower)) severity = 'critical';
  else if (/signal no\.?\s*[12]|warning|severe|danger|evacuate|advisory/i.test(lower)) severity = 'warning';

  // Alert type
  let alertType = 'advisory';
  if (/all clear|no longer a threat|downgraded/i.test(lower)) alertType = 'all_clear';
  else if (/preemptive evacuation|evacuate immediately|forced evacuation/i.test(lower)) alertType = 'evacuation';
  else if (severity === 'critical') alertType = 'warning';

  // Message: first ~1200 chars of body after the title line
  const bodyStart = lines.findIndex(l => l === (headline || lines[0])) + 1;
  const body = lines.slice(Math.max(bodyStart, 1)).join(' ').replace(/\s+/g, ' ').trim();
  const message = (body || text).slice(0, 1200);

  // Detect mentioned barangays to pre-select alert targets
  const [barangays] = await pool.query('SELECT id, name FROM barangays');
  const mentioned = barangays.filter(b => lower.includes(b.name.toLowerCase()));

  return {
    title,
    message,
    severity,
    alert_type: alertType,
    target_type: mentioned.length ? 'barangay' : 'all',
    suggested_barangay_ids: mentioned.map(b => b.id),
    suggested_barangay_names: mentioned.map(b => b.name),
    extracted_text_preview: text.slice(0, 500),
    page_count: data.numpages || null
  };
}

module.exports = { parsePdfToDraft };
