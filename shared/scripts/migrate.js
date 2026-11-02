const fs = require('fs');
const path = require('path');
const pool = require('../src/db');

async function main() {
  console.log('[migrate] Connecting to database...');
  const sqlPath = path.join(__dirname, '../../scripts/init-db.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  console.log('[migrate] Applying base schema from:', sqlPath);
  await pool.query(sql);
  console.log('[migrate] Base schema applied successfully');

  // Numbered migrations after the base schema, in name order (for example 002_branches_customer_id.sql).
  const migrationsDir = path.join(__dirname, '../../scripts/migrations');
  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    : [];
  for (const file of files) {
    console.log(`[migrate] Applying migration: ${file}...`);
    await pool.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    console.log(`[migrate] Migration ${file} applied successfully`);
  }
  await pool.end();
  console.log('[migrate] All migrations completed successfully!');
}

main().catch((err) => {
  console.error('[migrate] FATAL ERROR during migration:', err);
  process.exit(1);
});
