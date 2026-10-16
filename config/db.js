const mysql = require('mysql2/promise');
require('dotenv').config();

// Force Philippine Time (UTC+8) for all JS Date handling in this process.
process.env.TZ = 'Asia/Manila';

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'mdas_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
  // Use a numeric offset: XAMPP/MariaDB has no timezone tables loaded,
  // so a named zone like 'Asia/Manila' would be rejected by SET time_zone.
  timezone: '+08:00'
});

// Apply the session timezone on every new connection so TIMESTAMP columns
// (CURRENT_TIMESTAMP defaults, NOW()) resolve in UTC+8.
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+08:00'");
});

module.exports = pool;
