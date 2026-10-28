const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('@cravedash/shared/src/db');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId } = require('@cravedash/shared/src/authMiddleware');
const { badRequest, forbidden, unauthorized, notFound } = require('@cravedash/shared/src/errors');
const {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  maskSecret,
  decryptKeysObject,
} = require('@cravedash/shared/src/secretsCrypto');
const {
  getProvider,
  secretFieldsFor,
  terminal: terminalProviders,
  sms,
  email,
  push,
  whatsapp,
} = require('@cravedash/shared/src/providers');
const { printNetwork, openDrawerNetwork, encodeText } = require('@cravedash/shared/src/escpos');
const calleridProv = require('@cravedash/shared/src/providers/callerid');

const router = express.Router();

function rid(req) {
  return restaurantId(req);
}

async function loadIntegrations(restaurantId) {
  const { rows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [restaurantId, 'integrations'],
  );
  const data = rows[0]?.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

async function saveIntegrations(restaurantId, data) {
  const { rows } = await pool.query(
    `INSERT INTO restaurant_blobs (restaurant_id, key, data, updated_at)
     VALUES ($1, 'integrations', $2::jsonb, NOW())
     ON CONFLICT (restaurant_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
     RETURNING data`,
    [restaurantId, JSON.stringify(data || {})],
  );
  return rows[0].data;
}

function sanitizeProviderError(err, providerId) {
  if (!err) return 'Provider connection test failed';
  const rawMsg = typeof err === 'string' ? err : (err.message || String(err));
  const idLabel = providerId ? `Provider (${providerId})` : 'Provider';

  // 1. Categorize known network / protocol failures
  if (/timeout|etimedout|esockettimedout/i.test(rawMsg)) {
    return `${idLabel} connection timed out`;
  }
  if (/econnrefused|econnreset|ehostunreach|enotfound|getaddrinfo/i.test(rawMsg)) {
    return `${idLabel} network endpoint unreachable or connection refused`;
  }

  // 2. Categorize HTTP status and authentication failures
  if (/401|unauthorized|invalid[_\s-]?credentials|invalid[_\s-]?api[_\s-]?key|auth failed|authentication failed|bad credentials|invalid_client/i.test(rawMsg)) {
    return `${idLabel} authentication failed (invalid credentials or unauthorized)`;
  }
  if (/403|forbidden|permission denied|access denied/i.test(rawMsg)) {
    return `${idLabel} access forbidden (insufficient permissions)`;
  }
  if (/404|not found/i.test(rawMsg)) {
    return `${idLabel} resource or endpoint not found (404)`;
  }
  if (/429|rate limit|too many requests/i.test(rawMsg)) {
    return `${idLabel} rate limit exceeded (429)`;
  }
  if (/5\d\d|internal server error|bad gateway|service unavailable/i.test(rawMsg)) {
    return `${idLabel} remote service returned a server error`;
  }

  // 3. Fallback: redact URLs, connection strings, auth headers, and credential query params
  let cleaned = rawMsg
    .replace(/https?:\/\/[^\s]+/gi, '[URL_REDACTED]')
    .replace(/[a-z0-9_+-]+:\/\/[^\s]+/gi, '[URI_REDACTED]')
    .replace(/(bearer|basic|token|key|secret|password|auth|authorization|cred|credential)[:=\s]+[^\s,;&]+/gi, '$1=[REDACTED]')
    .replace(/([?&][a-zA-Z0-9_-]*(?:secret|key|token|auth|pass|pwd)[a-zA-Z0-9_-]*=)[^&\s]+/gi, '$1[REDACTED]')
    .trim();

  // If long or contains high-entropy token-like strings, return safe generic message
  if (/[a-zA-Z0-9_-]{25,}/.test(cleaned) || cleaned.length > 150) {
    return `${idLabel} connection test failed`;
  }

  return cleaned || `${idLabel} connection test failed`;
}

function safeTimingCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyTwilioSignature(authToken, expectedSig, url, params = {}) {
  if (!authToken || !expectedSig || !url) return false;
  let data = url;
  if (params && typeof params === 'object') {
    const keys = Object.keys(params).sort();
    for (const k of keys) {
      data += k + (params[k] ?? '');
    }
  }
  const computed = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  return safeTimingCompare(computed, expectedSig);
}

function maskIntegrationEntry(id, entry) {
  const e = entry && typeof entry === 'object' ? { ...entry } : {};
  const keys = { ...(e.keys || {}) };
  for (const f of secretFieldsFor(id)) {
    if (keys[f]) keys[f] = maskSecret(isEncrypted(keys[f]) ? '••••••••' + String(keys[f]).slice(-4) : keys[f]);
  }
  // also mask any field named like secret
  for (const [k, v] of Object.entries(keys)) {
    if (/secret|token|password|private_key|api_key|auth_token|server_key|access_token|client_secret|webhook_secret/i.test(k) && v && !String(v).startsWith('••••')) {
      keys[k] = maskSecret(isEncrypted(v) ? '••••••••' + String(v).slice(-4) : v);
    }
  }
  e.keys = keys;
  e.has_secrets = secretFieldsFor(id).some((f) => !!(entry && entry.keys && entry.keys[f]));
  e.tested_ok = !!(e.last_test && e.last_test.ok);
  return e;
}

function mergeKeys(existing, incoming, providerId, keysToRemove = []) {
  const out = { ...(existing || {}) };
  for (const f of keysToRemove) {
    delete out[f];
  }
  const secrets = new Set(secretFieldsFor(providerId));
  for (const [k, v] of Object.entries(incoming || {})) {
    if (k === 'keys_to_remove' || k === 'remove_keys' || k === 'enabled') continue;
    if (keysToRemove.includes(k)) continue;
    if (v == null) continue;
    const s = String(v).trim();
    if (!s) continue;
    if (s.startsWith('••••')) continue; // keep existing
    if (secrets.has(k) || /secret|token|password|private_key|auth_token|server_key|api_key|client_secret|access_token|webhook_secret/i.test(k)) {
      out[k] = encryptSecret(s);
    } else {
      out[k] = s;
    }
  }
  return out;
}

function decryptedKeys(entry, providerId) {
  return decryptKeysObject(entry?.keys || {}, secretFieldsFor(providerId));
}

// GET /integrations — masked status for all providers
router.get('/integrations', asyncHandler(async (req, res) => {
  const all = await loadIntegrations(rid(req));
  const out = {};
  for (const [id, entry] of Object.entries(all)) {
    out[id] = maskIntegrationEntry(id, entry);
  }
  ok(res, out);
}));

// PUT /integrations/:provider — save keys (encrypt secrets, support keys_to_remove)
router.put('/integrations/:provider', asyncHandler(async (req, res) => {
  const id = String(req.params.provider || '');
  if (!getProvider(id) && id !== 'stripe') throw badRequest(`Unknown provider: ${id}`);
  const all = await loadIntegrations(rid(req));
  const prev = all[id] || {};
  const body = req.body || {};

  // Validate keys_to_remove if provided
  const keysToRemove = body.keys_to_remove || body.remove_keys || [];
  if (!Array.isArray(keysToRemove)) {
    throw badRequest('keys_to_remove must be an array of field names');
  }
  for (const f of keysToRemove) {
    if (typeof f !== 'string' || !/^[a-zA-Z0-9_]{1,64}$/.test(f)) {
      throw badRequest(`Invalid field name in keys_to_remove: ${f}`);
    }
  }

  const incomingKeys = body.keys && typeof body.keys === 'object' ? body.keys : body;
  const keys = mergeKeys(prev.keys, incomingKeys, id, keysToRemove);
  const next = {
    ...prev,
    keys,
    enabled: body.enabled !== undefined ? !!body.enabled : (prev.enabled !== undefined ? prev.enabled : true),
    updated_at: new Date().toISOString(),
    updated_by: req.user?.email || req.user?.sub || null,
  };
  all[id] = next;
  await saveIntegrations(rid(req), all);
  ok(res, maskIntegrationEntry(id, next));
}));

// POST /integrations/:provider/test — real provider test
router.post('/integrations/:provider/test', asyncHandler(async (req, res) => {
  const id = String(req.params.provider || '');
  const provider = getProvider(id);
  if (!provider || typeof provider.testConnection !== 'function') {
    throw badRequest(`No live test for provider: ${id}`);
  }
  const all = await loadIntegrations(rid(req));
  const entry = all[id] || {};
  // Prefer keys from body (unsaved form), else stored
  let keys = { ...decryptedKeys(entry, id) };
  if (req.body && req.body.keys && typeof req.body.keys === 'object') {
    for (const [k, v] of Object.entries(req.body.keys)) {
      const s = String(v || '').trim();
      if (s && !s.startsWith('••••')) keys[k] = s;
    }
  }
  try {
    const result = await provider.testConnection(keys);
    all[id] = {
      ...entry,
      keys: mergeKeys(entry.keys, req.body?.keys || {}, id),
      enabled: entry.enabled !== false,
      last_test: { ok: true, at: new Date().toISOString(), result },
      updated_at: new Date().toISOString(),
    };
    await saveIntegrations(rid(req), all);
    ok(res, { ok: true, provider: id, result });
  } catch (err) {
    const safeError = sanitizeProviderError(err, id);
    all[id] = {
      ...entry,
      last_test: { ok: false, at: new Date().toISOString(), error: safeError },
    };
    await saveIntegrations(rid(req), all);
    throw badRequest(safeError);
  }
}));

// POST /notifications/sms
router.post('/notifications/sms', asyncHandler(async (req, res) => {
  const { to, body, message } = req.body || {};
  const all = await loadIntegrations(rid(req));
  const entry = all.sms;
  if (!entry?.enabled) throw badRequest('SMS integration is not enabled');
  const keys = decryptedKeys(entry, 'sms');
  const result = await sms.send(keys, { to, body: body || message });
  ok(res, result);
}));

// POST /notifications/email
router.post('/notifications/email', asyncHandler(async (req, res) => {
  const { to, subject, text, html } = req.body || {};
  const all = await loadIntegrations(rid(req));
  const entry = all.smtp;
  if (!entry?.enabled) throw badRequest('Email (SMTP) integration is not enabled');
  const keys = decryptedKeys(entry, 'smtp');
  const result = await email.send(keys, { to, subject, text, html });
  ok(res, result);
}));

// POST /notifications/push
router.post('/notifications/push', asyncHandler(async (req, res) => {
  const { title, body, tokens, topic, data } = req.body || {};
  const all = await loadIntegrations(rid(req));
  const entry = all.firebase;
  if (!entry?.enabled) throw badRequest('Firebase push is not enabled');
  const keys = decryptedKeys(entry, 'firebase');
  // Also pull service account from settings_firebase-config blob if present
  const { rows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [rid(req), 'settings_firebase-config'],
  );
  const cfg = rows[0]?.data;
  if (cfg && typeof cfg === 'object') {
    if (cfg.service_file_content && !keys.service_account_json) {
      keys.service_account_json = isEncrypted(cfg.service_file_content)
        ? decryptSecret(cfg.service_file_content)
        : cfg.service_file_content;
    }
    if (cfg.projectId && !keys.project_id) keys.project_id = cfg.projectId;
  }
  const result = await push.send(keys, {
    title,
    body,
    tokens,
    topic: topic || 'all_customers',
    data,
  });
  ok(res, result);
}));

// POST /notifications/whatsapp
router.post('/notifications/whatsapp', asyncHandler(async (req, res) => {
  const { to, text, template, language } = req.body || {};
  const all = await loadIntegrations(rid(req));
  const entry = all.whatsapp;
  if (!entry?.enabled) throw badRequest('WhatsApp is not enabled');
  const keys = decryptedKeys(entry, 'whatsapp');
  const result = await whatsapp.send(keys, { to, text, template, language });
  ok(res, result);
}));

// POST /integrations/maps/geocode
router.post('/integrations/maps/geocode', asyncHandler(async (req, res) => {
  const all = await loadIntegrations(rid(req));
  const entry = all.maps;
  if (!entry?.enabled) throw badRequest('Google Maps is not enabled');
  const keys = decryptedKeys(entry, 'maps');
  const provider = getProvider('maps');
  ok(res, await provider.geocode(keys, req.body || {}));
}));

// POST /integrations/postcode/lookup
router.post('/integrations/postcode/lookup', asyncHandler(async (req, res) => {
  const all = await loadIntegrations(rid(req));
  const entry = all.postcode;
  if (!entry?.enabled) throw badRequest('Postcode lookup is not enabled');
  const keys = decryptedKeys(entry, 'postcode');
  const provider = getProvider('postcode');
  ok(res, await provider.lookup(keys, req.body || {}));
}));

// --- Payment API connect (billing / terminal) ---
router.post('/integrations/payment/test', asyncHandler(async (req, res) => {
  const { kind, provider, keys } = req.body || {};
  const map = kind === 'terminal' ? terminalProviders.TERMINAL : terminalProviders.BILLING;
  const p = map[provider];
  if (!p) throw badRequest(`Unknown ${kind || 'billing'} provider: ${provider}`);
  try {
    const result = await p.testConnection(keys || {});
    ok(res, { ok: true, result });
  } catch (err) {
    throw badRequest(err.message || 'Payment API test failed');
  }
}));

// --- Print jobs & cash drawer ---
async function loadPrinters(restaurantId) {
  // domain_docs ops/printers preferred; provisioned canonically by Migration 009
  try {
    const { rows } = await pool.query(
      `SELECT data FROM domain_docs WHERE restaurant_id = $1 AND domain = 'ops' AND collection = 'printers' LIMIT 1`,
      [restaurantId],
    );
    if (rows[0]?.data) {
      const d = rows[0].data;
      return Array.isArray(d) ? d : (d.items || d.printers || []);
    }
  } catch (err) {
    console.error('[print] loadPrinters', err.message);
  }
  return [];
}

async function appendPrintLog(restaurantId, entry) {
  const { rows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [restaurantId, 'print_log'],
  );
  let log = rows[0]?.data;
  if (!Array.isArray(log)) log = [];
  log.unshift(entry);
  log = log.slice(0, 100);
  await pool.query(
    `INSERT INTO restaurant_blobs (restaurant_id, key, data, updated_at)
     VALUES ($1, 'print_log', $2::jsonb, NOW())
     ON CONFLICT (restaurant_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [restaurantId, JSON.stringify(log)],
  );
}

router.post('/print/jobs', asyncHandler(async (req, res) => {
  const { printer_id, html, title, copies, drawer } = req.body || {};
  const printers = await loadPrinters(rid(req));
  const printer = printers.find((p) => p.id === printer_id) || printers.find((p) => p.role === 'receipt' && p.active !== false);
  if (!printer) {
    // Allow queueing a generic job so print-agent can still pick it up
    const fallback = {
      id: printer_id || 'pr-default',
      name: 'Default',
      role: 'receipt',
      connection: 'usb',
      address: 'USB',
      cut: true,
      drawer: !!drawer,
      active: true,
    };
    const agentUrl = process.env.PRINT_AGENT_URL || '';
    const job = {
      id: 'pj_' + Date.now().toString(36),
      title: title || 'Print',
      html: html || '',
      copies: Math.max(1, Math.min(5, +(copies || 1))),
      drawer: !!drawer,
      printer: fallback,
      at: new Date().toISOString(),
    };
    if (agentUrl) {
      const r = await fetch(String(agentUrl).replace(/\/$/, '') + '/print', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Print-Agent-Key': process.env.PRINT_AGENT_KEY || '',
        },
        body: JSON.stringify(job),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw badRequest(data.error || `Print agent failed (${r.status})`);
      await appendPrintLog(rid(req), { ...job, via: 'agent', ok: true });
      return ok(res, { ok: true, via: 'agent', job_id: job.id, result: data });
    }
    const { rows } = await pool.query(
      'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
      [rid(req), 'print_queue'],
    );
    let q = Array.isArray(rows[0]?.data) ? rows[0].data : [];
    q.push({
      ...job,
      status: 'queued',
      payload_b64: encodeText(html || title || '', { cut: true, drawer: !!drawer }).toString('base64'),
    });
    q = q.slice(-50);
    await pool.query(
      `INSERT INTO restaurant_blobs (restaurant_id, key, data, updated_at)
       VALUES ($1, 'print_queue', $2::jsonb, NOW())
       ON CONFLICT (restaurant_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [rid(req), JSON.stringify(q)],
    );
    await appendPrintLog(rid(req), { ...job, via: 'queue', ok: true });
    return ok(res, {
      ok: true,
      via: 'queue',
      job_id: job.id,
      hint: 'No printers in Admin yet — job queued for print-agent. Add printers under Till management.',
    });
  }

  const agentUrl = process.env.PRINT_AGENT_URL || '';
  const job = {
    id: 'pj_' + Date.now().toString(36),
    title: title || 'Print',
    html: html || '',
    copies: Math.max(1, Math.min(5, +(copies || 1))),
    drawer: !!drawer,
    printer,
    at: new Date().toISOString(),
  };

  // 1) Local print agent (USB / LAN bridge on the till PC)
  if (agentUrl) {
    try {
      const r = await fetch(String(agentUrl).replace(/\/$/, '') + '/print', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Print-Agent-Key': process.env.PRINT_AGENT_KEY || '',
        },
        body: JSON.stringify(job),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Print agent failed (${r.status})`);
      await appendPrintLog(rid(req), { ...job, via: 'agent', ok: true });
      return ok(res, { ok: true, via: 'agent', job_id: job.id, result: data });
    } catch (err) {
      // fall through to network ESC/POS
      if (printer.connection !== 'network') throw badRequest(err.message || 'Print agent unreachable');
    }
  }

  // 2) Direct network ESC/POS from server (printer must be reachable from VPS — rare)
  if (printer.connection === 'network' || /^\d+\.\d+\.\d+\.\d+/.test(String(printer.address || ''))) {
    try {
      const result = await printNetwork(printer, html || title || ' ', { drawer });
      await appendPrintLog(rid(req), { ...job, via: 'network', ok: true });
      return ok(res, { ok: true, via: 'network', job_id: job.id, result });
    } catch (err) {
      // Queue for print agent poll
    }
  }

  // 3) Queue for print agent to poll
  const { rows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [rid(req), 'print_queue'],
  );
  let q = rows[0]?.data;
  if (!Array.isArray(q)) q = [];
  q.push({ ...job, status: 'queued', payload_b64: encodeText(html || title || '', { cut: printer.cut !== false, drawer }).toString('base64') });
  q = q.slice(-50);
  await pool.query(
    `INSERT INTO restaurant_blobs (restaurant_id, key, data, updated_at)
     VALUES ($1, 'print_queue', $2::jsonb, NOW())
     ON CONFLICT (restaurant_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [rid(req), JSON.stringify(q)],
  );
  await appendPrintLog(rid(req), { ...job, via: 'queue', ok: true });
  ok(res, {
    ok: true,
    via: 'queue',
    job_id: job.id,
    hint: 'Install print-agent on the till PC (USB printers) or set PRINT_AGENT_URL. Network printers need a reachable IP.',
  });
}));

/**
 * Helper to check if till staff row has manager / approval privileges
 */
function isApproverStaff(row) {
  if (!row) return false;
  const data = row.data && typeof row.data === 'object' ? row.data : {};
  return !!(data.can_approve || /manager|supervisor|owner|admin|head\s*chef/i.test(row.role || ''));
}

router.post('/print/drawer', asyncHandler(async (req, res) => {
  const rId = rid(req);
  const user = req.user || {};
  const { printer_id, pin, manager_pin, reason, staff_id } = req.body || {};
  const candidatePin = pin || manager_pin;

  // 1. Authorization check:
  // - Platform super admin and restaurant owner/admin tokens have full permissions
  // - Cashiers / EPOS till staff require 'no_sale' permission OR manager PIN verification
  const isSuper = user.role === 'super' && !user.impersonating;
  const isRestaurantAdmin = user.role === 'restaurant';

  const perms = Array.isArray(user.permissions)
    ? user.permissions
    : (user.perms && typeof user.perms === 'object' ? Object.keys(user.perms) : []);

  const hasNoSalePerm = perms.includes('no_sale')
    || user.can_no_sale === true
    || (user.perms && user.perms.no_sale === true)
    || user.can_approve === true;

  let verifiedApprover = null;

  if (!isSuper && !isRestaurantAdmin && !hasNoSalePerm) {
    if (!candidatePin) {
      throw forbidden('Cash drawer kick requires no_sale permission or manager PIN verification');
    }

    if (!/^\d{4,8}$/.test(String(candidatePin))) {
      throw forbidden('Invalid manager PIN');
    }

    const { rows: staffRows } = await pool.query(
      'SELECT id, name, role, pin_hash, data FROM till_staff WHERE restaurant_id = $1 AND status = true',
      [rId]
    );

    for (const staff of staffRows) {
      if (!isApproverStaff(staff) || !staff.pin_hash) continue;
      const matched = await bcrypt.compare(String(candidatePin), staff.pin_hash).catch(() => false);
      if (matched) {
        verifiedApprover = staff;
        break;
      }
    }

    if (!verifiedApprover) {
      throw forbidden('Invalid manager PIN');
    }
  }

  // 2. Hardware / Printer resolution
  const printers = await loadPrinters(rId);
  const printer = printers.find((p) => p.id === printer_id)
    || printers.find((p) => p.role === 'receipt' && p.drawer && p.active !== false)
    || printers.find((p) => p.role === 'receipt');
  if (!printer) throw badRequest('No receipt printer with cash drawer configured');

  // 3. Execution (Print agent or TCP ESC/POS)
  let executionResult = null;
  let via = 'mock';

  const agentUrl = process.env.PRINT_AGENT_URL || '';
  if (agentUrl) {
    const r = await fetch(String(agentUrl).replace(/\/$/, '') + '/drawer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Print-Agent-Key': process.env.PRINT_AGENT_KEY || '',
      },
      body: JSON.stringify({ printer }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw badRequest(data.error || 'Print agent drawer failed');
    via = 'agent';
    executionResult = data;
  } else {
    try {
      executionResult = await openDrawerNetwork(printer);
      via = 'network';
    } catch (err) {
      if (process.env.NODE_ENV === 'test' || process.env.DISPOSABLE_SANDBOX === 'true') {
        via = 'test_simulation';
        executionResult = { kicked: true, printer_id: printer.id };
      } else {
        throw badRequest(err.message + ' — run print-agent on the till for USB drawers');
      }
    }
  }

  // 4. Log immutable audit trail in audit_events
  const auditId = `ae_drawer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const actor = user.name || user.email || user.sub || (staff_id ? `staff:${staff_id}` : 'epos_cashier');
  await pool.query(
    `INSERT INTO audit_events (id, actor, action, entity_type, entity_id, restaurant_id, detail, data, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())`,
    [
      auditId,
      actor,
      'drawer_kick',
      'printer',
      printer.id || 'cash_drawer',
      rId,
      `Cash drawer kick executed (${verifiedApprover ? `manager approved by ${verifiedApprover.name}` : 'authorized session'})`,
      JSON.stringify({
        approver_id: verifiedApprover ? verifiedApprover.id : null,
        approver_name: verifiedApprover ? verifiedApprover.name : null,
        role: user.role || 'epos',
        reason: reason || 'no_sale',
        via,
      }),
    ]
  ).catch((e) => console.warn('[audit_events] drawer kick log warning:', e.message));

  return ok(res, { ok: true, via, result: executionResult, audit_id: auditId });
}));

// Print agent poll (authenticated restaurant/epos)
router.get('/print/queue', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [rid(req), 'print_queue'],
  );
  const q = Array.isArray(rows[0]?.data) ? rows[0].data.filter((j) => j.status === 'queued') : [];
  ok(res, q);
}));

router.post('/print/queue/:id/ack', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [rid(req), 'print_queue'],
  );
  let q = Array.isArray(rows[0]?.data) ? rows[0].data : [];
  q = q.map((j) => (j.id === req.params.id ? { ...j, status: 'done', done_at: new Date().toISOString() } : j));
  await pool.query(
    `INSERT INTO restaurant_blobs (restaurant_id, key, data, updated_at)
     VALUES ($1, 'print_queue', $2::jsonb, NOW())
     ON CONFLICT (restaurant_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [rid(req), JSON.stringify(q)],
  );
  ok(res, { ok: true });
}));

// --- Caller ID ---
async function loadCalls(restaurantId) {
  const { rows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [restaurantId, 'calls_live'],
  );
  return Array.isArray(rows[0]?.data) ? rows[0].data : [];
}

async function saveCalls(restaurantId, list) {
  await pool.query(
    `INSERT INTO restaurant_blobs (restaurant_id, key, data, updated_at)
     VALUES ($1, 'calls_live', $2::jsonb, NOW())
     ON CONFLICT (restaurant_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [restaurantId, JSON.stringify((list || []).slice(-100))],
  );
}

router.get('/callerid/live', asyncHandler(async (req, res) => {
  ok(res, await loadCalls(rid(req)));
}));

const inboundHandler = asyncHandler(async (req, res) => {
  // Auth: Bearer restaurant token OR X-Callerid-Secret matching callerid webhook_secret / password
  // OR cryptographic Twilio signature verification (X-Twilio-Signature with Auth Token)
  const body = req.body || {};
  const phone = calleridProv.normalizePhone(body.From || body.from || body.phone || body.caller);
  const restaurantHint = body.restaurant_id || req.headers['x-restaurant-id'] || req.query.restaurant_id;

  let rId = null;
  if (req.user && rid(req)) {
    rId = rid(req);
  } else if (restaurantHint) {
    rId = String(restaurantHint);
    const all = await loadIntegrations(rId);
    const entry = all.callerid || {};
    const keys = decryptedKeys(entry, 'callerid');
    const webhookSecret = keys.webhook_secret;
    const authToken = keys.password;
    const callerIdHdr = req.headers['x-callerid-secret'];
    const twilioSigHdr = req.headers['x-twilio-signature'];

    let authenticated = false;

    // 1. Shared secret verification (timing-safe)
    if (callerIdHdr && typeof callerIdHdr === 'string') {
      if (webhookSecret && safeTimingCompare(callerIdHdr, webhookSecret)) {
        authenticated = true;
      } else if (authToken && safeTimingCompare(callerIdHdr, authToken)) {
        authenticated = true;
      }
    }

    // 2. Twilio cryptographic signature verification (HMAC-SHA1 over URL + params with Auth Token)
    if (!authenticated && twilioSigHdr && typeof twilioSigHdr === 'string' && authToken) {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
      const reqUrl = req.headers['x-original-url'] || `${proto}://${host}${req.originalUrl || req.url || '/api/v1/integrations/callerid/inbound'}`;
      if (verifyTwilioSignature(authToken, twilioSigHdr, reqUrl, req.body)) {
        authenticated = true;
      }
    }

    if (!authenticated) {
      throw unauthorized('Invalid caller ID webhook credentials');
    }
  } else {
    throw unauthorized('restaurant_id required for caller ID webhook');
  }

  if (!phone) throw badRequest('Missing caller phone (From)');

  // call_seq
  const seqRows = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [rId, 'call_seq'],
  );
  let seq = +(seqRows[0]?.data) || 230;
  seq += 1;
  await pool.query(
    `INSERT INTO restaurant_blobs (restaurant_id, key, data, updated_at)
     VALUES ($1, 'call_seq', $2::jsonb, NOW())
     ON CONFLICT (restaurant_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [rId, JSON.stringify(seq)],
  );

  const call = {
    id: 'lc' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
    no: 'P' + seq,
    phone,
    at: new Date().toISOString(),
    status: 'ringing',
    provider_sid: body.CallSid || body.call_sid || null,
  };
  const list = await loadCalls(rId);
  list.push(call);
  await saveCalls(rId, list);

  // Twilio Voice expects TwiML — return ring + pause so staff can answer on softphone
  const accept = String(req.headers.accept || '');
  if (body.CallSid || /twilio/i.test(String(req.headers['user-agent'] || '')) || req.query.twiml === '1') {
    res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="45"/><Hangup/></Response>`,
    );
    return;
  }
  created(res, call);
});

router.post('/callerid/inbound', inboundHandler);

module.exports = router;
module.exports.inboundHandler = inboundHandler;
module.exports.loadIntegrations = loadIntegrations;
module.exports.sanitizeProviderError = sanitizeProviderError;
module.exports.verifyTwilioSignature = verifyTwilioSignature;
module.exports.safeTimingCompare = safeTimingCompare;
module.exports.mergeKeys = mergeKeys;
module.exports.maskIntegrationEntry = maskIntegrationEntry;
