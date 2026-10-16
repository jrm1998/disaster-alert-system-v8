// Official disaster advisory aggregation.
//
// PAGASA / NDRRMC / DENR do not offer a stable free JSON API and their sites block
// server-side scraping, so this service combines:
//   - Manual advisories posted by admins/officials (pasted from official bulletins)
//     for PAGASA / NDRRMC / DENR / LGU
//   - One reliable free automated feed that covers the Philippines without a key:
//       * USGS earthquake catalog near the municipality  -> tagged PHIVOLCS
//     (ReliefWeb's API was retired (v1 = 410) and v2 now requires a pre-approved
//      appname, so it is no longer used.)
// Everything is cached in the official_advisories table (deduped by external_id)
// so the public feed works even when an upstream source is down.
const axios = require('axios');
const cron = require('node-cron');
const pool = require('../../config/db');
const weatherService = require('./weatherService');

const HIN_LAT = Number(process.env.WEATHER_LAT || 10.394278);
const HIN_LNG = Number(process.env.WEATHER_LNG || 125.198427);
const PLACE = process.env.WEATHER_LOCATION || 'Hinunangan, Southern Leyte';
const TIMEOUT = 9000;

function magLevel(mag) {
  if (mag >= 6) return 'critical';
  if (mag >= 5) return 'warning';
  return 'info';
}

// Insert-or-ignore an advisory (external_id is UNIQUE, so re-runs never duplicate).
async function upsertExternal(a) {
  const [r] = await pool.query(
    `INSERT IGNORE INTO official_advisories
       (agency, advisory_type, title, affected_areas, alert_level, details, issued_at, source_url, external_id, auto)
     VALUES (?,?,?,?,?,?,?,?,?,1)`,
    [a.agency, a.advisory_type, a.title, a.affected_areas || null, a.alert_level || null,
     a.details || null, a.issued_at || null, a.source_url || null, a.external_id]);
  return r.affectedRows > 0;
}

async function fetchEarthquakes() {
  const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
  const resp = await axios.get(url, {
    params: {
      format: 'geojson', latitude: HIN_LAT, longitude: HIN_LNG,
      maxradiuskm: 300, minmagnitude: 4.0, orderby: 'time', limit: 10
    },
    timeout: TIMEOUT
  });
  const feats = (resp.data && resp.data.features) || [];
  let added = 0;
  for (const f of feats) {
    const p = f.properties || {};
    const mag = p.mag != null ? Number(p.mag) : null;
    const when = p.time ? new Date(p.time) : new Date();
    // Convert to a MySQL DATETIME string in Philippine Time (UTC+8).
    const issued = new Date(when.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const ok = await upsertExternal({
      agency: 'PHIVOLCS',
      advisory_type: 'earthquake',
      title: `M${mag != null ? mag.toFixed(1) : '?'} earthquake - ${p.place || 'near the municipality'}`,
      affected_areas: `${p.place || ''} (300 km watch radius of ${PLACE})`,
      alert_level: mag != null ? magLevel(mag) : 'info',
      details: `Magnitude ${mag != null ? mag.toFixed(1) : 'unknown'} earthquake recorded at ${p.place || 'unknown location'}. ` +
        (p.tsunami ? 'A tsunami advisory was issued for this event. ' : '') +
        'Monitor PHIVOLCS for official depth, intensity and aftershock information. Source: USGS Earthquake Hazards Program.',
      issued_at: issued,
      source_url: `https://earthquake.usgs.gov/earthquakes/eventpage/${f.id}`,
      external_id: `usgs-${f.id}`
    });
    if (ok) added++;
  }
  return added;
}

// Pulls all automated feeds. Each source is isolated so one failure never blocks
// the others. Returns how many NEW advisories were stored.
async function refresh() {
  let added = 0;
  const results = await Promise.allSettled([fetchEarthquakes()]);
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') added += r.value;
    else console.error(`[advisories] feed ${i} failed:`, r.reason && r.reason.message);
  });
  // Keep the table from growing unbounded: retain the newest 300 auto advisories.
  try {
    await pool.query(
      `DELETE FROM official_advisories WHERE auto = 1 AND id NOT IN (
         SELECT id FROM (SELECT id FROM official_advisories WHERE auto = 1 ORDER BY id DESC LIMIT 300) x)`);
  } catch (err) {
    console.error('[advisories] prune failed:', err.message);
  }
  return added;
}

function startMonitor() {
  // Refresh shortly after boot, then every 30 minutes.
  setTimeout(() => refresh().catch(err => console.error('[advisories] initial refresh failed:', err.message)), 8000);
  cron.schedule('*/30 * * * *', () => {
    refresh().catch(err => console.error('[advisories] refresh failed:', err.message));
  });
  // Publish the multi-hazard daily situation report every morning at 6:00 AM PHT.
  cron.schedule('0 6 * * *', () => {
    buildDailyReport().catch(err => console.error('[advisories] daily report failed:', err.message));
  });
  // Also generate one shortly after boot so the feed is never empty on a new day.
  setTimeout(() => buildDailyReport().catch(err => console.error('[advisories] initial daily report failed:', err.message)), 20000);
  console.log('[advisories] Official advisory monitor started (feeds every 30 min, daily report at 06:00).');
}

// ---------------------------------------------------------------------------
// Daily multi-hazard situation report.
// Aggregates the current picture across every hazard the system tracks and posts
// it as a single official advisory (deduped per calendar day via external_id):
//   - Typhoon / tropical-cyclone wind signals (derived from live wind + gusts)
//   - Earthquake updates (last 24h from the USGS/PHIVOLCS feed already stored)
//   - Rainfall warnings (open-meteo current + 3-day forecast)
//   - Flood alerts (sensors currently at alert/critical)
//   - Storm-surge risk (surge-prone barangays + onshore wind)
// Derived from data already in the system or free public feeds, so the report
// generates even when an upstream source is briefly unavailable.
// ---------------------------------------------------------------------------

// Maps sustained wind / gust (kph) to a PAGASA-style tropical cyclone wind signal.
function cycloneSignal(gust, wind) {
  const peak = Math.max(Number(gust) || 0, Number(wind) || 0);
  if (peak >= 185) return { signal: 5, wind: peak };
  if (peak >= 150) return { signal: 4, wind: peak };
  if (peak >= 120) return { signal: 3, wind: peak };
  if (peak >= 89) return { signal: 2, wind: peak };
  if (peak >= 62) return { signal: 1, wind: peak };
  return { signal: 0, wind: peak };
}

async function buildDailyReport() {
  const now = new Date();
  const pht = new Date(now.getTime() + 8 * 3600 * 1000);
  const dayKey = pht.toISOString().slice(0, 10);        // one report per PHT day
  const externalId = `daily-report-${dayKey}`;

  const sections = [];
  let worst = 'info';
  const rank = { info: 0, warning: 1, critical: 2 };
  const escalate = lvl => { if ((rank[lvl] || 0) > (rank[worst] || 0)) worst = lvl; };

  // --- Weather: typhoon signal, rainfall, storm-surge inputs ---
  let weather = null;
  try { weather = await weatherService.getWeather(true); }
  catch (err) { console.error('[advisories] daily report weather fetch failed:', err.message); }

  if (weather && weather.current) {
    const c = weather.current;
    const sig = cycloneSignal(c.gusts_kph, c.wind_kph);
    if (sig.signal > 0) {
      escalate(sig.signal >= 3 ? 'critical' : 'warning');
      sections.push(`TYPHOON / WIND SIGNAL: Signal #${sig.signal} conditions - peak winds ~${Math.round(sig.wind)} kph (${c.condition}). Secure loose objects, avoid coastal travel and follow evacuation orders if issued.`);
    } else {
      sections.push(`TYPHOON / WIND SIGNAL: No tropical-cyclone wind signal in effect. Winds ~${Math.round(c.wind_kph || 0)} kph, gusts ~${Math.round(c.gusts_kph || 0)} kph (${c.condition}).`);
    }

    const fc = weather.forecast || [];
    const maxPrecip = fc.reduce((m, d) => Math.max(m, Number(d.precipitation_mm) || 0), Number(c.precipitation_mm) || 0);
    if (maxPrecip >= 50) {
      escalate('critical');
      sections.push(`RAINFALL WARNING: Heavy rain expected (up to ${Math.round(maxPrecip)} mm). High flood risk in low-lying areas; see flood alerts below.`);
    } else if (maxPrecip >= 15) {
      escalate('warning');
      sections.push(`RAINFALL WARNING: Moderate to heavy rain expected (up to ${Math.round(maxPrecip)} mm). Stay alert for localized flooding.`);
    } else {
      sections.push(`RAINFALL WARNING: Light rainfall expected (up to ${Math.round(maxPrecip)} mm) over the next 3 days. No widespread flooding anticipated.`);
    }

    let surgeNote;
    try {
      const [surgeRows] = await pool.query(
        `SELECT COUNT(*) AS n FROM barangays WHERE storm_surge_risk IN ('high','critical')`);
      const n = surgeRows[0].n;
      if (sig.signal >= 2 && n > 0) {
        escalate('critical');
        surgeNote = `STORM SURGE: Elevated risk. ${n} surge-prone barangay(ies) could see life-threatening inundation with Signal #${sig.signal} winds. Coastal residents should pre-emptively evacuate to higher ground.`;
      } else if (n > 0) {
        surgeNote = `STORM SURGE: ${n} surge-prone barangay(ies) identified, but current winds are below storm-surge thresholds. Reassess during any tropical cyclone.`;
      } else {
        surgeNote = `STORM SURGE: No barangays currently flagged as surge-prone. Reassess ahead of any tropical cyclone.`;
      }
    } catch { surgeNote = 'STORM SURGE: Data unavailable at this time.'; }
    sections.push(surgeNote);
  } else {
    sections.push('TYPHOON / WIND SIGNAL: Weather data temporarily unavailable - monitor PAGASA for official forecasts.');
    sections.push('RAINFALL WARNING: Weather data temporarily unavailable.');
    sections.push('STORM SURGE: Weather data temporarily unavailable.');
  }

  // --- Earthquakes: last 24h already ingested from the USGS feed ---
  try {
    const [quakes] = await pool.query(
      `SELECT title, alert_level FROM official_advisories
       WHERE advisory_type = 'earthquake' AND auto = 1
         AND COALESCE(issued_at, created_at) > DATE_SUB(NOW(), INTERVAL 24 HOUR)
       ORDER BY COALESCE(issued_at, created_at) DESC LIMIT 5`);
    if (quakes.length) {
      escalate(quakes.some(q => q.alert_level === 'critical') ? 'critical' : 'warning');
      sections.push(`EARTHQUAKE UPDATES: ${quakes.length} event(s) near the municipality in the last 24 hours:\n` +
        quakes.map(q => `  - ${q.title}`).join('\n') +
        '\n  Monitor PHIVOLCS for official depth, intensity and aftershock information.');
    } else {
      sections.push('EARTHQUAKE UPDATES: No significant earthquakes recorded near the municipality in the last 24 hours (USGS/PHIVOLCS feed).');
    }
  } catch { sections.push('EARTHQUAKE UPDATES: Seismic feed unavailable at this time.'); }

  // --- Flood alerts: sensors currently at alert or critical ---
  try {
    const [sensors] = await pool.query(
      `SELECT s.name, r.water_level_m, r.status, b.name AS barangay
       FROM flood_sensors s
       JOIN flood_readings r ON r.id = (
         SELECT r2.id FROM flood_readings r2 WHERE r2.sensor_id = s.id ORDER BY r2.id DESC LIMIT 1)
       LEFT JOIN barangays b ON b.id = s.barangay_id
       WHERE s.is_active = 1 AND r.status IN ('alert','critical')
       ORDER BY FIELD(r.status,'critical','alert'), r.water_level_m DESC`);
    if (sensors.length) {
      escalate(sensors.some(s => s.status === 'critical') ? 'critical' : 'warning');
      sections.push(`FLOOD ALERTS: ${sensors.length} sensor(s) above normal:\n` +
        sensors.map(s => `  - ${s.name}${s.barangay ? ' (' + s.barangay + ')' : ''}: ${s.water_level_m} m [${String(s.status).toUpperCase()}]`).join('\n') +
        '\n  Residents near these waterways should prepare to evacuate if levels keep rising.');
    } else {
      sections.push('FLOOD ALERTS: All active water-level sensors are within normal range.');
    }
  } catch { sections.push('FLOOD ALERTS: Sensor data unavailable at this time.'); }

  const title = `Daily Multi-Hazard Situation Report - ${dayKey}`;
  const details =
    `MUNICIPALITY DAILY DISASTER SITUATION REPORT\n` +
    `Area: ${PLACE}\n` +
    `Generated: ${pht.toISOString().slice(0, 16).replace('T', ' ')} PHT\n` +
    `Overall status: ${worst.toUpperCase()}\n\n` +
    sections.join('\n\n') +
    `\n\nIn life-threatening emergencies call the local hotlines first (police/fire 117, ambulance 143, MDRRMO). ` +
    `Automated aggregation of PAGASA-style wind signals, PHIVOLCS/USGS seismic data, rainfall forecasts, flood ` +
    `sensor readings and storm-surge risk. Always defer to official agency bulletins.`;

  // Upsert one report per calendar day (external_id is UNIQUE).
  await pool.query(
    `INSERT INTO official_advisories
       (agency, advisory_type, title, affected_areas, alert_level, details, issued_at, source_url, external_id, auto)
     VALUES ('NDRRMC','daily_report',?,?,?,?,NOW(),NULL,?,1)
     ON DUPLICATE KEY UPDATE
       title = VALUES(title), alert_level = VALUES(alert_level),
       details = VALUES(details), affected_areas = VALUES(affected_areas), issued_at = NOW()`,
    [title, PLACE, worst, details, externalId]);

  return { externalId, level: worst, sections: sections.length };
}

module.exports = { refresh, startMonitor, fetchEarthquakes, buildDailyReport, cycloneSignal };
