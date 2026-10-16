const webpush = require('web-push');
const pool = require('../../config/db');

let pushConfigured = false;

function initPush() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (pub && priv) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@mdas.local', pub, priv);
    pushConfigured = true;
  } else {
    console.warn('[push] VAPID keys not set - background push notifications disabled. Run: npm run generate-vapid');
  }
}

function isPushConfigured() {
  return pushConfigured;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Geofencing: barangays whose center point falls within the danger radius
async function getBarangaysInRadius(lat, lng, radiusM) {
  const [rows] = await pool.query(
    'SELECT id, name, latitude, longitude FROM barangays WHERE latitude IS NOT NULL');
  return rows
    .filter(b => haversineMeters(lat, lng, Number(b.latitude), Number(b.longitude)) <= radiusM)
    .map(b => ({ id: b.id, name: b.name }));
}

// Resolves which barangay IDs an alert targets (used for push + notifications)
async function resolveAlertTargets(alert) {
  if (alert.target_type === 'all') {
    const [rows] = await pool.query('SELECT id FROM barangays');
    return { barangayIds: rows.map(r => r.id), scope: 'all' };
  }
  if (alert.target_type === 'geofence' && alert.geofence_lat != null) {
    const bs = await getBarangaysInRadius(
      Number(alert.geofence_lat), Number(alert.geofence_lng), alert.geofence_radius_m || 1000);
    return { barangayIds: bs.map(b => b.id), scope: 'geofence' };
  }
  const [rows] = await pool.query('SELECT barangay_id FROM alert_barangays WHERE alert_id = ?', [alert.id]);
  return { barangayIds: rows.map(r => r.barangay_id), scope: 'barangay' };
}

async function saveSubscription(userId, sub) {
  const keys = sub.keys || {};
  if (!sub.endpoint || !keys.p256dh || !keys.auth) {
    throw new Error('Invalid push subscription payload');
  }
  // Replace any existing row with the same endpoint (user may re-subscribe)
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key)
     VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh_key = VALUES(p256dh_key), auth_key = VALUES(auth_key)`,
    [userId || null, sub.endpoint, keys.p256dh, keys.auth]
  );
}

async function removeSubscription(endpoint) {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
}

async function sendPushToSubscription(row, payload) {
  const sub = {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh_key, auth: row.auth_key }
  };
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      await removeSubscription(row.endpoint); // subscription expired
    } else {
      console.error('[push] send failed:', err.message);
    }
  }
}

// Sends an approved alert: writes in-app notifications + background web pushes.
// Works even when the website is closed (service worker push events).
async function dispatchAlert(alert) {
  const { barangayIds, scope } = await resolveAlertTargets(alert);
  const payload = {
    title: `[${alert.severity.toUpperCase()}] ${alert.title}`,
    body: alert.message.length > 180 ? alert.message.slice(0, 177) + '...' : alert.message,
    url: '/',
    severity: alert.severity,
    alertId: alert.id
  };

  // In-app notification rows
  if (scope === 'all') {
    await pool.query(
      'INSERT INTO notifications (title, body, link) VALUES (?,?,?)',
      [payload.title, alert.message, payload.url]);
  } else {
    for (const bid of barangayIds) {
      await pool.query(
        'INSERT INTO notifications (barangay_id, title, body, link) VALUES (?,?,?,?)',
        [bid, payload.title, alert.message, payload.url]);
    }
  }

  if (!pushConfigured) return { pushed: 0, barangayCount: barangayIds.length };

  // Choose push recipients: users in affected barangays (or everyone for
  // municipality-wide alerts) plus anonymous visitors who subscribed.
  let subs;
  if (scope === 'all' || barangayIds.length === 0) {
    [subs] = await pool.query('SELECT * FROM push_subscriptions');
  } else {
    const placeholders = barangayIds.map(() => '?').join(',');
    [subs] = await pool.query(
      `SELECT ps.* FROM push_subscriptions ps
       LEFT JOIN users u ON u.id = ps.user_id
       WHERE ps.user_id IS NULL OR u.barangay_id IN (${placeholders})`,
      barangayIds
    );
  }
  await Promise.all(subs.map(s => sendPushToSubscription(s, payload)));
  return { pushed: subs.length, barangayCount: barangayIds.length };
}

module.exports = {
  initPush,
  isPushConfigured,
  saveSubscription,
  removeSubscription,
  sendToSubscription: sendPushToSubscription,
  dispatchAlert,
  resolveAlertTargets,
  getBarangaysInRadius,
  haversineMeters
};
