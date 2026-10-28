/**
 * CraveDash Canonical Database Migration Runner
 * 
 * Features:
 * - Sequential versioned migrations (.up.sql)
 * - PostgreSQL advisory lock for safe concurrent executions
 * - schema_migrations tracking table with SHA-256 checksums and execution times
 * - Idempotent re-runs (skips already applied migrations)
 * - Checksum mismatch detection (aborts if applied migration was altered)
 * - Per-migration transactional execution (BEGIN ... COMMIT / ROLLBACK)
 * - Automatic baseline detection for pre-existing schemas (e.g., init-db.sql)
 * - Policy safeguard: automatic destructive rollbacks are prohibited
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// Normalized SHA-256 calculation (handles cross-platform line endings)
function computeChecksum(content) {
  const normalized = content.replace(/\r\n/g, '\n').trimEnd();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

// Extract version and description from filename (e.g. 000_baseline.up.sql -> { version: '000', description: 'baseline' })
function parseMigrationFilename(filename) {
  const match = filename.match(/^(\d+[\w-]*?)_(.*?)\.up\.sql$/);
  if (!match) return null;
  return {
    filename,
    version: match[1],
    description: match[2].replace(/_/g, ' '),
  };
}

// Discover and sort all .up.sql migrations in directory
function getMigrationFiles(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }
  const files = fs.readdirSync(migrationsDir);
  const migrations = [];
  for (const file of files) {
    const parsed = parseMigrationFilename(file);
    if (parsed) {
      const fullPath = path.join(migrationsDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      migrations.push({
        ...parsed,
        fullPath,
        content,
        checksum: computeChecksum(content),
      });
    }
  }

  // Validate that migration versions are unique
  const seenVersions = new Map();
  for (const m of migrations) {
    if (seenVersions.has(m.version)) {
      throw new Error(
        `Duplicate migration version detected: "${m.version}" (${m.filename} collides with ${seenVersions.get(m.version)})`
      );
    }
    seenVersions.set(m.version, m.filename);
  }

  return migrations.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
}

// Ensure schema_migrations table exists
async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum VARCHAR(64) NOT NULL,
      execution_time_ms INT NOT NULL
    );
  `);
}

// Canonical baseline tables defined in 000_baseline.up.sql / scripts/init-db.sql
const CANONICAL_BASELINE_TABLES = [
  'users', 'user_prefs', 'plans', 'restaurants', 'subscriptions',
  'platform_admins', 'stripe_config', 'categories', 'subcategories', 'products',
  'addons', 'cuisines', 'deals', 'orders', 'customers',
  'coupons', 'areas', 'dining_tables', 'bookings', 'employees',
  'employee_roles', 'restaurant_settings', 'approval_requests', 'epos_tills', 'till_staff',
  'till_checkins', 'held_orders', 'report_counters', 'z_reports', 'restaurant_blobs'
];

// Check all existing base tables in public schema
async function detectExistingSchema(client) {
  const res = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      AND table_name != 'schema_migrations';
  `);
  return res.rows.map(r => r.table_name);
}

// Parse and strictly validate integer millisecond timeouts [min, max]
function parseTimeout(val, fallback, name = 'timeout', min = 0, max = 3600000) {
  if (val === undefined || val === null || val === '') {
    return fallback;
  }

  let num;
  if (typeof val === 'number') {
    num = val;
  } else if (typeof val === 'string') {
    const trimmed = val.trim();
    // Strictly require optional minus sign + digits only; reject decimals, scientific notation, units like 'ms'
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(
        `Invalid ${name}: "${val}". Must be a clean integer between ${min} and ${max} milliseconds.`
      );
    }
    num = Number(trimmed);
  } else {
    throw new Error(
      `Invalid ${name}: expected number or numeric string, got ${typeof val}.`
    );
  }

  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new Error(
      `Invalid ${name}: "${val}". Must be a finite integer between ${min} and ${max} milliseconds.`
    );
  }

  if (num < min || num > max) {
    throw new Error(
      `Invalid ${name}: ${num}. Value out of allowed range [${min}, ${max}] milliseconds.`
    );
  }

  return num;
}

// Main migration executor
async function runMigrations(options = {}) {
  const migrationsDir = options.migrationsDir || process.env.MIGRATIONS_DIR || path.resolve(__dirname, '../../database/migrations');

  // Validate configuration before calling pool.connect()
  const lockTimeoutMs = parseTimeout(
    options.lockTimeoutMs !== undefined ? options.lockTimeoutMs : process.env.PG_LOCK_TIMEOUT_MS,
    10000,
    'lock timeout (lockTimeoutMs / PG_LOCK_TIMEOUT_MS)',
    0,
    3600000
  );
  const statementTimeoutMs = parseTimeout(
    options.statementTimeoutMs !== undefined ? options.statementTimeoutMs : process.env.PG_STATEMENT_TIMEOUT_MS,
    60000,
    'statement timeout (statementTimeoutMs / PG_STATEMENT_TIMEOUT_MS)',
    0,
    3600000
  );

  const pool = options.pool || new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.PGHOST || 'localhost',
    port: +(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'cravedash',
    password: process.env.PGPASSWORD || 'cravedash',
    database: process.env.PGDATABASE || 'cravedash',
  });

  const client = await pool.connect();
  const advisoryLockId = 8675309; // CraveDash migration lock key

  try {
    // 0. Set connection timeouts to prevent indefinite hangs during DDL or lock contention
    if (lockTimeoutMs === 0) {
      await client.query('SET lock_timeout = 0');
    } else {
      await client.query(`SET lock_timeout = '${lockTimeoutMs}ms'`);
    }

    if (statementTimeoutMs === 0) {
      await client.query('SET statement_timeout = 0');
    } else {
      await client.query(`SET statement_timeout = '${statementTimeoutMs}ms'`);
    }

    // 1. Acquire advisory lock
    console.log('[migrate] Acquiring migration advisory lock...');
    await client.query('SELECT pg_advisory_lock($1)', [advisoryLockId]);

    // 2. Ensure schema_migrations table
    await ensureMigrationTable(client);

    // 3. Load recorded migrations
    const recordedRes = await client.query(
      'SELECT version, description, applied_at, checksum, execution_time_ms FROM schema_migrations ORDER BY version ASC;'
    );
    const recordedMap = new Map();
    for (const row of recordedRes.rows) {
      recordedMap.set(row.version, row);
    }

    // 4. Discover on-disk migrations
    const diskMigrations = getMigrationFiles(migrationsDir);
    console.log(`[migrate] Discovered ${diskMigrations.length} migration file(s) in ${migrationsDir}`);

    // 5. Handle pre-existing schema baseline if schema_migrations is empty
    if (recordedMap.size === 0) {
      const existingTables = await detectExistingSchema(client);
      if (existingTables.length > 0) {
        // Verify all 30 canonical baseline tables are present
        const missingCanonical = CANONICAL_BASELINE_TABLES.filter(t => !existingTables.includes(t));
        if (missingCanonical.length === 0) {
          console.log(`[migrate] Detected complete canonical baseline schema (${existingTables.length} tables).`);
          const baselineMigration = diskMigrations.find(m => m.version === '000' || m.version === '001_baseline');
          if (baselineMigration) {
            console.log(`[migrate] Recording baseline migration "${baselineMigration.version}" without re-execution...`);
            await client.query(
              'INSERT INTO schema_migrations (version, description, checksum, execution_time_ms) VALUES ($1, $2, $3, $4)',
              [baselineMigration.version, `${baselineMigration.description} (baseline recorded)`, baselineMigration.checksum, 0]
            );
            recordedMap.set(baselineMigration.version, {
              version: baselineMigration.version,
              description: baselineMigration.description,
              checksum: baselineMigration.checksum,
            });
          }
        } else {
          throw new Error(
            `[migrate] FATAL: Existing database contains incomplete schema (found ${existingTables.length} tables, missing ${missingCanonical.length} canonical baseline tables: ${missingCanonical.join(', ')}).\n` +
            `Automatic baselining aborted to protect data integrity. Please verify the database state.`
          );
        }
      }
    }

    // 6. Verify checksums for previously applied migrations
    for (const [version, recorded] of recordedMap.entries()) {
      const diskMatch = diskMigrations.find(m => m.version === version);
      if (diskMatch) {
        if (diskMatch.checksum !== recorded.checksum) {
          throw new Error(
            `FATAL: Checksum mismatch for migration "${version}" (${diskMatch.filename})!\n` +
            `  Recorded checksum: ${recorded.checksum}\n` +
            `  Disk checksum:     ${diskMatch.checksum}\n` +
            `Migration aborted to prevent schema inconsistency.`
          );
        }
      } else {
        console.warn(`[migrate] Warning: Recorded migration "${version}" not found on disk.`);
      }
    }

    // Determine highest recorded version (if any)
    let maxRecordedVersion = null;
    if (recordedMap.size > 0) {
      for (const recordedVersion of recordedMap.keys()) {
        if (!maxRecordedVersion || recordedVersion.localeCompare(maxRecordedVersion, undefined, { numeric: true }) > 0) {
          maxRecordedVersion = recordedVersion;
        }
      }
    }

    // 7. Determine pending migrations
    const pending = diskMigrations.filter(m => !recordedMap.has(m.version));

    if (options.statusOnly) {
      console.log('\n--- Migration Status ---');
      for (const m of diskMigrations) {
        const isApplied = recordedMap.has(m.version);
        let status = 'PENDING';
        if (isApplied) {
          status = `APPLIED (${recordedMap.get(m.version).applied_at})`;
        } else if (maxRecordedVersion && m.version.localeCompare(maxRecordedVersion, undefined, { numeric: true }) < 0) {
          status = `PENDING (OUT-OF-ORDER: lower than ${maxRecordedVersion})`;
        }
        console.log(`  [${status}] ${m.version}: ${m.description} (${m.checksum.substring(0, 8)})`);
      }
      return { total: diskMigrations.length, applied: recordedMap.size, pending: pending.length };
    }

    if (pending.length === 0) {
      console.log('[migrate] Database is up to date. 0 pending migrations.');
      return { appliedCount: 0 };
    }

    // 8. Reject out-of-order pending migrations (versions lower than max recorded applied version)
    if (maxRecordedVersion !== null) {
      const outOfOrder = pending.filter(
        m => m.version.localeCompare(maxRecordedVersion, undefined, { numeric: true }) < 0
      );
      if (outOfOrder.length > 0) {
        const outList = outOfOrder.map(m => `"${m.filename}" (version ${m.version})`).join(', ');
        throw new Error(
          `Out-of-order migration detected: ${outList} has a version lower than the highest applied migration "${maxRecordedVersion}".\n` +
          `Applying migrations out of order can cause schema inconsistencies and non-deterministic database states.\n` +
          `To resolve safely:\n` +
          `  1. If this is a new migration, renumber its version prefix to be higher than "${maxRecordedVersion}".\n` +
          `  2. If this migration was already applied manually, record it in schema_migrations with its SHA-256 checksum.`
        );
      }
    }

    console.log(`[migrate] Applying ${pending.length} pending migration(s)...`);

    // 9. Execute pending migrations transactionally
    for (const migration of pending) {
      console.log(`[migrate] Running ${migration.filename}...`);
      const startTime = Date.now();

      await client.query('BEGIN');
      try {
        await client.query(migration.content);
        const elapsed = Date.now() - startTime;
        await client.query(
          'INSERT INTO schema_migrations (version, description, checksum, execution_time_ms) VALUES ($1, $2, $3, $4)',
          [migration.version, migration.description, migration.checksum, elapsed]
        );
        await client.query('COMMIT');
        console.log(`[migrate] Applied ${migration.filename} in ${elapsed}ms`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] ERROR: Migration ${migration.filename} failed. Transaction rolled back.`);
        throw err;
      }
    }

    console.log('[migrate] All pending migrations applied successfully.');
    return { appliedCount: pending.length };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [advisoryLockId]);
      console.log('[migrate] Released migration advisory lock.');
    } catch (_) {}
    client.release();
    if (!options.pool) {
      await pool.end();
    }
  }
}

// CLI handler
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--down') || args.includes('--rollback')) {
    console.error(
      '[migrate] Safeguard Notice: Automatic destructive rollbacks are prohibited.\n' +
      'Paired .down.sql files are provided strictly for documented emergency manual recovery.\n' +
      'Inspect the corresponding .down.sql script and execute manual recovery only under explicit operational change control.'
    );
    process.exit(1);
  }

  const statusOnly = args.includes('--status');
  const dirIndex = args.indexOf('--dir');
  const migrationsDir = dirIndex !== -1 && args[dirIndex + 1] ? path.resolve(args[dirIndex + 1]) : undefined;

  runMigrations({ statusOnly, migrationsDir })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] Execution failed:', err.message);
      process.exit(1);
    });
}

module.exports = {
  runMigrations,
  computeChecksum,
  parseMigrationFilename,
  getMigrationFiles,
  CANONICAL_BASELINE_TABLES,
  detectExistingSchema,
  ensureMigrationTable,
  parseTimeout,
};
