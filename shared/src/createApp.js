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

function createApp(name) {
  const app = express();
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
  app.use(express.json({
    limit: '2mb',
    verify: (req, res, buf) => {
      // Stripe webhooks need the raw body for signature verification
      if (req.originalUrl && req.originalUrl.includes('/stripe/webhook')) {
        req.rawBody = Buffer.from(buf);
      }
    },
  }));
  app.use(morgan(process.env.LOG_FORMAT || 'dev'));
  app.get('/health', (req, res) => res.json({ ok: true, service: name }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (!(err instanceof AppError)) {
      console.error(`[${name}]`, err);
      err = new AppError(err.message || 'Internal error', 500, 'INTERNAL_ERROR');
    }
    fail(res, err);
  });
  return app;
}

module.exports = { createApp };
