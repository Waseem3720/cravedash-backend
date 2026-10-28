/**
 * OTP storage — Redis when REDIS_URL is set, else Postgres table, else memory.
 */
const crypto = require('crypto');
const pool = require('./db');

let redis = null;
let redisTried = false;
const memory = new Map();
let tableReady = null;

function getRedis() {
  if (redisTried) return redis;
  redisTried = true;
  const url = process.env.REDIS_URL || process.env.RATE_LIMIT_REDIS_URL;
  if (!url) return null;
  try {
    const Redis = require('ioredis');
    redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      lazyConnect: true,
    });
    redis.connect().catch(() => { redis = null; });
    return redis;
  } catch {
    redis = null;
    return null;
  }
}

async function ensureTable() {
  if (tableReady) return tableReady;
  tableReady = pool.query(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      key TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      exp TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((e) => { tableReady = null; throw e; });
  return tableReady;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

async function setOtp(key, code, ttlSec = 300) {
  const hash = hashCode(code);
  const expMs = Date.now() + ttlSec * 1000;
  const r = getRedis();
  if (r) {
    try {
      await r.set(`otp:${key}`, JSON.stringify({ hash, attempts: 0, exp: expMs }), 'EX', ttlSec);
      return;
    } catch { /* fall through */ }
  }
  try {
    await ensureTable();
    await pool.query(
      `INSERT INTO otp_codes (key, hash, attempts, exp) VALUES ($1,$2,0,to_timestamp($3/1000.0))
       ON CONFLICT (key) DO UPDATE SET hash = EXCLUDED.hash, attempts = 0, exp = EXCLUDED.exp`,
      [key, hash, expMs],
    );
    return;
  } catch { /* fall through */ }
  memory.set(key, { hash, attempts: 0, exp: expMs });
}

async function verifyOtp(key, code, maxAttempts = 5) {
  const want = hashCode(code);
  const r = getRedis();
  if (r) {
    try {
      const raw = await r.get(`otp:${key}`);
      if (!raw) return { ok: false, reason: 'expired' };
      const row = JSON.parse(raw);
      if (row.exp < Date.now()) {
        await r.del(`otp:${key}`);
        return { ok: false, reason: 'expired' };
      }
      row.attempts = (row.attempts || 0) + 1;
      if (row.attempts > maxAttempts) {
        await r.del(`otp:${key}`);
        return { ok: false, reason: 'locked' };
      }
      if (row.hash !== want) {
        const ttl = Math.max(1, Math.ceil((row.exp - Date.now()) / 1000));
        await r.set(`otp:${key}`, JSON.stringify(row), 'EX', ttl);
        return { ok: false, reason: 'invalid' };
      }
      await r.del(`otp:${key}`);
      return { ok: true };
    } catch { /* fall through */ }
  }
  try {
    await ensureTable();
    const { rows } = await pool.query('SELECT hash, attempts, exp FROM otp_codes WHERE key = $1', [key]);
    const row = rows[0];
    if (!row || new Date(row.exp).getTime() < Date.now()) {
      await pool.query('DELETE FROM otp_codes WHERE key = $1', [key]);
      return { ok: false, reason: 'expired' };
    }
    const attempts = (+row.attempts || 0) + 1;
    if (attempts > maxAttempts) {
      await pool.query('DELETE FROM otp_codes WHERE key = $1', [key]);
      return { ok: false, reason: 'locked' };
    }
    if (row.hash !== want) {
      await pool.query('UPDATE otp_codes SET attempts = $2 WHERE key = $1', [key, attempts]);
      return { ok: false, reason: 'invalid' };
    }
    await pool.query('DELETE FROM otp_codes WHERE key = $1', [key]);
    return { ok: true };
  } catch { /* fall through */ }

  const mem = memory.get(key);
  if (!mem || mem.exp < Date.now()) {
    memory.delete(key);
    return { ok: false, reason: 'expired' };
  }
  mem.attempts += 1;
  if (mem.attempts > maxAttempts) {
    memory.delete(key);
    return { ok: false, reason: 'locked' };
  }
  if (mem.hash !== want) return { ok: false, reason: 'invalid' };
  memory.delete(key);
  return { ok: true };
}

module.exports = { setOtp, verifyOtp, hashCode };
