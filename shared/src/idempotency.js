/**
 * Idempotency-Key protection for non-idempotent POSTs (AUD-P1-1).
 *
 * A request that carries an Idempotency-Key header is claimed in `request_idempotency` before the handler runs. The claim
 * is one INSERT ... ON CONFLICT DO NOTHING, so of two concurrent requests with the same key only one runs the handler:
 *   - a finished key returns the stored response again (same status and body, no new record);
 *   - a key still in progress answers 409 until its lease runs out, then the claim can be taken over;
 *   - a key reused with a different request answers 422.
 * Only 2xx responses are stored. A refused or failed request releases the claim, so the client can retry it.
 * A request without the header runs as before.
 */
const crypto = require('crypto');
const pool = require('./db');
const { AppError, badRequest } = require('./errors');
const { restaurantIdOrNull, branchId } = require('./authMiddleware');

const LEASE_INTERVAL = '2 minutes';
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

let tableReady = null;

/** Creates the claim table once per process. Two services may race to create it, so a duplicate-create error is accepted. */
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS request_idempotency (
        restaurant_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        response_status INT,
        response_body JSONB,
        lease_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (restaurant_id, scope, idem_key)
      )
    `).then(() => undefined, (err) => {
      if (err && err.code === '23505') return undefined;
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

/** Hash of the method, path and body, so a reused key with a different request is caught. */
function requestHash(req) {
  const path = String(req.originalUrl || '').split('?')[0];
  const body = JSON.stringify(req.body === undefined ? null : req.body);
  return crypto.createHash('sha256').update(`${req.method} ${path}\n${body}`).digest('hex');
}

/** Finishes a claim: stores a 2xx response, or releases the claim so a retry can run the request again. */
async function settle(tenant, scope, key, status, body) {
  if (status >= 200 && status < 300) {
    await pool.query(
      `UPDATE request_idempotency
       SET state = 'done', response_status = $4, response_body = $5::jsonb, lease_until = NULL, updated_at = NOW()
       WHERE restaurant_id = $1 AND scope = $2 AND idem_key = $3`,
      [tenant, scope, key, status, JSON.stringify(body === undefined ? null : body)],
    );
    return;
  }
  await pool.query(
    'DELETE FROM request_idempotency WHERE restaurant_id = $1 AND scope = $2 AND idem_key = $3 AND state = $4',
    [tenant, scope, key, 'in_progress'],
  );
}

/**
 * Express middleware. `scope` names the operation (for example 'orders'), so one key can be used by different operations.
 */
function idempotent(operation) {
  return async function idempotency(req, res, next) {
    const key = req.headers['idempotency-key'];
    if (key === undefined) return next();
    if (!KEY_PATTERN.test(String(key))) {
      return next(badRequest('Idempotency-Key must be 8 to 128 characters: letters, digits, dot, underscore, colon or dash'));
    }
    const tenant = restaurantIdOrNull(req);
    if (!tenant) return next();
    // The branch is part of the claim, so the same key used by two branches makes two independent requests (ORD-H4).
    // A session with no branch uses its own namespace ("none"), which is separate from every branch.
    const branch = branchId(req);
    const scope = `${operation}|branch=${branch ? encodeURIComponent(branch) : 'none'}`;

    try {
      await ensureTable();
      const hash = requestHash(req);
      const { rows: claimed } = await pool.query(
        `INSERT INTO request_idempotency (restaurant_id, scope, idem_key, request_hash, state, lease_until)
         VALUES ($1, $2, $3, $4, 'in_progress', NOW() + INTERVAL '${LEASE_INTERVAL}')
         ON CONFLICT DO NOTHING
         RETURNING idem_key`,
        [tenant, scope, String(key), hash],
      );
      if (!claimed[0]) {
        const { rows } = await pool.query(
          `SELECT request_hash, state, response_status, response_body, (lease_until > NOW()) AS active
           FROM request_idempotency WHERE restaurant_id = $1 AND scope = $2 AND idem_key = $3`,
          [tenant, scope, String(key)],
        );
        const row = rows[0];
        if (!row) return next(new AppError('The original request has ended. Retry the request.', 409, 'CONFLICT'));
        if (row.request_hash !== hash) {
          return next(new AppError('This Idempotency-Key was already used for a different request', 422, 'IDEMPOTENCY_CONFLICT'));
        }
        if (row.state === 'done') {
          res.set('Idempotent-Replayed', 'true');
          return res.status(row.response_status).json(row.response_body);
        }
        if (row.active) {
          return next(new AppError('The original request is still being processed. Retry shortly.', 409, 'CONFLICT'));
        }
        // The first attempt stopped without finishing and its lease ran out. Take the claim over, but only once.
        const { rowCount } = await pool.query(
          `UPDATE request_idempotency SET lease_until = NOW() + INTERVAL '${LEASE_INTERVAL}', updated_at = NOW()
           WHERE restaurant_id = $1 AND scope = $2 AND idem_key = $3 AND state = 'in_progress' AND lease_until <= NOW()`,
          [tenant, scope, String(key)],
        );
        if (!rowCount) return next(new AppError('The original request is still being processed. Retry shortly.', 409, 'CONFLICT'));
      }
    } catch (err) {
      return next(err);
    }

    // Persist the outcome before the response leaves, so a client that lost the response can replay it.
    const sendJson = res.json.bind(res);
    res.json = (body) => {
      settle(tenant, scope, String(key), res.statusCode, body).then(
        () => sendJson(body),
        (err) => {
          console.error('[idempotency] could not record the outcome', err.message);
          res.status(500);
          sendJson({ success: false, error: { code: 'INTERNAL_ERROR', message: 'The request outcome could not be recorded. Retry with the same key.' } });
        },
      );
      return res;
    };
    return next();
  };
}

module.exports = { idempotent, ensureTable, requestHash };
