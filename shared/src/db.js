const { Pool } = require('pg');
require('dotenv').config({ path: process.env.DOTENV_PATH || require('path').join(__dirname, '../../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.PGHOST || 'localhost',
  port: +(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'cravedash',
  password: process.env.PGPASSWORD || 'cravedash',
  database: process.env.PGDATABASE || 'cravedash',
  max: +(process.env.PGPOOL_MAX || 10),
});

pool.on('error', (err) => {
  console.error('[pg] unexpected error', err);
});

module.exports = pool;
