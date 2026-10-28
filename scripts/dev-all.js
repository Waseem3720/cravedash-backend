const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const services = [
  { name: 'gateway', file: 'services/gateway/src/index.js', port: 4000 },
  { name: 'auth', file: 'services/auth-service/src/index.js', port: 4001 },
  { name: 'catalog', file: 'services/catalog-service/src/index.js', port: 4002 },
  { name: 'order', file: 'services/order-service/src/index.js', port: 4003 },
  { name: 'restaurant', file: 'services/restaurant-service/src/index.js', port: 4004 },
  { name: 'platform', file: 'services/platform-service/src/index.js', port: 4005 },
  { name: 'epos', file: 'services/epos-service/src/index.js', port: 4006 },
  { name: 'reporting', file: 'services/reporting-service/src/index.js', port: 4007 },
];

const root = path.join(__dirname, '..');
const children = new Map();
const restarting = new Set();
let shuttingDown = false;

function start(svc) {
  if (shuttingDown) return;
  const child = spawn(process.execPath, [path.join(root, svc.file)], {
    cwd: root,
    env: { ...process.env, PORT: String(svc.port), SERVICE_NAME: svc.name },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${svc.name}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${svc.name}] ${d}`));
  child.on('exit', (code, signal) => {
    children.delete(svc.name);
    if (shuttingDown) return;
    console.error(`[${svc.name}] exited code=${code} signal=${signal} — restarting in 1s`);
    if (restarting.has(svc.name)) return;
    restarting.add(svc.name);
    setTimeout(() => {
      restarting.delete(svc.name);
      start(svc);
    }, 1000);
  });
  children.set(svc.name, child);
  console.log(`Started ${svc.name} on :${svc.port} (pid ${child.pid})`);
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function watchHealth() {
  for (const svc of services) {
    if (shuttingDown) return;
    const ok = await ping(svc.port);
    if (!ok && children.has(svc.name)) {
      console.error(`[watchdog] ${svc.name} :${svc.port} not healthy — killing for restart`);
      try { children.get(svc.name).kill('SIGTERM'); } catch (e) { /* ignore */ }
    } else if (!ok && !children.has(svc.name) && !restarting.has(svc.name)) {
      console.error(`[watchdog] ${svc.name} missing — starting`);
      start(svc);
    }
  }
}

function runMigrations() {
  return new Promise((resolve, reject) => {
    console.log('[dev-all] Running pre-startup database migrations...');
    const m = spawn(process.execPath, [path.join(root, 'shared/scripts/migrate.js')], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    m.on('exit', (code) => {
      if (code === 0) {
        console.log('[dev-all] Migrations completed successfully.');
        resolve();
      } else {
        reject(new Error(`Migration runner exited with code ${code}`));
      }
    });
    m.on('error', reject);
  });
}

function shutdown() {
  shuttingDown = true;
  children.forEach((c) => {
    try { c.kill('SIGTERM'); } catch (e) { /* ignore */ }
  });
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function startStack() {
  // Only execute migrations when invoked directly (npm run dev / node scripts/dev-all.js).
  // When required by scripts/dev-stack.js (npm run dev:all), migrations were already executed.
  const isDirectExecution = require.main === module;
  const skipMigrate = process.env.SKIP_MIGRATE === '1';

  if (isDirectExecution && !skipMigrate) {
    try {
      await runMigrations();
    } catch (err) {
      console.error(`[dev-all] FATAL: ${err.message}. Aborting service startup.`);
      process.exit(1);
    }
  }

  services.forEach(start);
  setInterval(watchHealth, 5000);
}

startStack();
