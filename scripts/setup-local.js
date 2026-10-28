/**
 * One-shot: start embedded Postgres (background), migrate, seed.
 */
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const root = path.join(__dirname, '..');
const PORT = +(process.env.PGPORT || 5432);

function waitPort(port, ms = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.end();
        resolve();
      });
      s.on('error', () => {
        if (Date.now() - start > ms) reject(new Error(`Timeout waiting for port ${port}`));
        else setTimeout(tryOnce, 400);
      });
    };
    tryOnce();
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd: root, stdio: 'inherit', env: process.env });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} → ${code}`))));
  });
}

async function main() {
  console.log('=== CraveDash local setup ===');
  const db = spawn(process.execPath, [path.join(root, 'scripts/start-embedded-db.js')], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    detached: true,
  });
  db.unref();

  console.log('Waiting for PostgreSQL…');
  await waitPort(PORT, 120000);
  await new Promise((r) => setTimeout(r, 1500));

  console.log('Migrating…');
  await run(process.execPath, [path.join(root, 'shared/scripts/migrate.js')]);
  console.log('Seeding…');
  await run(process.execPath, [path.join(root, 'scripts/seed-full.js')]);
  console.log('\nSetup complete. DB is running in the background.');
  console.log('Next: npm run dev   (API)  and  npm run dev:frontend');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
