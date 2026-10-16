// Video-call support endpoints for the admin <-> responder WebRTC feature.
// Signaling itself runs over Socket.IO (see realtimeService); these REST routes
// provide the callable roster, ICE-server config, and an audit trail of calls.
const express = require('express');
const pool = require('../../config/db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const realtimeService = require('../services/realtimeService');

const router = express.Router();
const STAFF = ['admin', 'barangay_official', 'responder'];

// Public STUN works for most same-network / permissive-NAT cases. A TURN server
// is required to reliably traverse carrier-grade NAT on mobile networks; supply
// it via TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL in .env when available.
function iceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  const turnUrls = process.env.TURN_URLS; // comma-separated turn: host:port
  if (turnUrls && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({
      urls: turnUrls.split(',').map(u => u.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  return servers;
}

// Which staff are connected right now (so the UI can enable/disable call buttons).
router.get('/presence', requireRole(...STAFF), (req, res) => {
  const me = req.session.user.id;
  const online = realtimeService.getOnlineUsers().filter(u => u.id !== me);
  res.json({ online, turn_configured: Boolean(process.env.TURN_URLS) });
});

// ICE configuration handed to the browser before it opens a peer connection.
router.get('/config', requireRole(...STAFF), (req, res) => {
  res.json({ iceServers: iceServers() });
});

const EVENTS = {
  started: 'Video call started',
  answered: 'Video call connected',
  ended: 'Video call ended',
  missed: 'Video call missed (no answer)',
  declined: 'Video call declined',
  failed: 'Video call failed'
};

// Persist a call event on the incident timeline (non-destructive audit trail).
router.post('/log', requireRole(...STAFF), async (req, res) => {
  try {
    const { incident_id, peer_id, peer_name, event, duration_s } = req.body || {};
    const label = EVENTS[event];
    if (!label) return res.status(400).json({ error: 'Unknown call event.' });
    const dur = Number(duration_s);
    const durText = Number.isFinite(dur) && dur > 0 ? ` (${Math.round(dur)}s)` : '';
    const note = `${label} with ${peer_name || 'responder'}#${peer_id || '?'}${durText}`;

    if (incident_id) {
      await pool.query(
        'INSERT INTO incident_history (incident_id, status, changed_by, note) VALUES (?,?,?,?)',
        [incident_id, 'call', req.session.user.id, note]);
    }
    await logActivity(req, 'call.' + event, 'incident', incident_id || null, note);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to log call.' });
  }
});

module.exports = router;
