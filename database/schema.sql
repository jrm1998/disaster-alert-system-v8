-- Municipality Disaster Alert System (MDAS) schema
CREATE DATABASE IF NOT EXISTS mdas_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE mdas_db;

CREATE TABLE IF NOT EXISTS barangays (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  risk_level ENUM('low','moderate','high','critical') NOT NULL DEFAULT 'low',
  flood_risk ENUM('low','moderate','high','critical') NOT NULL DEFAULT 'low',
  landslide_risk ENUM('low','moderate','high','critical') NOT NULL DEFAULT 'low',
  storm_surge_risk ENUM('low','moderate','high','critical') NOT NULL DEFAULT 'low',
  earthquake_risk ENUM('low','moderate','high','critical') NOT NULL DEFAULT 'low',
  overall_risk ENUM('low','moderate','high','critical') NOT NULL DEFAULT 'low',
  latitude DECIMAL(10,6) NULL,
  longitude DECIMAL(10,6) NULL,
  population INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('resident','responder','barangay_official','admin') NOT NULL DEFAULT 'resident',
  barangay_id INT NULL,
  team_id INT NULL,
  phone VARCHAR(30) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (barangay_id) REFERENCES barangays(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS alerts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  alert_type ENUM('warning','advisory','evacuation','all_clear','information') NOT NULL DEFAULT 'warning',
  severity ENUM('info','warning','critical') NOT NULL DEFAULT 'info',
  status ENUM('draft','pending_approval','approved','sent','cancelled') NOT NULL DEFAULT 'draft',
  target_type ENUM('all','barangay','geofence') NOT NULL DEFAULT 'all',
  geofence_lat DECIMAL(10,6) NULL,
  geofence_lng DECIMAL(10,6) NULL,
  geofence_radius_m INT NULL,
  source ENUM('manual','ai_import','flood_auto') NOT NULL DEFAULT 'manual',
  created_by INT NULL,
  approved_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  approved_at TIMESTAMP NULL,
  sent_at TIMESTAMP NULL,
  expires_at TIMESTAMP NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS alert_barangays (
  alert_id INT NOT NULL,
  barangay_id INT NOT NULL,
  PRIMARY KEY (alert_id, barangay_id),
  FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
  FOREIGN KEY (barangay_id) REFERENCES barangays(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  endpoint VARCHAR(512) NOT NULL UNIQUE,
  p256dh_key VARCHAR(255) NOT NULL,
  auth_key VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  barangay_id INT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  link VARCHAR(255) NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (barangay_id) REFERENCES barangays(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incidents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reporter_id INT NULL,
  incident_type ENUM('fire','flood','landslide','medical','accident','storm_damage','earthquake','other') NOT NULL DEFAULT 'other',
  severity ENUM('low','moderate','high','critical') NOT NULL DEFAULT 'moderate',
  description TEXT NOT NULL,
  latitude DECIMAL(10,6) NULL,
  longitude DECIMAL(10,6) NULL,
  address VARCHAR(255) NULL,
  photo_path VARCHAR(255) NULL,
  barangay_id INT NULL,
  status ENUM('reported','verified','responding','resolved') NOT NULL DEFAULT 'reported',
  auto_verified TINYINT(1) NOT NULL DEFAULT 0,
  verified_by INT NULL,
  verified_at TIMESTAMP NULL,
  assigned_team_id INT NULL,
  resolved_at TIMESTAMP NULL,
  resolution_note TEXT NULL,
  siren_acknowledged TINYINT(1) NOT NULL DEFAULT 0,
  siren_acknowledged_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (barangay_id) REFERENCES barangays(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incident_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  incident_id INT NOT NULL,
  status VARCHAR(30) NOT NULL,
  changed_by INT NULL,
  note TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
  FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS evacuation_centers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  barangay_id INT NULL,
  address VARCHAR(255) NULL,
  latitude DECIMAL(10,6) NULL,
  longitude DECIMAL(10,6) NULL,
  capacity INT NOT NULL DEFAULT 0,
  occupants INT NOT NULL DEFAULT 0,
  status ENUM('standby','open','full','closed') NOT NULL DEFAULT 'standby',
  contact_phone VARCHAR(30) NULL,
  notes TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (barangay_id) REFERENCES barangays(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rescue_teams (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  leader_name VARCHAR(120) NOT NULL,
  member_count INT NOT NULL DEFAULT 1,
  phone VARCHAR(30) NULL,
  specialty VARCHAR(40) NULL,
  status ENUM('available','dispatched','on_mission','off_duty') NOT NULL DEFAULT 'available',
  base_latitude DECIMAL(10,6) NULL,
  base_longitude DECIMAL(10,6) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS team_dispatches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  team_id INT NOT NULL,
  incident_id INT NOT NULL,
  dispatched_by INT NULL,
  auto_assigned TINYINT(1) NOT NULL DEFAULT 0,
  dispatched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  returned_at TIMESTAMP NULL,
  acknowledged_at TIMESTAMP NULL,
  FOREIGN KEY (team_id) REFERENCES rescue_teams(id) ON DELETE CASCADE,
  FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
  FOREIGN KEY (dispatched_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS flood_sensors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  barangay_id INT NULL,
  latitude DECIMAL(10,6) NULL,
  longitude DECIMAL(10,6) NULL,
  alert_level_m DECIMAL(6,2) NOT NULL DEFAULT 3.00,
  critical_level_m DECIMAL(6,2) NOT NULL DEFAULT 5.00,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  FOREIGN KEY (barangay_id) REFERENCES barangays(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS flood_readings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sensor_id INT NOT NULL,
  water_level_m DECIMAL(6,2) NOT NULL,
  status ENUM('normal','alert','critical') NOT NULL DEFAULT 'normal',
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sensor_id) REFERENCES flood_sensors(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS weather_cache (
  id INT AUTO_INCREMENT PRIMARY KEY,
  data LONGTEXT NOT NULL,
  fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS emergency_contacts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  category ENUM('police','fire','ambulance','mdrrmo','hospital','barangay','other') NOT NULL DEFAULT 'other',
  phone VARCHAR(30) NOT NULL,
  address VARCHAR(255) NULL,
  sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS resources (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  category ENUM('food','water','medicine','equipment','bedding','hygiene','other') NOT NULL DEFAULT 'other',
  quantity DECIMAL(12,2) NOT NULL DEFAULT 0,
  unit VARCHAR(30) NOT NULL DEFAULT 'pcs',
  minimum_level DECIMAL(12,2) NOT NULL DEFAULT 0,
  storage_location VARCHAR(160) NULL,
  evacuation_center_id INT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (evacuation_center_id) REFERENCES evacuation_centers(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS missing_persons (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reported_by INT NULL,
  full_name VARCHAR(160) NOT NULL,
  age INT NULL,
  gender ENUM('male','female','other','unknown') NOT NULL DEFAULT 'unknown',
  last_seen VARCHAR(255) NULL,
  barangay_id INT NULL,
  description TEXT NULL,
  photo_path VARCHAR(255) NULL,
  contact_name VARCHAR(120) NULL,
  contact_phone VARCHAR(30) NULL,
  status ENUM('missing','found') NOT NULL DEFAULT 'missing',
  found_date TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reported_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (barangay_id) REFERENCES barangays(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS activity_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  user_name VARCHAR(120) NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(60) NULL,
  entity_id INT NULL,
  details TEXT NULL,
  ip_address VARCHAR(45) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ai_knowledge (
  id INT AUTO_INCREMENT PRIMARY KEY,
  topic VARCHAR(120) NOT NULL,
  keywords VARCHAR(500) NOT NULL,
  answer TEXT NOT NULL,
  category VARCHAR(60) NOT NULL DEFAULT 'general'
) ENGINE=InnoDB;

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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key VARCHAR(64) PRIMARY KEY,
  setting_value TEXT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Latest known GPS position per staff user (real-time responder tracking / ETA).
CREATE TABLE IF NOT EXISTS user_locations (
  user_id INT NOT NULL PRIMARY KEY,
  latitude DECIMAL(10,7) NOT NULL,
  longitude DECIMAL(10,7) NOT NULL,
  accuracy_m DECIMAL(8,2) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Index for users.team_id (FK added by database/migrate-tracking.js on live DBs).
CREATE INDEX idx_users_team ON users (team_id);

-- Blocked / impassable roads shown on the interactive disaster map.
CREATE TABLE IF NOT EXISTS road_blockages (
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
  FOREIGN KEY (barangay_id) REFERENCES barangays(id) ON DELETE SET NULL,
  FOREIGN KEY (reported_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Per-barangay officials directory with hotline numbers (resident view).
CREATE TABLE IF NOT EXISTS barangay_officials (
  id INT AUTO_INCREMENT PRIMARY KEY,
  barangay_id INT NOT NULL,
  name VARCHAR(160) NOT NULL,
  position VARCHAR(120) NULL,
  phone VARCHAR(30) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (barangay_id) REFERENCES barangays(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX idx_brgy_officials_barangay ON barangay_officials (barangay_id);

-- Duplicate-report consolidation: a duplicate links to its primary incident but is
-- never deleted, so the original evidence is always preserved.
ALTER TABLE incidents ADD COLUMN primary_incident_id INT NULL AFTER reporter_id;
ALTER TABLE incidents ADD COLUMN is_duplicate TINYINT(1) NOT NULL DEFAULT 0 AFTER primary_incident_id;
CREATE INDEX idx_incidents_primary ON incidents (primary_incident_id);
ALTER TABLE incidents ADD CONSTRAINT fk_incidents_primary FOREIGN KEY (primary_incident_id)
  REFERENCES incidents(id) ON DELETE SET NULL;
