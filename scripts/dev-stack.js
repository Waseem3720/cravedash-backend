const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const root = path.join(__dirname, '..');
const PORT = +(process.env.PGPORT || 5432);
const children = [];

function waitPort(port, ms = 90000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.end();
        resolve(true);
      });
      s.on('error', () => {
        if (Date.now() - start > ms) reject(new Error(`Timeout waiting for :${port}`));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

function start(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  children.push(child);
  return child;
}

async function main() {
  // Ensure DB
  let dbUp = false;
  try {
    await waitPort(PORT, 800);
    dbUp = true;
    console.log('[stack] PostgreSQL already up');
  } catch {
    console.log('[stack] Starting embedded PostgreSQL…');
    start('db', [path.join(root, 'scripts/start-embedded-db.js')]);
    await waitPort(PORT, 120000);
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Migrate + seed once
  await new Promise((resolve, reject) => {
    const m = spawn(process.execPath, [path.join(root, 'shared/scripts/migrate.js')], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    m.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('migrate failed'))));
  });
  await new Promise((resolve, reject) => {
    const s = spawn(process.execPath, [path.join(root, 'scripts/seed-full.js')], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    s.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('seed failed'))));
  });

  // API services
  require('./dev-all.js');

  // Frontend
  const fe = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--prefix', 'frontend'],
    { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  fe.stdout.on('data', (d) => process.stdout.write(`[frontend] ${d}`));
  fe.stderr.on('data', (d) => process.stderr.write(`[frontend] ${d}`));
  children.push(fe);

  console.log('[stack] API gateway http://localhost:4000');
  console.log('[stack] Frontend   http://localhost:5173');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
