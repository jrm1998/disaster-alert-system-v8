// Idempotent migration: adds per-hazard risk fields to the barangays table.
// Safe to run multiple times and safe on the live database (no data loss).
process.env.TZ = 'Asia/Manila';
require('dotenv').config();
const mysql = require('mysql2/promise');

const NEW_COLS = [
  'flood_risk',
  'landslide_risk',
  'storm_surge_risk',
  'earthquake_risk',
  'overall_risk'
];

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]);
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

  for (const col of NEW_COLS) {
    if (await columnExists(conn, 'barangays', col)) {
      console.log(`  = ${col} already exists, skipping`);
      continue;
    }
    // overall_risk seeds from the existing risk_level; hazard fields start at 'low'.
    const def = col === 'overall_risk' ? 'low' : 'low';
    await conn.query(
      `ALTER TABLE barangays ADD COLUMN ${col} ENUM('low','moderate','high','critical') NOT NULL DEFAULT '${def}' AFTER risk_level`);
    console.log(`  + added ${col}`);
  }

  // Seed sensible initial values from the current overall risk_level so the
  // breakdown is not misleadingly empty on first run.
  await conn.query(
    `UPDATE barangays SET
       overall_risk = risk_level,
       flood_risk = risk_level,
       landslide_risk = risk_level,
       storm_surge_risk = risk_level,
       earthquake_risk = risk_level
     WHERE overall_risk = 'low' AND risk_level <> 'low'`);

  // Keep the legacy risk_level column in sync with overall_risk.
  await conn.query('UPDATE barangays SET risk_level = overall_risk');

  console.log('Risk-field migration complete.');
  await conn.end();
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
