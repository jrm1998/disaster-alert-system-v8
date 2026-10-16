// ---------- Admin <-> Responder video calls (WebRTC + Socket.IO signaling) ----------
// Media flows peer-to-peer between the two browsers; the server only relays the
// SDP offer/answer and ICE candidates and tracks who is online.
// Loaded on dashboard.html. Calls are staff-only (admin / barangay_official / responder).
const CALL_STAFF_ROLES = ['admin', 'barangay_official', 'responder'];

let rtcSocket = null;
let rtcReady = false;
let iceConfig = null;
let peerConn = null;
let localStream = null;
let remoteStream = null;
let ringTimer = null;
let callTimer = null;
let callSeconds = 0;
let currentCall = null; // { callId, peerId, peerName, incidentId, direction, state, offer }

function isCallStaff() {
  return currentUser && CALL_STAFF_ROLES.includes(currentUser.role);
}

function genCallId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Connect the signaling socket (idempotent). Safe to call on every dashboard load.
function initCallSocket() {
  if (!isCallStaff()) return;
  if (typeof io === 'undefined') { console.warn('[call] socket.io client not loaded'); return; }
  if (rtcSocket && rtcSocket.connected) return;
  if (rtcSocket) { try { rtcSocket.connect(); } catch {} return; }

  rtcSocket = io({ withCredentials: true, transports: ['websocket', 'polling'] });

  rtcSocket.on('connect', () => {
    rtcReady = true;
    document.querySelectorAll('[data-call-socket]').forEach(el => el.classList.remove('hidden'));
    refreshCallableRoster();
  });
  rtcSocket.on('connect_error', (err) => {
    rtcReady = false;
    if (err && /unauthorized|forbidden/i.test(err.message || '')) {
      // Not signed in as staff - stay quiet.
      try { rtcSocket.disconnect(); } catch {}
    }
  });
  rtcSocket.on('disconnect', () => { rtcReady = false; });

  rtcSocket.on('presence:you', (me) => { if (me && me.id) window.__myUserId = me.id; });
  rtcSocket.on('presence:update', (list) => { window.__onlineStaff = list || []; refreshCallableRoster(); });
  rtcSocket.on('call:peer-offline', ({ userId }) => {
    if (currentCall && Number(currentCall.peerId) === Number(userId) && currentCall.state !== 'ended') {
      toast('The other participant went offline.', 'error');
      teardownCall('failed');
    }
  });

  rtcSocket.on('call:signal', onCallSignal);
}

async function ensureIceConfig() {
  if (iceConfig) return iceConfig;
  try {
    const cfg = await api.get('/api/calls/config');
    iceConfig = { iceServers: (cfg && cfg.iceServers) || [{ urls: 'stun:stun.l.google.com:19302' }] };
  } catch {
    iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  }
  return iceConfig;
}

function onlineStaffList() { return window.__onlineStaff || []; }
function isStaffOnline(id) { return onlineStaffList().some(u => Number(u.id) === Number(id)); }

// Re-render any visible call buttons so offline responders are disabled.
function refreshCallableRoster() {
  document.querySelectorAll('[data-call-user]').forEach(btn => {
    const id = btn.getAttribute('data-call-user');
    const online = isStaffOnline(id);
    btn.disabled = !online || (currentCall && currentCall.state !== 'ended');
    btn.title = online ? 'Start a video call' : 'Responder is offline';
  });
}

// ---------- Signaling handler ----------
async function onCallSignal(msg) {
  if (!msg) return;
  const { type, from, fromName, callId, incidentId, data } = msg;

  // A brand-new incoming call.
  if (type === 'offer') {
    if (currentCall && currentCall.state !== 'ended') {
      emitSignal(from, 'busy', null, callId);
      return;
    }
    currentCall = { callId, peerId: from, peerName: fromName, incidentId, direction: 'incoming', state: 'ringing', offer: data };
    showIncomingModal();
    startRing();
    return;
  }

  if (!currentCall || currentCall.callId !== callId) return; // stale/unrelated

  if (type === 'answer') {
    try { await peerConn.setRemoteDescription(new RTCSessionDescription(data)); } catch (e) { console.warn('[call] setRemote answer', e); }
    setCallStatus('Connecting...');
  } else if (type === 'ice') {
    try { if (data) await peerConn.addIceCandidate(new RTCIceCandidate(data)); } catch (e) { console.warn('[call] addIce', e); }
  } else if (type === 'accept') {
    // Callee accepted; caller waits for the answer SDP next.
    setCallStatus('Connected to responder, negotiating...');
  } else if (type === 'decline') {
    toast(`${currentCall.peerName || 'Responder'} declined the call.`, 'info');
    teardownCall('declined');
  } else if (type === 'busy') {
    toast(`${currentCall.peerName || 'Responder'} is already on another call.`, 'info');
    teardownCall('failed');
  } else if (type === 'end') {
    toast('Call ended.', 'info');
    teardownCall('ended');
  } else if (type === 'unavailable') {
    toast('That responder is not connected right now.', 'error');
    teardownCall('missed');
  }
}

function emitSignal(to, type, data, callId) {
  if (!rtcSocket || !rtcSocket.connected) return;
  rtcSocket.emit('call:signal', {
    to, type, data,
    callId: callId || (currentCall && currentCall.callId),
    incidentId: currentCall && currentCall.incidentId
  });
}

// ---------- Peer connection plumbing ----------
async function getLocalMedia() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('This browser does not support camera access.');
  }
  return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
}

function createPeerConnection() {
  const pc = new RTCPeerConnection(iceConfig);
  pc.onicecandidate = (e) => {
    if (e.candidate) emitSignal(currentCall.peerId, 'ice', e.candidate.toJSON());
  };
  pc.ontrack = (e) => {
    remoteStream = e.streams[0];
    const rv = document.getElementById('call-remote-video');
    if (rv) { rv.srcObject = remoteStream; rv.play().catch(() => {}); }
  };
  pc.onconnectionstatechange = () => {
    if (!currentCall) return;
    if (pc.connectionState === 'connected') {
      if (currentCall.state !== 'connected') {
        currentCall.state = 'connected';
        setCallStatus('Connected');
        startCallTimer();
        logCall('answered');
      }
    } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      if (currentCall.state === 'connected') teardownCall('ended');
      else if (currentCall.state !== 'ended') teardownCall('failed');
    }
  };
  return pc;
}

// ---------- Caller flow ----------
async function startCall(peerId, peerName, incidentId) {
  if (currentCall && currentCall.state !== 'ended') return toast('You are already on a call.', 'error');
  if (!rtcReady) return toast('Real-time connection not ready. Refresh and try again.', 'error');
  if (!isStaffOnline(peerId)) return toast(`${peerName || 'That responder'} is offline right now.`, 'error');

  const callId = genCallId();
  currentCall = { callId, peerId: Number(peerId), peerName, incidentId, direction: 'outgoing', state: 'calling' };
  try {
    await ensureIceConfig();
    localStream = await getLocalMedia();
    openCallModal();
    setCallStatus(`Calling ${peerName || 'responder'}...`);
    attachLocal();
    startRing(); // ringing tone for the caller too

    peerConn = createPeerConnection();
    localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));
    const offer = await peerConn.createOffer();
    await peerConn.setLocalDescription(offer);
    emitSignal(currentCall.peerId, 'offer', peerConn.localDescription.toJSON(), callId);
    logCall('started');

    // Give up if nobody answers within 45s.
    currentCall.ringTimeout = setTimeout(() => {
      if (currentCall && currentCall.state === 'calling') {
        toast('No answer.', 'info');
        teardownCall('missed');
      }
    }, 45000);
  } catch (err) {
    toast('Could not start call: ' + err.message, 'error');
    teardownCall('failed');
  }
}

// ---------- Callee flow ----------
async function acceptCall() {
  if (!currentCall || currentCall.direction !== 'incoming') return;
  stopRing();
  closeIncomingModal();
  try {
    await ensureIceConfig();
    localStream = await getLocalMedia();
    openCallModal();
    setCallStatus('Connecting...');
    attachLocal();

    peerConn = createPeerConnection();
    localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));
    await peerConn.setRemoteDescription(new RTCSessionDescription(currentCall.offer));
    emitSignal(currentCall.peerId, 'accept');
    const answer = await peerConn.createAnswer();
    await peerConn.setLocalDescription(answer);
    emitSignal(currentCall.peerId, 'answer', peerConn.localDescription.toJSON());
    currentCall.state = 'connecting';
  } catch (err) {
    toast('Could not accept call: ' + err.message, 'error');
    teardownCall('failed');
  }
}

function declineCall() {
  if (!currentCall) return;
  stopRing();
  emitSignal(currentCall.peerId, 'decline');
  closeIncomingModal();
  teardownCall(null); // callee declining is not logged as an incident event on their side
}

// ---------- Teardown / logging ----------
function teardownCall(logEvent) {
  stopRing();
  if (callTimer) { clearInterval(callTimer); callTimer = null; }
  if (currentCall && currentCall.ringTimeout) { clearTimeout(currentCall.ringTimeout); currentCall.ringTimeout = null; }

  if (logEvent && currentCall) logCall(logEvent);

  try { if (peerConn) peerConn.close(); } catch {}
  peerConn = null;
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  remoteStream = null;

  const rv = document.getElementById('call-remote-video');
  const lv = document.getElementById('call-local-video');
  if (rv) rv.srcObject = null;
  if (lv) lv.srcObject = null;

  callSeconds = 0;
  const timer = document.getElementById('call-timer');
  if (timer) timer.textContent = '';

  // Tell the peer the call is over (unless we're reacting to their 'end').
  if (currentCall && logEvent !== 'ended' && currentCall.state !== 'ended' && rtcSocket && rtcSocket.connected) {
    emitSignal(currentCall.peerId, 'end', null, currentCall.callId);
  }
  if (currentCall) currentCall.state = 'ended';
  currentCall = null;
  closeCallModal();
  closeIncomingModal();
  refreshCallableRoster();
}

function endCall() {
  if (!currentCall) return;
  const wasConnected = currentCall.state === 'connected';
  teardownCall(wasConnected ? 'ended' : (currentCall.direction === 'outgoing' ? 'missed' : 'ended'));
}

function logCall(event) {
  if (!currentCall) return;
  const dur = event === 'answered' ? 0 : callSeconds;
  api.post('/api/calls/log', {
    incident_id: currentCall.incidentId || null,
    peer_id: currentCall.peerId,
    peer_name: currentCall.peerName || 'responder',
    event,
    duration_s: dur
  }).catch(() => {});
}

// ---------- Modal + media UI helpers ----------
function attachLocal() {
  const lv = document.getElementById('call-local-video');
  if (lv) { lv.srcObject = localStream; lv.play().catch(() => {}); }
}

function setCallStatus(text) {
  const el = document.getElementById('call-status');
  if (el) el.textContent = text;
  const peer = document.getElementById('call-peer');
  if (peer && currentCall) peer.textContent = currentCall.peerName || 'Responder';
}

function startCallTimer() {
  callSeconds = 0;
  const timer = document.getElementById('call-timer');
  if (timer) timer.textContent = '00:00';
  if (callTimer) clearInterval(callTimer);
  callTimer = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    if (timer) timer.textContent = `${m}:${s}`;
  }, 1000);
}

function openCallModal() { document.getElementById('call-modal').classList.add('open'); }
function closeCallModal() { document.getElementById('call-modal').classList.remove('open'); }
function showIncomingModal() {
  const name = document.getElementById('incoming-call-name');
  const ctx = document.getElementById('incoming-call-context');
  if (name) name.textContent = currentCall.peerName || 'Control room';
  if (ctx) ctx.textContent = currentCall.incidentId ? `Incident #${currentCall.incidentId}` : 'Incoming video call';
  document.getElementById('incoming-call-modal').classList.add('open');
}
function closeIncomingModal() {
  const m = document.getElementById('incoming-call-modal');
  if (m) m.classList.remove('open');
}

function toggleMute(btn) {
  if (!localStream) return;
  const tracks = localStream.getAudioTracks();
  const on = tracks.length && tracks[0].enabled;
  tracks.forEach(t => t.enabled = !on);
  if (btn) { btn.textContent = on ? '🔇 Unmute' : '🎙 Mute'; btn.classList.toggle('active', on); }
}
function toggleCamera(btn) {
  if (!localStream) return;
  const tracks = localStream.getVideoTracks();
  const on = tracks.length && tracks[0].enabled;
  tracks.forEach(t => t.enabled = !on);
  if (btn) { btn.textContent = on ? '📷 Camera off' : '📹 Camera on'; btn.classList.toggle('active', on); }
}

// Distinct looping ringtone for an incoming call (reuses the siren synth).
function startRing() {
  stopRing();
  const beep = () => { try { playAlarm('warning'); vibrateDevice('warning'); } catch {} };
  beep();
  ringTimer = setInterval(beep, 3000);
}
function stopRing() { if (ringTimer) { clearInterval(ringTimer); ringTimer = null; } }

// Expose handlers for inline onclick attributes in the dashboard.
window.startCall = startCall;
window.acceptCall = acceptCall;
window.declineCall = declineCall;
window.endCall = endCall;
window.toggleMute = toggleMute;
window.toggleCamera = toggleCamera;
window.refreshCallableRoster = refreshCallableRoster;

// Boot the socket once we know who is logged in (common.js loads currentUser).
document.addEventListener('DOMContentLoaded', () => {
  // currentUser is populated asynchronously; wait briefly then init.
  const tryInit = (tries) => {
    if (isCallStaff()) { initCallSocket(); return; }
    if (tries > 0) setTimeout(() => tryInit(tries - 1), 500);
  };
  setTimeout(() => tryInit(8), 300);
});
