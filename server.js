// Set the process timezone to Philippine Time (UTC+8) before anything else runs.
process.env.TZ = 'Asia/Manila';

require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const { Server } = require('socket.io');

const pool = require('./config/db');
const pushService = require('./src/services/pushService');
const floodMonitor = require('./src/services/floodMonitor');
const advisoryService = require('./src/services/advisoryService');
const realtimeService = require('./src/services/realtimeService');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// --- Session store in MySQL (survives restarts) ---
const sessionStore = new MySQLStore({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'mdas_db',
  createDatabaseTable: true,
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1000
});

const SESSION_SECRET = process.env.SESSION_SECRET || 'mdas-dev-secret';

app.use(session({
  key: 'mdas.sid',
  secret: SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Static frontend + uploaded photos
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '7d' }));

// --- API routes ---
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/users', require('./src/routes/users'));
app.use('/api/alerts', require('./src/routes/alerts'));
app.use('/api/incidents', require('./src/routes/incidents'));
app.use('/api/barangays', require('./src/routes/barangays'));
app.use('/api/evacuation', require('./src/routes/evacuation'));
app.use('/api/teams', require('./src/routes/teams'));
app.use('/api/weather', require('./src/routes/weather'));
app.use('/api/flood', require('./src/routes/flood'));
app.use('/api/contacts', require('./src/routes/contacts'));
app.use('/api/stats', require('./src/routes/stats'));
app.use('/api/reports', require('./src/routes/reports'));
app.use('/api/ai', require('./src/routes/ai'));
app.use('/api/resources', require('./src/routes/resources'));
app.use('/api/missing', require('./src/routes/missing'));
app.use('/api/logs', require('./src/routes/logs'));
app.use('/api/push', require('./src/routes/push'));
app.use('/api/settings', require('./src/routes/settings'));
app.use('/api/advisories', require('./src/routes/advisories'));
app.use('/api/location', require('./src/routes/location'));
app.use('/api/roads', require('./src/routes/roads'));
app.use('/api/officials', require('./src/routes/officials'));
app.use('/api/calls', require('./src/routes/calls'));

// Service worker must be served from the site root scope
app.get('/sw.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sw.js')));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, push_configured: pushService.isPushConfigured(), time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Database unavailable.' });
  }
});

// 404 for unknown API paths
app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));

// Central error handler
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // File-upload validation errors (bad type, too large) -> 400, not 500
  if (err && (err.statusCode === 400 || err.name === 'MulterError' || err.code === 'LIMIT_FILE_SIZE')) {
    return res.status(400).json({ error: err.message || 'File upload error.' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

async function start() {
  // Fail fast with a clear message if the DB is not reachable/initialized
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error('Cannot connect to MySQL. Start the MySQL server and run: npm run init-db');
    console.error('Details:', err.message);
    process.exit(1);
  }

  pushService.initPush();
  floodMonitor.startMonitor();
  advisoryService.startMonitor();

  const server = http.createServer(app);
  const io = new Server(server, {
    // Signaling payloads are tiny (SDP/ICE); defaults are fine. Same-origin only.
    maxHttpBufferSize: 1e6
  });
  realtimeService.init({ io, sessionStore, sessionSecret: SESSION_SECRET });
  realtimeService.attach(io);

  server.listen(PORT, () => {
    console.log(`Municipality Disaster Alert System running at http://localhost:${PORT}`);
    console.log('Real-time video-call signaling enabled (Socket.IO).');
  });
}

start();
