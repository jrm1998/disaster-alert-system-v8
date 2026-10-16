// Real-time signaling for admin <-> responder video calls (WebRTC).
// Socket.IO handles only the signaling handshake (offer/answer/ICE) and presence;
// the actual audio/video media flows peer-to-peer between the two browsers.
//
// Auth: the browser already holds the express-session cookie (mdas.sid). We reuse
// it on the Socket.IO handshake by parsing the signed cookie and loading the row
// from the same MySQL session store, so only logged-in staff can signal.
const cookie = require('cookie');
const signature = require('cookie-signature');

const SESSION_COOKIE = 'mdas.sid';
const STAFF_ROLES = ['admin', 'barangay_official', 'responder'];

let io = null;
let sessionStore = null;
let sessionSecret = 'mdas-dev-secret';

// id -> { id, name, role, barangay_id, sockets:Set<socketId> }
const presence = new Map();

function init(opts) {
  io = opts.io;
  sessionStore = opts.sessionStore;
  sessionSecret = opts.sessionSecret || sessionSecret;
}

function loadSessionUser(socket) {
  return new Promise(resolve => {
    try {
      const raw = socket.handshake.headers && socket.handshake.headers.cookie;
      if (!raw) return resolve(null);
      const parsed = cookie.parse(raw);
      let val = parsed[SESSION_COOKIE];
      if (!val) return resolve(null);
      if (val.slice(0, 2) === 's:') {
        val = signature.unsign(val.slice(2), sessionSecret);
        if (val === false) return resolve(null);
      }
      sessionStore.get(val, (err, sess) => {
        if (err || !sess || !sess.user) return resolve(null);
        resolve(sess.user);
      });
    } catch {
      resolve(null);
    }
  });
}

function touchPresence(user, add, socketId) {
  if (add) {
    let p = presence.get(user.id);
    if (!p) {
      p = { id: user.id, name: user.name, role: user.role, barangay_id: user.barangay_id || null, sockets: new Set() };
      presence.set(user.id, p);
    }
    p.sockets.add(socketId);
  } else {
    const p = presence.get(user.id);
    if (p) {
      p.sockets.delete(socketId);
      if (!p.sockets.size) presence.delete(user.id);
    }
  }
}

function broadcastPresence() {
  if (!io) return;
  // Everyone online sees the callable staff roster (id/role only, no PII beyond name).
  io.to('staff').emit('presence:update', getOnlineUsers());
}

function getOnlineUsers() {
  return [...presence.values()].map(p => ({
    id: p.id, name: p.name, role: p.role, barangay_id: p.barangay_id
  }));
}

function isOnline(userId) {
  return presence.has(Number(userId));
}

function attach(socketIo) {
  io = socketIo;

  io.use(async (socket, next) => {
    const user = await loadSessionUser(socket);
    if (!user) return next(new Error('unauthorized'));
    if (!STAFF_ROLES.includes(user.role)) return next(new Error('forbidden'));
    socket.data.user = user;
    next();
  });

  io.on('connection', socket => {
    const user = socket.data.user;
    socket.join('user:' + user.id);
    socket.join('staff');
    touchPresence(user, true, socket.id);
    broadcastPresence();
    socket.emit('presence:you', { id: user.id, name: user.name, role: user.role });

    // Generic signaling relay. `to` is the target user id; both peers must be
    // staff. Nothing but the envelope crosses the server - media is peer-to-peer.
    socket.on('call:signal', ({ to, type, data, callId, incidentId } = {}) => {
      if (!to || !type) return;
      const target = presence.get(Number(to));
      if (!target) {
        // Let the caller know immediately if the peer is not connected.
        socket.emit('call:signal', { from: user.id, fromName: user.name, fromRole: user.role, type: 'unavailable', callId });
        return;
      }
      io.to('user:' + Number(to)).emit('call:signal', {
        from: user.id, fromName: user.name, fromRole: user.role,
        type, data, callId, incidentId
      });
    });

    socket.on('disconnect', () => {
      touchPresence(user, false, socket.id);
      // If this user just went fully offline, tell any in-call peer the call dropped.
      if (!presence.has(user.id)) {
        socket.to('staff').emit('call:peer-offline', { userId: user.id });
      }
      broadcastPresence();
    });
  });
}

module.exports = {
  init,
  attach,
  getOnlineUsers,
  isOnline
};
