const pool = require('../../config/db');

// Records a system activity log entry. Never throws - logging failures
// must not break the request that triggered them.
async function logActivity(req, action, entityType, entityId, details) {
  try {
    const user = req && req.session && req.session.user;
    await pool.query(
      `INSERT INTO activity_logs (user_id, user_name, action, entity_type, entity_id, details, ip_address)
       VALUES (?,?,?,?,?,?,?)`,
      [
        user ? user.id : null,
        user ? user.name : 'anonymous',
        action,
        entityType || null,
        entityId || null,
        details ? String(details).slice(0, 2000) : null,
        req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().slice(0, 45) : null
      ]
    );
  } catch (err) {
    console.error('Activity log failed:', err.message);
  }
}

module.exports = { logActivity };
