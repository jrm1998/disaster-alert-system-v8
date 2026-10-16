// Safe, idempotent seeder for the AI knowledge base.
// Connects to the configured database and inserts rows ONLY if the table is empty,
// so it never overwrites or duplicates existing data on a live database.
process.env.TZ = 'Asia/Manila';
require('dotenv').config();
const mysql = require('mysql2/promise');
const knowledge = require('./ai-knowledge.seed');

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

  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM ai_knowledge');
  if (n > 0) {
    console.log(`ai_knowledge already has ${n} rows - nothing to do.`);
    await conn.end();
    return;
  }

  console.log(`Seeding ${knowledge.length} ai_knowledge rows...`);
  for (const row of knowledge) {
    await conn.query(
      'INSERT INTO ai_knowledge (topic, keywords, answer, category) VALUES (?,?,?,?)', row);
  }
  console.log('AI knowledge base seeded.');
  await conn.end();
}

main().catch(err => {
  console.error('Seeding failed:', err.message);
  process.exit(1);
});
