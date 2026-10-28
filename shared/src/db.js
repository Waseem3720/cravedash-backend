const { Pool } = require('pg');
require('dotenv').config({ path: process.env.DOTENV_PATH || require('path').join(__dirname, '../../.env') });

// Prefer discrete connection parameters when PGHOST is defined to avoid URL parsing errors
// if passwords or usernames contain special characters (e.g. '@', '#', '%', ':').
const poolConfig = process.env.PGHOST
  ? {
      host: process.env.PGHOST,
      port: +(process.env.PGPORT || 5432),
      user: process.env.PGUSER || 'cravedash',
      password: process.env.PGPASSWORD || 'cravedash',
      database: process.env.PGDATABASE || 'cravedash',
      max: +(process.env.PGPOOL_MAX || 10),
    }
  : process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        max: +(process.env.PGPOOL_MAX || 10),
      }
    : {
        host: 'localhost',
        port: +(process.env.PGPORT || 5432),
        user: process.env.PGUSER || 'cravedash',
        password: process.env.PGPASSWORD || 'cravedash',
        database: process.env.PGDATABASE || 'cravedash',
        max: +(process.env.PGPOOL_MAX || 10),
      };

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('[pg] unexpected error', err);
});

module.exports = pool;
