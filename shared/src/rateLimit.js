/**
 * Sliding-window rate limiter & distributed lockout tracker.
 * Uses Redis when REDIS_URL is set and reachable; otherwise in-memory (per process).
 * Note: In-memory fallback is strictly local to the Node.js process and does not provide
 * distributed protection across multiple clustered instances or survival across restarts.
 */
let redisClient = null;
let redisInitAttempted = false;
let redisAvailable = false;

function initRedis() {
  if (redisInitAttempted) return;
  redisInitAttempted = true;
  const url = process.env.REDIS_URL || process.env.RATE_LIMIT_REDIS_URL;
  if (!url) return;
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
    redisClient.on('close', () => { redisAvailable = false; });
    redisClient.on('end', () => { redisAvailable = false; });
    redisClient.on('reconnecting', () => { redisAvailable = false; });
    redisClient.connect().then(() => { redisAvailable = true; }).catch(() => {
      redisAvailable = false;
    });
  } catch {
    redisAvailable = false;
  }
}

function getRedisClient() {
  initRedis();
  return redisAvailable ? redisClient : null;
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
  if (!results) throw new Error('Redis pipeline returned empty results');
  for (const [err] of results) {
    if (err) throw err;
  }
  const count = results[2] && results[2][1] != null ? Number(results[2][1]) : 0;
  return count <= max;
}

function createRateLimiter({ windowMs = 60_000, max = 20, keyFn } = {}) {
  const memory = createMemoryLimiter({ windowMs, max, keyFn });
  initRedis(); // kick off connect if configured

  return function rateLimit(req, res, next) {
    const key = (keyFn && keyFn(req)) || req.ip || 'global';
    const client = getRedisClient();
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
        // Redis blip or command error → fail open to memory limiter for this request
        memory(req, res, next);
      });
  };
}

/**
 * Distributed lockout tracker for consecutive failure limits (e.g. EPOS PIN).
 * Atomically tracks failures and lockout duration in Redis with in-memory fallback.
 */
function createLockoutTracker({ namespace = 'lockout', windowMs = 15 * 60 * 1000, maxFails = 5 } = {}) {
  const memoryState = new Map();

  function pruneMemory(now) {
    for (const [k, v] of memoryState) {
      if (v.lockedUntil && v.lockedUntil < now && v.fails === 0) {
        memoryState.delete(k);
      }
    }
  }

  function memoryCheck(key) {
    const rec = memoryState.get(key);
    if (rec && rec.lockedUntil && Date.now() < rec.lockedUntil) {
      const remainingSeconds = Math.ceil((rec.lockedUntil - Date.now()) / 1000);
      return { locked: true, remainingSeconds };
    }
    return { locked: false, remainingSeconds: 0 };
  }

  function memoryRecord(key) {
    const rec = memoryState.get(key) || { fails: 0, lockedUntil: 0 };
    rec.fails += 1;
    if (rec.fails >= maxFails) {
      rec.lockedUntil = Date.now() + windowMs;
      rec.fails = 0;
      memoryState.set(key, rec);
      return { locked: true, remainingSeconds: Math.ceil(windowMs / 1000) };
    }
    memoryState.set(key, rec);
    if (memoryState.size > 20_000) pruneMemory(Date.now());
    return { locked: false, remainingSeconds: 0 };
  }

  function memoryClear(key) {
    memoryState.delete(key);
  }

  return {
    async check(key) {
      const client = getRedisClient();
      if (!client) return memoryCheck(key);
      try {
        const lockKey = `${namespace}:${key}:locked`;
        const pttl = await client.pttl(lockKey);
        if (pttl > 0) {
          return { locked: true, remainingSeconds: Math.ceil(pttl / 1000) };
        }
        return { locked: false, remainingSeconds: 0 };
      } catch {
        return memoryCheck(key);
      }
    },

    async recordFailure(key) {
      const client = getRedisClient();
      if (!client) return memoryRecord(key);
      try {
        const lockKey = `${namespace}:${key}:locked`;
        const failKey = `${namespace}:${key}:fails`;
        const p = client.multi();
        p.incr(failKey);
        p.pexpire(failKey, windowMs);
        const results = await p.exec();
        if (!results) throw new Error('Redis pipeline returned empty result');
        for (const [err] of results) {
          if (err) throw err;
        }
        const fails = Number(results[0][1]);
        if (fails >= maxFails) {
          const lockP = client.multi();
          lockP.set(lockKey, String(Date.now() + windowMs), 'PX', windowMs);
          lockP.del(failKey);
          const lockResults = await lockP.exec();
          if (lockResults) {
            for (const [err] of lockResults) {
              if (err) throw err;
            }
          }
          return { locked: true, remainingSeconds: Math.ceil(windowMs / 1000) };
        }
        return { locked: false, remainingSeconds: 0 };
      } catch {
        return memoryRecord(key);
      }
    },

    async clear(key) {
      memoryClear(key);
      const client = getRedisClient();
      if (!client) return;
      try {
        await client.del(`${namespace}:${key}:fails`, `${namespace}:${key}:locked`);
      } catch {
        // fail-soft on clear
      }
    },
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

function _setMockRedisClientForTests(mockClient) {
  redisInitAttempted = true;
  if (mockClient) {
    redisClient = mockClient;
    redisAvailable = true;
  } else {
    redisClient = null;
    redisAvailable = false;
  }
}

module.exports = {
  createRateLimiter,
  createLockoutTracker,
  _resetRedisStateForTests,
  _setMockRedisClientForTests,
};
