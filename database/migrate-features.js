// Idempotent migration for the "Features to Be Added" batch.
// Additive only - safe to re-run and safe on the live Aiven database (no data loss).
//   1. incidents: severity, verified_by, verified_at, auto_verified, resolved_at,
//      resolution_note, siren_acknowledged, siren_acknowledged_by
//   2. rescue_teams: specialty
//   3. team_dispatches: acknowledged_at, auto_assigned
//   4. official_advisories (new table)
//   5. system_settings (new table) + default rows
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

async function addColumn(conn, table, column, ddl) {
  if (await columnExists(conn, table, column)) {
    console.log(`  = ${table}.${column} exists, skipping`);
    return;
  }
  await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  console.log(`  + ${table}.${column}`);
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

  console.log('Migrating incidents...');
  await addColumn(conn, 'incidents', 'severity',
    "ENUM('low','moderate','high','critical') NOT NULL DEFAULT 'moderate' AFTER incident_type");
  await addColumn(conn, 'incidents', 'auto_verified',
    'TINYINT(1) NOT NULL DEFAULT 0 AFTER status');
  await addColumn(conn, 'incidents', 'verified_by',
    'INT NULL AFTER auto_verified');
  await addColumn(conn, 'incidents', 'verified_at',
    'TIMESTAMP NULL AFTER verified_by');
  await addColumn(conn, 'incidents', 'resolved_at',
    'TIMESTAMP NULL AFTER assigned_team_id');
  await addColumn(conn, 'incidents', 'resolution_note',
    'TEXT NULL AFTER resolved_at');
  await addColumn(conn, 'incidents', 'siren_acknowledged',
    'TINYINT(1) NOT NULL DEFAULT 0 AFTER resolution_note');
  await addColumn(conn, 'incidents', 'siren_acknowledged_by',
    'INT NULL AFTER siren_acknowledged');

  console.log('Migrating rescue_teams...');
  await addColumn(conn, 'rescue_teams', 'specialty',
    "VARCHAR(40) NULL AFTER phone");

  console.log('Migrating team_dispatches...');
  await addColumn(conn, 'team_dispatches', 'auto_assigned',
    'TINYINT(1) NOT NULL DEFAULT 0 AFTER dispatched_by');
  await addColumn(conn, 'team_dispatches', 'acknowledged_at',
    'TIMESTAMP NULL AFTER returned_at');

  console.log('Creating official_advisories...');
  await conn.query(`
    CREATE TABLE IF NOT EXISTS official_advisories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      agency ENUM('PAGASA','PHIVOLCS','NDRRMC','DENR','LGU','OTHER') NOT NULL DEFAULT 'OTHER',
      advisory_type VARCHAR(60) NOT NULL DEFAULT 'advisory',
      title VARCHAR(220) NOT NULL,
      affected_areas VARCHAR(255) NULL,
      alert_level VARCHAR(60) NULL,
      details TEXT NULL,
      issued_at DATETIME NULL,
      source_url VARCHAR(500) NULL,
      external_id VARCHAR(190) NULL,
      auto TINYINT(1) NOT NULL DEFAULT 0,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_advisory_external (external_id),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB`);

  console.log('Creating system_settings...');
  await conn.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      setting_key VARCHAR(64) PRIMARY KEY,
      setting_value TEXT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);

  // Seed default settings only if the table is empty (never overwrite live edits).
  const [[{ scnt }]] = await conn.query('SELECT COUNT(*) AS scnt FROM system_settings');
  if (scnt === 0) {
    console.log('Seeding default system settings...');
    const defaults = [
      ['system_name', 'Municipality Disaster Alert System'],
      ['short_name', 'MDAS'],
      ['municipality_name', 'Hinunangan, Southern Leyte'],
      ['logo_url', '/icons/icon-192.png'],
      ['theme_color', '#0b1c33'],
      ['contact_email', 'mdrrmo@hinunangan.gov.ph'],
      ['contact_phone', '(053) 000-0000'],
      ['hotline', '911'],
      ['address', 'Municipal Hall, Hinunangan, Southern Leyte'],
      ['footer_text', 'In life-threatening emergencies, always call the hotlines first.'],
      ['map_center_lat', '10.394278'],
      ['map_center_lng', '125.198427'],
      ['map_zoom', '13']
    ];
    for (const [k, v] of defaults) {
      await conn.query(
        'INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES (?,?)', [k, v]);
    }
  }

  console.log('Feature migration complete.');
  await conn.end();
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
