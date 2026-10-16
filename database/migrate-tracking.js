// Idempotent migration: real-time responder GPS tracking support.
//  - user_locations: latest known position per staff user (live GPS sharing)
//  - users.team_id : links a responder/official account to a rescue team so the
//    dispatched team's live position and ETA can be derived from its members
// Safe to run multiple times and safe on the live database (additive only).
process.env.TZ = 'Asia/Manila';
require('dotenv').config();
const mysql = require('mysql2/promise');

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]);
  return rows[0].n > 0;
}

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
  return rows[0].n > 0;
}

async function fkExists(conn, table, constraintName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
    [table, constraintName]);
  return rows[0].n > 0;
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'mdas_db',
    timezone: '+08:00'
  });
  await conn.query("SET time_zone = '+08:00'");

  if (!(await tableExists(conn, 'user_locations'))) {
    await conn.query(
      `CREATE TABLE user_locations (
         user_id INT NOT NULL PRIMARY KEY,
         latitude DECIMAL(10,7) NOT NULL,
         longitude DECIMAL(10,7) NOT NULL,
         accuracy_m DECIMAL(8,2) NULL,
         updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         CONSTRAINT fk_user_locations_user FOREIGN KEY (user_id)
           REFERENCES users(id) ON DELETE CASCADE
       ) ENGINE=InnoDB`);
    console.log('  + created table user_locations');
  } else {
    console.log('  = user_locations already exists, skipping');
  }

  if (!(await columnExists(conn, 'users', 'team_id'))) {
    await conn.query('ALTER TABLE users ADD COLUMN team_id INT NULL AFTER barangay_id');
    await conn.query('CREATE INDEX idx_users_team ON users (team_id)');
    console.log('  + added users.team_id');
    if (!(await fkExists(conn, 'users', 'fk_users_team'))) {
      await conn.query(
        `ALTER TABLE users ADD CONSTRAINT fk_users_team FOREIGN KEY (team_id)
         REFERENCES rescue_teams(id) ON DELETE SET NULL`);
      console.log('  + added FK users.team_id -> rescue_teams');
    }
  } else {
    console.log('  = users.team_id already exists, skipping');
  }

  console.log('Tracking migration complete.');
  await conn.end();
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
