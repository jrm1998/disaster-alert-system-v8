const cron = require('node-cron');
const pool = require('../../config/db');
const pushService = require('./pushService');

// Classifies a water level against sensor thresholds
function classifyReading(levelM, sensor) {
  const level = Number(levelM);
  if (level >= Number(sensor.critical_level_m)) return 'critical';
  if (level >= Number(sensor.alert_level_m)) return 'alert';
  return 'normal';
}

// Creates + dispatches an automatic flood warning alert for a sensor.
// Dedupes: at most one auto alert per sensor every 6 hours.
async function maybeAutoAlert(sensor, reading, status) {
  const [recent] = await pool.query(
    `SELECT id FROM alerts
     WHERE source = 'flood_auto' AND title LIKE ?
       AND created_at > DATE_SUB(NOW(), INTERVAL 6 HOUR) LIMIT 1`,
    [`%${sensor.name}%`]);
  if (recent.length) return null;

  const isCritical = status === 'critical';
  const [res] = await pool.query(
    `INSERT INTO alerts (title, message, alert_type, severity, status, target_type, source, approved_at, sent_at)
     VALUES (?,?,?,?,?,?,?,?,NOW())`,
    [
      `Automatic ${isCritical ? 'CRITICAL' : ''} Flood Warning - ${sensor.name}`,
      isCritical
        ? `Water level at ${sensor.name} has reached CRITICAL level (${reading} m, critical threshold ${sensor.critical_level_m} m). Residents in affected areas must evacuate to the nearest evacuation center immediately.`
        : `Water level at ${sensor.name} has reached ALERT level (${reading} m, alert threshold ${sensor.alert_level_m} m). Residents nearby should prepare for possible evacuation and monitor official advisories.`,
      'warning',
      isCritical ? 'critical' : 'warning',
      'sent',
      'barangay',
      'flood_auto',
      new Date()
    ]);
  const alertId = res.insertId;
  if (sensor.barangay_id) {
    await pool.query('INSERT INTO alert_barangays (alert_id, barangay_id) VALUES (?,?)', [alertId, sensor.barangay_id]);
  }
  const alert = { id: alertId, title: `Automatic Flood Warning - ${sensor.name}`, message: isCritical ? 'CRITICAL water level' : 'ALERT water level', severity: isCritical ? 'critical' : 'warning', target_type: 'barangay', geofence_lat: null, geofence_lng: null, geofence_radius_m: null };
  try {
    await pushService.dispatchAlert(alert);
  } catch (err) {
    console.error('[flood] auto alert dispatch failed:', err.message);
  }
  console.log(`[flood] Auto ${status} warning created for sensor "${sensor.name}" (${reading} m)`);
  return alertId;
}

// Records a water level reading (from IoT endpoint, manual entry, or simulation)
async function recordReading(sensorId, levelM) {
  const [sensors] = await pool.query('SELECT * FROM flood_sensors WHERE id = ? AND is_active = 1', [sensorId]);
  if (!sensors.length) throw new Error('Sensor not found or inactive');
  const sensor = sensors[0];
  const status = classifyReading(levelM, sensor);
  await pool.query(
    'INSERT INTO flood_readings (sensor_id, water_level_m, status) VALUES (?,?,?)',
    [sensorId, levelM, status]);
  if (status !== 'normal') {
    await maybeAutoAlert(sensor, levelM, status);
  }
  return { status, sensor };
}

// Background monitor: re-checks latest readings every 5 minutes so warnings
// are issued automatically even without new incoming readings.
async function checkAllSensors() {
  const [sensors] = await pool.query('SELECT * FROM flood_sensors WHERE is_active = 1');
  for (const sensor of sensors) {
    const [rows] = await pool.query(
      'SELECT water_level_m, status, recorded_at FROM flood_readings WHERE sensor_id = ? ORDER BY id DESC LIMIT 1',
      [sensor.id]);
    if (!rows.length) continue;
    const latest = rows[0];
    if (latest.status !== 'normal') {
      await maybeAutoAlert(sensor, latest.water_level_m, latest.status);
    }
  }
}

function startMonitor() {
  cron.schedule('*/5 * * * *', () => {
    checkAllSensors().catch(err => console.error('[flood] monitor error:', err.message));
  });
  console.log('[flood] Automatic flood monitor started (every 5 minutes).');
}

module.exports = { recordReading, classifyReading, checkAllSensors, startMonitor, maybeAutoAlert };
