// Idempotent migration: blocked roads, barangay officials directory, and
// duplicate-report consolidation. Additive only - safe to run repeatedly and
// safe on the live production database.
//   - road_blockages      : impassable/blocked roads shown on the disaster map
//   - barangay_officials  : per-barangay officials + hotline numbers (resident view)
//   - incidents.primary_incident_id / is_duplicate : link duplicate reports to a
//     primary WITHOUT deleting them, so original evidence is always preserved.
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

async function indexExists(conn, table, indexName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, indexName]);
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

  // ---- road_blockages ----
  if (!(await tableExists(conn, 'road_blockages'))) {
    await conn.query(
      `CREATE TABLE road_blockages (
         id INT AUTO_INCREMENT PRIMARY KEY,
         road_name VARCHAR(200) NOT NULL,
         description TEXT NULL,
         barangay_id INT NULL,
         latitude DECIMAL(10,6) NULL,
         longitude DECIMAL(10,6) NULL,
         path TEXT NULL,
         status ENUM('blocked','partial','cleared') NOT NULL DEFAULT 'blocked',
         severity ENUM('low','moderate','high','critical') NOT NULL DEFAULT 'high',
         cause VARCHAR(60) NULL,
         reported_by INT NULL,
         cleared_at TIMESTAMP NULL,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         CONSTRAINT fk_road_block_barangay FOREIGN KEY (barangay_id)
           REFERENCES barangays(id) ON DELETE SET NULL,
         CONSTRAINT fk_road_block_reporter FOREIGN KEY (reported_by)
           REFERENCES users(id) ON DELETE SET NULL
       ) ENGINE=InnoDB`);
    console.log('  + created table road_blockages');
  } else {
    console.log('  = road_blockages already exists, skipping');
  }

  // ---- barangay_officials ----
  if (!(await tableExists(conn, 'barangay_officials'))) {
    await conn.query(
      `CREATE TABLE barangay_officials (
         id INT AUTO_INCREMENT PRIMARY KEY,
         barangay_id INT NOT NULL,
         name VARCHAR(160) NOT NULL,
         position VARCHAR(120) NULL,
         phone VARCHAR(30) NULL,
         is_active TINYINT(1) NOT NULL DEFAULT 1,
         sort_order INT NOT NULL DEFAULT 0,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         CONSTRAINT fk_brgy_officials_barangay FOREIGN KEY (barangay_id)
           REFERENCES barangays(id) ON DELETE CASCADE
       ) ENGINE=InnoDB`);
    await conn.query('CREATE INDEX idx_brgy_officials_barangay ON barangay_officials (barangay_id)');
    console.log('  + created table barangay_officials');
  } else {
    console.log('  = barangay_officials already exists, skipping');
  }

  // ---- duplicate-report consolidation columns on incidents ----
  if (!(await columnExists(conn, 'incidents', 'primary_incident_id'))) {
    await conn.query('ALTER TABLE incidents ADD COLUMN primary_incident_id INT NULL AFTER reporter_id');
    console.log('  + added incidents.primary_incident_id');
  } else {
    console.log('  = incidents.primary_incident_id already exists, skipping');
  }
  if (!(await columnExists(conn, 'incidents', 'is_duplicate'))) {
    await conn.query('ALTER TABLE incidents ADD COLUMN is_duplicate TINYINT(1) NOT NULL DEFAULT 0 AFTER primary_incident_id');
    console.log('  + added incidents.is_duplicate');
  } else {
    console.log('  = incidents.is_duplicate already exists, skipping');
  }
  if (!(await indexExists(conn, 'incidents', 'idx_incidents_primary'))) {
    await conn.query('CREATE INDEX idx_incidents_primary ON incidents (primary_incident_id)');
    console.log('  + added index idx_incidents_primary');
  }
  if (!(await fkExists(conn, 'incidents', 'fk_incidents_primary'))) {
    await conn.query(
      `ALTER TABLE incidents ADD CONSTRAINT fk_incidents_primary FOREIGN KEY (primary_incident_id)
       REFERENCES incidents(id) ON DELETE SET NULL`);
    console.log('  + added FK incidents.primary_incident_id -> incidents');
  }

  console.log('Features migration complete.');
  await conn.end();
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
