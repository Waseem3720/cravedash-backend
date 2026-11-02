const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { fail } = require('./response');
const { AppError } = require('./errors');

function resolveCorsOrigin() {
  const corsOrigin = process.env.CORS_ORIGIN;
  const isProd = process.env.NODE_ENV === 'production';
  if (!corsOrigin || corsOrigin === '*') {
    if (isProd) {
      throw new Error('CORS_ORIGIN must be an explicit allowlist in production (not *)');
    }
    // Dev convenience: reflect request origin
    return true;
  }
  return corsOrigin.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Which hops may set X-Forwarded-For (SEC-M2). Behind the gateway every request arrives from the gateway's address,
 * so req.ip (used by rate limits) would be the gateway for all clients. Trusting the forwarded address is only safe
 * for the gateway, so the default is loopback and the deployment names the gateway address with TRUST_PROXY.
 *   unset / ''         -> 'loopback' (local dev: gateway and services on one host)
 *   'false' or '0'     -> no forwarded address is trusted
 *   'true'             -> refused (trusting every hop lets clients spoof their IP); treated as loopback
 *   '10.0.0.5,10.0.0.0/24' -> that exact list of addresses or CIDR ranges
 */
function resolveTrustProxy(raw = process.env.TRUST_PROXY) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return 'loopback';
  if (value === 'false' || value === '0') return false;
  if (value === 'true') {
    console.warn('[createApp] TRUST_PROXY=true is refused (any client could spoof its IP); using loopback');
    return 'loopback';
  }
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
const STATUS_CODE = {
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE',
};

/**
 * SEC-M16: converts any thrown value into the client-facing error. Database text is never returned:
 * unique (23505) and foreign-key (23503) violations become 409 with a fixed message, every other database
 * or unexpected failure becomes a generic 500 and the detail is logged on the server only.
 * Errors that carry a 4xx status are deliberate messages from our code (AppError or a status-tagged Error), so they pass through.
 */
function toClientError(err, name) {
  if (err instanceof AppError) {
    if (err.status >= 500) {
      console.error(`[${name}]`, err);
      return new AppError('Internal server error', 500, 'INTERNAL_ERROR');
    }
    return err;
  }
  if (err && typeof err.code === 'string' && SQLSTATE.test(err.code)) {
    if (err.code === '23505') {
      console.error(`[${name}] unique violation`, err.detail || '');
      return new AppError('A record with this value already exists', 409, 'CONFLICT');
    }
    if (err.code === '23503') {
      console.error(`[${name}] foreign key violation`, err.detail || '');
      return new AppError('This change conflicts with a related record (it is missing or still in use)', 409, 'CONFLICT');
    }
    console.error(`[${name}] database error ${err.code}`, err);
    return new AppError('Internal server error', 500, 'INTERNAL_ERROR');
  }
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    const mapped = new AppError(err.message || 'Request failed', err.status, STATUS_CODE[err.status] || 'BAD_REQUEST');
    if (err.details !== undefined) mapped.details = err.details;
    return mapped;
  }
  console.error(`[${name}]`, err);
  return new AppError('Internal server error', 500, 'INTERNAL_ERROR');
}

function createApp(name) {
  const app = express();
  app.set('trust proxy', resolveTrustProxy());
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use(cors({ origin: resolveCorsOrigin(), credentials: true }));
  // strict: false lets the API accept scalar JSON bodies (true, false, "text", 3) used by blob writes, not only objects and arrays.
  app.use(express.json({
    strict: false,
    limit: '2mb',
    verify: (req, res, buf) => {
      // Webhooks that verify a signature need the exact request bytes (Stripe, marketplaces)
      if (req.originalUrl && (req.originalUrl.includes('/stripe/webhook') || req.originalUrl.includes('/engines/marketplaces/'))) {
        req.rawBody = Buffer.from(buf);
      }
    },
  }));
  app.use(morgan(process.env.LOG_FORMAT || 'dev'));
  app.get('/health', (req, res) => res.json({ ok: true, service: name }));

  // Express only routes errors to handlers registered AFTER the failing route. Services mount their
  // routes after createApp() returns, so the JSON error handler is attached just before listen().
  // Without this, route errors (403, 400, 500) reach the client as an HTML page instead of the JSON envelope.
  const errorHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);
    fail(res, toClientError(err, name));
  };
  const listen = app.listen.bind(app);
  app.listen = (...args) => {
    app.use(errorHandler);
    return listen(...args);
  };
  return app;
}

module.exports = { createApp, resolveTrustProxy, toClientError };
