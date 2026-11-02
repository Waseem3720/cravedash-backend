const fs = require('fs');
const path = require('path');
const pool = require('../src/db');

async function main() {
  const sqlPath = path.join(__dirname, '../../scripts/init-db.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await pool.query(sql);
  console.log('Database schema applied:', sqlPath);
  // Numbered migrations after the base schema, in name order (for example 002_branches_customer_id.sql).
  const migrationsDir = path.join(__dirname, '../../scripts/migrations');
  const files = fs.existsSync(migrationsDir) ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort() : [];
  for (const file of files) {
    await pool.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    console.log('Migration applied:', file);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
