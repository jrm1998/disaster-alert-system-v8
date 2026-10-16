// Initializes the database: runs schema.sql then seeds baseline data.
// Safe to re-run: uses INSERT IGNORE / conditional inserts.
// Set the process timezone to Philippine Time (UTC+8) before anything else runs.
process.env.TZ = 'Asia/Manila';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
    timezone: '+08:00'
  });

  // Numeric offset only: XAMPP/MariaDB has no timezone tables loaded.
  await conn.query("SET time_zone = '+08:00'");

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('Creating database and tables...');
  await conn.query(schema);
  await conn.query(`USE \`${process.env.DB_NAME || 'mdas_db'}\``);

  // --- Barangays ---
  const [[{ cnt }]] = await conn.query('SELECT COUNT(*) AS cnt FROM barangays');
  if (cnt === 0) {
    console.log('Seeding barangays...');
    const barangays = [
      ['Poblacion', 'moderate', 17.5079, 120.7598, 8200],
      ['San Rafael', 'high', 17.5310, 120.7420, 4100],
      ['Santa Lucia', 'critical', 17.4890, 120.7810, 3600],
      ['Tamag', 'moderate', 17.5210, 120.7730, 2900],
      ['Baliw', 'low', 17.4700, 120.7350, 2400],
      ['Calaoaan', 'high', 17.5480, 120.7610, 3100],
      ['Padang', 'low', 17.4620, 120.7700, 1800],
      ['Bantay', 'moderate', 17.5400, 120.7900, 2700],
      ['Lubing', 'high', 17.4950, 120.7200, 2200],
      ['Casilagan', 'low', 17.5150, 120.7050, 1500],
      ['Sabangan', 'critical', 17.4800, 120.7950, 3300],
      ['Damacuag', 'moderate', 17.5550, 120.7350, 1900]
    ];
    for (const b of barangays) {
      // Seed every hazard field from the overall risk_level as a starting point.
      const [name, risk, lat, lng, pop] = b;
      await conn.query(
        `INSERT INTO barangays (name, risk_level, flood_risk, landslide_risk, storm_surge_risk, earthquake_risk, overall_risk, latitude, longitude, population)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [name, risk, risk, risk, risk, risk, risk, lat, lng, pop]);
    }
  }

  // --- Users (admin + one of each role) ---
  const [[{ ucnt }]] = await conn.query('SELECT COUNT(*) AS ucnt FROM users');
  if (ucnt === 0) {
    console.log('Seeding users...');
    const users = [
      ['MDAS Administrator', 'admin@mdas.local', 'Admin@123', 'admin', 1, '0917-000-0001'],
      ['Juan Dela Cruz', 'official@mdas.local', 'Official@123', 'barangay_official', 3, '0917-000-0002'],
      ['Pedro Santos', 'responder@mdas.local', 'Responder@123', 'responder', 2, '0917-000-0003'],
      ['Maria Reyes', 'resident@mdas.local', 'Resident@123', 'resident', 1, '0917-000-0004']
    ];
    for (const [name, email, pass, role, barangay_id, phone] of users) {
      const hash = await bcrypt.hash(pass, 10);
      await conn.query(
        'INSERT INTO users (name, email, password_hash, role, barangay_id, phone) VALUES (?,?,?,?,?,?)',
        [name, email, hash, role, barangay_id, phone]);
    }
  }

  // --- Evacuation centers ---
  const [[{ ecnt }]] = await conn.query('SELECT COUNT(*) AS ecnt FROM evacuation_centers');
  if (ecnt === 0) {
    console.log('Seeding evacuation centers...');
    const centers = [
      ['Poblacion Covered Court', 1, 'Rizal St., Poblacion', 17.5085, 120.7601, 300, 0, 'standby', '0917-111-0001'],
      ['Santa Lucia Elementary School', 3, 'School Rd., Santa Lucia', 17.4895, 120.7815, 450, 0, 'standby', '0917-111-0002'],
      ['San Rafael Parish Hall', 2, 'Church Compound, San Rafael', 17.5315, 120.7425, 200, 0, 'standby', '0917-111-0003'],
      ['Sabangan Gymnasium', 11, 'Brgy. Road, Sabangan', 17.4805, 120.7955, 350, 0, 'standby', '0917-111-0004']
    ];
    for (const c of centers) {
      await conn.query(
        'INSERT INTO evacuation_centers (name, barangay_id, address, latitude, longitude, capacity, occupants, status, contact_phone) VALUES (?,?,?,?,?,?,?,?,?)', c);
    }
  }

  // --- Rescue teams ---
  const [[{ tcnt }]] = await conn.query('SELECT COUNT(*) AS tcnt FROM rescue_teams');
  if (tcnt === 0) {
    console.log('Seeding rescue teams...');
    const teams = [
      ['MDAS Rescue Team Alpha', 'Carlo Mendoza', 12, '0917-222-0001', 'rescue', 'available', 17.5080, 120.7600],
      ['MDAS Rescue Team Bravo', 'Ana Villanueva', 10, '0917-222-0002', 'rescue', 'available', 17.5310, 120.7420],
      ['BFP Fire Response Unit', 'Insp. Ramon Cruz', 8, '0917-222-0003', 'fire', 'available', 17.5090, 120.7590],
      ['Medical Response Team', 'Dr. Liza Fajardo', 6, '0917-222-0004', 'medical', 'available', 17.5075, 120.7605]
    ];
    for (const t of teams) {
      await conn.query(
        'INSERT INTO rescue_teams (name, leader_name, member_count, phone, specialty, status, base_latitude, base_longitude) VALUES (?,?,?,?,?,?,?,?)', t);
    }
    // Link the seeded responder account to Rescue Team Alpha for live tracking/ETA.
    await conn.query(
      `UPDATE users SET team_id = (SELECT id FROM rescue_teams WHERE name = 'MDAS Rescue Team Alpha' LIMIT 1)
       WHERE email = 'responder@mdas.local' AND team_id IS NULL`);
  }

  // --- Flood sensors ---
  const [[{ scnt }]] = await conn.query('SELECT COUNT(*) AS scnt FROM flood_sensors');
  if (scnt === 0) {
    console.log('Seeding flood sensors...');
    const sensors = [
      ['Santa Lucia River Gauge', 3, 17.4880, 120.7800, 3.0, 5.0],
      ['Sabangan Creek Gauge', 11, 17.4790, 120.7940, 2.5, 4.0],
      ['Calaoaan River Gauge', 6, 17.5470, 120.7600, 3.5, 5.5],
      ['Lubing Bridge Gauge', 9, 17.4940, 120.7210, 3.0, 4.5]
    ];
    for (const s of sensors) {
      await conn.query(
        'INSERT INTO flood_sensors (name, barangay_id, latitude, longitude, alert_level_m, critical_level_m) VALUES (?,?,?,?,?,?)', s);
    }
  }

  // --- Emergency contacts ---
  const [[{ ccnt }]] = await conn.query('SELECT COUNT(*) AS ccnt FROM emergency_contacts');
  if (ccnt === 0) {
    console.log('Seeding emergency contacts...');
    const contacts = [
      ['Municipal Police Station', 'police', '117', 'Poblacion', 1],
      ['Bureau of Fire Protection', 'fire', '(077) 555-0117', 'Poblacion', 2],
      ['Municipal Ambulance', 'ambulance', '143', 'Municipal Hall', 3],
      ['MDRRMO Hotline', 'mdrrmo', '(077) 555-0100', 'MDRRMO Office', 4],
      ['Rural Health Unit', 'hospital', '(077) 555-0233', 'Poblacion', 5],
      ['Provincial Hospital', 'hospital', '(077) 555-0400', 'Provincial Road', 6],
      ['Red Cross Chapter', 'other', '143', 'Chapter Office', 7]
    ];
    for (const c of contacts) {
      await conn.query(
        'INSERT INTO emergency_contacts (name, category, phone, address, sort_order) VALUES (?,?,?,?,?)', c);
    }
  }

  // --- Resources ---
  const [[{ rcnt }]] = await conn.query('SELECT COUNT(*) AS rcnt FROM resources');
  if (rcnt === 0) {
    console.log('Seeding resources...');
    const resources = [
      ['Rice Sacks (50kg)', 'food', 120, 'sacks', 30, 'MDRRMO Warehouse', null],
      ['Canned Goods', 'food', 500, 'cans', 150, 'MDRRMO Warehouse', null],
      ['Bottled Water', 'water', 800, 'bottles', 200, 'MDRRMO Warehouse', null],
      ['Medicine Kits', 'medicine', 60, 'kits', 20, 'RHU Storage', null],
      ['Rescue Ropes', 'equipment', 25, 'sets', 10, 'Rescue Base', null],
      ['Life Vests', 'equipment', 40, 'pcs', 15, 'Rescue Base', null],
      ['Rubber Boats', 'equipment', 4, 'units', 2, 'Rescue Base', null],
      ['Sleeping Mats', 'bedding', 200, 'pcs', 50, 'MDRRMO Warehouse', null],
      ['Hygiene Kits', 'hygiene', 150, 'kits', 50, 'MDRRMO Warehouse', null],
      ['Generator Sets', 'equipment', 3, 'units', 1, 'Rescue Base', null]
    ];
    for (const r of resources) {
      await conn.query(
        'INSERT INTO resources (name, category, quantity, unit, minimum_level, storage_location, evacuation_center_id) VALUES (?,?,?,?,?,?,?)', r);
    }
  }

  // --- AI knowledge base ---
  const [[{ kcnt }]] = await conn.query('SELECT COUNT(*) AS kcnt FROM ai_knowledge');
  if (kcnt === 0) {
    console.log('Seeding AI knowledge base...');
    const knowledge = [
      ['flood_before', 'flood,before,prepare,preparation,typhoon coming,heavy rain',
       'Before a flood: (1) Monitor weather advisories and flood warnings. (2) Prepare an emergency go-bag with food, water, flashlight, batteries, first-aid kit, and important documents in a waterproof pouch. (3) Know your evacuation route and nearest evacuation center. (4) Move appliances and valuables to higher floors. (5) Charge phones and power banks fully. (6) Secure livestock and pets.', 'flood'],
      ['flood_during', 'flood,during,rising water,what to do now',
       'During a flood: (1) Move immediately to higher ground if water is rising. (2) Do NOT walk or drive through flowing water - 15 cm of moving water can knock you down. (3) Avoid contact with floodwater; it may be contaminated or electrified. (4) Turn off electricity at the main breaker if instructed or if flooding enters your home. (5) Keep updated through official alerts on this system. (6) If trapped, call the rescue hotline immediately.', 'flood'],
      ['flood_after', 'flood,after,recover,return home',
       'After a flood: (1) Return home only when officials say it is safe. (2) Check for structural damage before entering. (3) Do not use tap water until declared safe; boil water for drinking. (4) Discard food that contacted floodwater. (5) Beware of snakes and debris. (6) Document damage with photos for assistance claims. (7) Report unresolved hazards through incident reporting.', 'flood'],
      ['typhoon_before', 'typhoon,storm,hurricane,signal,before',
       'Before a typhoon: (1) Secure roof, windows, and outdoor items. (2) Store at least 3 days of food and water. (3) Trim tree branches near the house. (4) Keep your go-bag ready. (5) Know the evacuation center for your barangay. (6) Fully charge devices. (7) Follow preemptive evacuation orders immediately - do not wait for conditions to worsen.', 'typhoon'],
      ['typhoon_during', 'typhoon,during,eye of the storm',
       'During a typhoon: (1) Stay indoors away from windows. (2) Do not go outside during the calm "eye" - strong winds will resume from the opposite direction. (3) Turn off utilities if instructed. (4) Use battery lights, never candles if possible (fire risk). (5) Keep a radio on for updates. (6) If your house becomes unsafe, move to the nearest sturdy evacuation center only if it can be done safely.', 'typhoon'],
      ['earthquake', 'earthquake,quake,duck cover hold,tremor',
       'During an earthquake: DUCK, COVER, and HOLD. (1) Drop under a sturdy table and hold on. (2) Stay away from windows, mirrors, and heavy furniture. (3) If outdoors, move to open ground away from buildings, trees, and power lines. (4) If driving, pull over to a clear location and stay inside. (5) After shaking stops, check for injuries and damage, and be ready for aftershocks. (6) If near the coast and shaking is strong, move to higher ground immediately (tsunami risk).', 'earthquake'],
      ['fire', 'fire,burning,fire emergency',
       'In case of fire: (1) Alert everyone and evacuate immediately. (2) Call the fire department (see Emergency Contacts). (3) Do not use elevators. (4) If there is smoke, crawl low where air is cleaner. (5) Before opening a door, feel it - if hot, find another exit. (6) If clothes catch fire: STOP, DROP, and ROLL. (7) Never go back inside a burning building. (8) Gather at your designated meeting point.', 'fire'],
      ['landslide', 'landslide,mudslide,slope,collapsing ground',
       'Landslide preparedness: (1) Watch warning signs - cracks on slopes, tilting trees/posts, muddy springs appearing. (2) During heavy rain, stay alert especially at night; most casualties happen while sleeping. (3) If you hear rumbling or see moving soil, evacuate immediately - move AWAY from the landslide path, not downhill toward it. (4) Report slope cracks through incident reporting so the area can be assessed.', 'landslide'],
      ['go_bag', 'go bag,emergency kit,supplies,what to prepare,checklist',
       'Emergency go-bag checklist: (1) Water - 3 liters per person per day. (2) Non-perishable food for 3 days. (3) First-aid kit and personal medicines. (4) Flashlight + extra batteries. (5) Battery-powered or hand-crank radio. (6) Power bank and cables. (7) Important documents in waterproof pouch (IDs, land title, insurance). (8) Cash in small denominations. (9) Change of clothes and rain gear. (10) Whistle for signaling. (11) Hygiene supplies. Keep it near the exit and check contents every 6 months.', 'preparedness'],
      ['report_incident', 'report,how to report,incident,emergency happen',
       'To report an incident: (1) Log in to your account. (2) Go to "Report Incident" on the dashboard or public map. (3) Choose the incident type, describe what happened, and drop a pin or share your GPS location. (4) Attach a photo if safe to do so. (5) Submit - you can track its status from Reported, to Verified, Responding, and Resolved. In life-threatening emergencies, ALWAYS call the emergency hotlines first (see Emergency Contacts).', 'system'],
      ['evacuation_centers', 'evacuation,center,shelter,where to go',
       'Evacuation centers in this municipality are listed on the Interactive Map (green markers) and in the Emergency Info section. Each listing shows capacity, current occupants, and status (Standby/Open/Full). If an evacuation order is issued for your barangay, proceed to your designated center. Bring your go-bag. Persons with disabilities, elderly, and pregnant women should be prioritized for transport assistance - inform your barangay officials.', 'system'],
      ['risk_levels', 'risk level,critical,high risk,moderate,low risk,barangay risk',
       'Barangay disaster risk levels on the Risk Dashboard: LOW - minimal exposure, standard preparedness advised. MODERATE - some hazard exposure; residents should maintain go-bags and know evacuation routes. HIGH - significant exposure to flood/landslide; preemptive evacuation is likely during warnings. CRITICAL - extreme exposure; residents must immediately follow evacuation orders and register with barangay officials. Risk levels are assessed from hazard maps, elevation, and historical incidents.', 'system'],
      ['weather_warnings', 'weather,warning,signal,pagasa,forecast',
       'Weather warnings are fetched from the official weather provider and shown in the Weather Monitoring panel. Public storm signal meanings: Signal 1 - winds 39-61 kph, expect interruptions of 24-36h. Signal 2 - 62-88 kph, 12-24h interruptions. Signal 3 - 89-117 kph, severe damage expected. Signal 4 - 118-184 kph, widespread damage. Signal 5 - above 185 kph, catastrophic damage. When a signal is raised for your area, complete preparations immediately and monitor official alerts.', 'weather'],
      ['missing_person', 'missing,person missing,lost family,find person',
       'To report a missing person during a disaster: Go to the Missing Persons section, submit the full name, age, last known location, description of clothing/distinguishing features, a recent photo if available, and a contact number. Published reports help responders and the community assist the search. If the person is found, the report is marked Found. For immediate assistance, also contact the MDRRMO hotline and the police.', 'system']
    ];
    for (const k of knowledge) {
      await conn.query(
        'INSERT INTO ai_knowledge (topic, keywords, answer, category) VALUES (?,?,?,?)', k);
    }
  }

  // --- Sample incidents ---
  const [[{ icnt }]] = await conn.query('SELECT COUNT(*) AS icnt FROM incidents');
  if (icnt === 0) {
    console.log('Seeding sample incidents...');
    const incidents = [
      [4, 'flood', 'Floodwater rising knee-deep near the river road, several houses affected.', 17.4885, 120.7805, 'Riverside Rd., Santa Lucia', 3, 'reported'],
      [4, 'storm_damage', 'Large tree branch fell and blocked the barangay road after strong winds.', 17.5300, 120.7430, 'Main Rd., San Rafael', 2, 'verified'],
      [4, 'medical', 'Elderly resident needs medical assistance, has difficulty breathing.', 17.5075, 120.7595, 'Poblacion', 1, 'responding'],
      [4, 'fire', 'Small fire incident at a storage shed, already contained by volunteers.', 17.4795, 120.7945, 'Sabangan', 11, 'resolved']
    ];
    for (const i of incidents) {
      const [res] = await conn.query(
        'INSERT INTO incidents (reporter_id, incident_type, description, latitude, longitude, address, barangay_id, status) VALUES (?,?,?,?,?,?,?,?)', i);
      await conn.query(
        'INSERT INTO incident_history (incident_id, status, changed_by, note) VALUES (?,?,?,?)',
        [res.insertId, i[7], i[0], 'Initial report']);
    }
  }

  // --- System settings (customization defaults) ---
  const [[{ setcnt }]] = await conn.query('SELECT COUNT(*) AS setcnt FROM system_settings');
  if (setcnt === 0) {
    console.log('Seeding system settings...');
    const settings = [
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
    for (const [k, v] of settings) {
      await conn.query('INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES (?,?)', [k, v]);
    }
  }

  console.log('Database initialization complete.');
  await conn.end();
}

main().catch(err => {
  console.error('Database initialization failed:', err.message);
  process.exit(1);
});
