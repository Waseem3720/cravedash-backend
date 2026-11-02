/**
 * Sliding-window rate limiter.
 * Uses Redis when REDIS_URL is set and reachable; otherwise in-memory (per process).
 */
let redisClient = null;
let redisInitAttempted = false;
let redisAvailable = false;

function getRedis() {
  if (redisInitAttempted) return redisAvailable ? redisClient : null;
  redisInitAttempted = true;
  const url = process.env.REDIS_URL || process.env.RATE_LIMIT_REDIS_URL;
  if (!url) return null;
  try {
    // Lazy require so installs without ioredis still boot
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const Redis = require('ioredis');
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      connectTimeout: 2000,
      lazyConnect: true,
    });
    redisClient.on('error', () => { redisAvailable = false; });
    redisClient.on('ready', () => { redisAvailable = true; });
    redisClient.connect().then(() => { redisAvailable = true; }).catch(() => {
      redisAvailable = false;
    });
    return redisClient;
  } catch {
    redisAvailable = false;
    return null;
  }
}

function createMemoryLimiter({ windowMs, max, keyFn }) {
  const hits = new Map();
  function prune(now) {
    for (const [k, arr] of hits) {
      const next = arr.filter((t) => now - t < windowMs);
      if (!next.length) hits.delete(k);
      else hits.set(k, next);
    }
  }
  return function memoryLimit(req, res, next) {
    const now = Date.now();
    if (hits.size > 10_000) prune(now);
    const key = (keyFn && keyFn(req)) || req.ip || 'global';
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many attempts — try again shortly' },
      });
      return;
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}

async function redisHit(client, key, windowMs, max) {
  const now = Date.now();
  const redisKey = `rl:${key}`;
  const pipeline = client.multi();
  pipeline.zremrangebyscore(redisKey, 0, now - windowMs);
  pipeline.zadd(redisKey, now, `${now}:${Math.random().toString(36).slice(2, 8)}`);
  pipeline.zcard(redisKey);
  pipeline.pexpire(redisKey, windowMs);
  const results = await pipeline.exec();
  const count = results && results[2] ? Number(results[2][1]) : 0;
  return count <= max;
}

function createRateLimiter({ windowMs = 60_000, max = 20, keyFn } = {}) {
  const memory = createMemoryLimiter({ windowMs, max, keyFn });
  getRedis(); // kick off connect if configured

  return function rateLimit(req, res, next) {
    const key = (keyFn && keyFn(req)) || req.ip || 'global';
    const client = redisAvailable ? redisClient : null;
    if (!client) return memory(req, res, next);

    redisHit(client, key, windowMs, max)
      .then((ok) => {
        if (!ok) {
          res.status(429).json({
            success: false,
            error: { code: 'RATE_LIMITED', message: 'Too many attempts — try again shortly' },
          });
          return;
        }
        next();
      })
      .catch(() => {
        // Redis blip → fail open to memory limiter for this request
        memory(req, res, next);
      });
  };
}

/** Test helpers */
function _resetRedisStateForTests() {
  redisInitAttempted = false;
  redisAvailable = false;
  if (redisClient) {
    try { redisClient.disconnect(); } catch { /* ignore */ }
  }
  redisClient = null;
}

module.exports = { createRateLimiter, _resetRedisStateForTests };
