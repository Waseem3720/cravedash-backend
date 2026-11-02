const express = require('express');
const crypto = require('crypto');
const pool = require('@cravedash/shared/src/db');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, tillId, branchId } = require('@cravedash/shared/src/authMiddleware');
const { badRequest, forbidden, unauthorized, notFound } = require('@cravedash/shared/src/errors');
const {
  encryptSecret,
  decryptSecret,
  isEncrypted,
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

/** Placeholder for any stored secret. It is the same length for every value, so no part of a secret is shown (SEC-M19). */
const REDACTED = '••••••••';
const SECRET_KEY_RE = /secret|token|password|private_key|api_key|auth_token|server_key/i;

/**
 * Integration entry as shown in any response. Every key that is a known secret field or secret-like by name is replaced
 * by a fixed placeholder (no tail of the value), and the raw provider test result is dropped. The error text of a
 * failed test is kept, since it is needed to fix the connection.
 */
function maskIntegrationEntry(id, entry) {
  const e = entry && typeof entry === 'object' ? { ...entry } : {};
  const secretNames = new Set(secretFieldsFor(id));
  const keys = {};
  for (const [k, v] of Object.entries(e.keys || {})) {
    const isSecret = secretNames.has(k) || SECRET_KEY_RE.test(k);
    keys[k] = isSecret ? (v ? REDACTED : '') : v;
  }
  e.keys = keys;
  e.has_secrets = secretFieldsFor(id).some((f) => !!(entry && entry.keys && entry.keys[f]));
  if (e.last_test && typeof e.last_test === 'object') {
    const { result, ...lastTest } = e.last_test;
    e.last_test = lastTest;
  }
  e.tested_ok = !!(e.last_test && e.last_test.ok);
  return e;
}

function mergeKeys(existing, incoming, providerId) {
  const out = { ...(existing || {}) };
  const secrets = new Set(secretFieldsFor(providerId));
  for (const [k, v] of Object.entries(incoming || {})) {
    if (v == null) continue;
    const s = String(v).trim();
    if (!s) continue;
    if (s.startsWith('••••')) continue; // keep existing
    if (secrets.has(k) || /secret|token|password|private_key|auth_token|server_key/i.test(k)) {
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
  // Admin only: the till (EPOS) session never reads integration settings (SEC-M19).
  requireIntegrationAdmin(req);
  const all = await loadIntegrations(rid(req));
  const out = {};
  for (const [id, entry] of Object.entries(all)) {
    out[id] = maskIntegrationEntry(id, entry);
  }
  ok(res, out);
}));

/**
 * Integration credentials, settings and provider tests: restaurant admin or super only (decision D2).
 * Enforced here, not only by the EPOS guard, so a route cannot be opened by changing the guard.
 */
function requireIntegrationAdmin(req) {
  const role = req.user?.role;
  // P1: a branch login (branch_id set on the account) must not read or change restaurant-wide credentials.
  // An owner viewing a branch (X-Branch-Context also sets branch_id) is refused here too, because these settings are restaurant-wide.
  if ((role !== 'restaurant' && role !== 'super') || req.user?.till_id || req.user?.branch_id) {
    throw forbidden('Only a restaurant administrator can view or change integration settings');
  }
}

// PUT /integrations/:provider — save keys (encrypt secrets)
router.put('/integrations/:provider', asyncHandler(async (req, res) => {
  requireIntegrationAdmin(req);
  const id = String(req.params.provider || '');
  if (!getProvider(id) && id !== 'stripe') throw badRequest(`Unknown provider: ${id}`);
  const all = await loadIntegrations(rid(req));
  const prev = all[id] || {};
  const body = req.body || {};
  // clear_keys removes every saved key (Remove keys); otherwise the keys are merged and empty values are kept.
  const keys = body.clear_keys ? {} : mergeKeys(prev.keys, body.keys || body, id);
  const next = {
    ...prev,
    keys,
    enabled: body.enabled !== undefined ? !!body.enabled : true,
    updated_at: new Date().toISOString(),
    updated_by: req.user?.email || req.user?.sub || null,
  };
  all[id] = next;
  await saveIntegrations(rid(req), all);
  ok(res, maskIntegrationEntry(id, next));
}));

// POST /integrations/:provider/test — real provider test
router.post('/integrations/:provider/test', asyncHandler(async (req, res, next) => {
  // 'payment' has its own route below; let it through so that route answers (FE-H5).
  if (req.params.provider === 'payment') return next();
  requireIntegrationAdmin(req);
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
    all[id] = {
      ...entry,
      last_test: { ok: false, at: new Date().toISOString(), error: err.message },
    };
    await saveIntegrations(rid(req), all);
    throw badRequest(err.message || 'Connection test failed');
  }
}));

// POST /notifications/sms
router.post('/notifications/sms', asyncHandler(async (req, res) => {
  requireIntegrationAdmin(req);
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
  requireIntegrationAdmin(req);
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
  requireIntegrationAdmin(req);
  const { title, body, tokens, topic, data } = req.body || {};
  const all = await loadIntegrations(rid(req));
  const entry = all.firebase;
  if (!entry?.enabled) throw badRequest('Firebase push is not enabled');
  const keys = decryptedKeys(entry, 'firebase');
  // Service account lives in the Firebase settings blob. Blob keys use underscores (the API rejects hyphens),
  // so the canonical key is settings_firebase_config; the legacy hyphenated key is still read as a fallback.
  const { rows } = await pool.query(
    'SELECT key, data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = ANY($2::text[]) ORDER BY key = $3 DESC LIMIT 1',
    [rid(req), ['settings_firebase_config', 'settings_firebase-config'], 'settings_firebase_config'],
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
  requireIntegrationAdmin(req);
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
  requireIntegrationAdmin(req);
  const all = await loadIntegrations(rid(req));
  const entry = all.maps;
  if (!entry?.enabled) throw badRequest('Google Maps is not enabled');
  const keys = decryptedKeys(entry, 'maps');
  const provider = getProvider('maps');
  ok(res, await provider.geocode(keys, req.body || {}));
}));

// POST /integrations/postcode/lookup
router.post('/integrations/postcode/lookup', asyncHandler(async (req, res) => {
  requireIntegrationAdmin(req);
  const all = await loadIntegrations(rid(req));
  const entry = all.postcode;
  if (!entry?.enabled) throw badRequest('Postcode lookup is not enabled');
  const keys = decryptedKeys(entry, 'postcode');
  const provider = getProvider('postcode');
  ok(res, await provider.lookup(keys, req.body || {}));
}));

// --- Payment API connect (billing / terminal) ---
router.post('/integrations/payment/test', asyncHandler(async (req, res) => {
  requireIntegrationAdmin(req);
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
async function loadPrinters(restaurantId, branch = null) {
  if (branch) {
    // A branch prints on its own printers only (the branch's ops/printers copy).
    const { rows } = await pool.query(
      'SELECT data FROM branch_settings WHERE restaurant_id = $1 AND branch_id = $2 AND key = $3',
      [restaurantId, branch, 'dom:ops:printers'],
    );
    const d = rows[0]?.data;
    return Array.isArray(d) ? d : (d?.items || d?.printers || []);
  }
  // domain_docs ops/printers preferred. The table is created by scripts/init-db.sql (migrate), not here.
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

/** The branch a print job belongs to: the caller's own branch, or NULL for the restaurant. */
function printBranch(req) {
  return branchId(req) || null;
}

async function appendPrintLog(restaurantId, entry, branch = null) {
  const { rows } = branch
    ? await pool.query('SELECT data FROM branch_settings WHERE restaurant_id = $1 AND branch_id = $2 AND key = $3', [restaurantId, branch, 'print_log'])
    : await pool.query('SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2', [restaurantId, 'print_log']);
  let log = rows[0]?.data;
  if (!Array.isArray(log)) log = [];
  log.unshift(entry);
  log = log.slice(0, 100);
  if (branch) {
    await pool.query(
      `INSERT INTO branch_settings (restaurant_id, branch_id, key, data, updated_at)
       VALUES ($1, $2, 'print_log', $3::jsonb, NOW())
       ON CONFLICT (restaurant_id, branch_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [restaurantId, branch, JSON.stringify(log)],
    );
    return;
  }
  await pool.query(
    `INSERT INTO restaurant_blobs (restaurant_id, key, data, updated_at)
     VALUES ($1, 'print_log', $2::jsonb, NOW())
     ON CONFLICT (restaurant_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [restaurantId, JSON.stringify(log)],
  );
}

/** Print queue rows (SEC-M17). The print_jobs table is created by scripts/init-db.sql, not here. */
async function enqueuePrintJob(restaurantId, job, payloadB64, branch = null) {
  await pool.query(
    `INSERT INTO print_jobs (id, restaurant_id, status, payload, payload_b64, branch_id) VALUES ($1, $2, 'queued', $3::jsonb, $4, $5)`,
    [job.id, restaurantId, JSON.stringify(job), payloadB64, branch],
  );
}

/** Private LAN IPv4 addresses for network printers (SEC-M17). Loopback is 127.0.0.1 only. */
const PRIVATE_LAN_RE = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
];

/** Host part of a printer address (the port, if any, is dropped). */
function printerHost(address) {
  return String(address || '').trim().replace(/:\d+$/, '');
}

function looksLikeIpv4(host) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return host.split('.').every((octet) => Number(octet) <= 255);
}

function isLanPrinterAddress(address) {
  const host = printerHost(address);
  if (!looksLikeIpv4(host)) return false;
  if (host === '127.0.0.1') return true;
  return PRIVATE_LAN_RE.some((re) => re.test(host) && looksLikeIpv4(host));
}

function isNetworkPrinter(printer) {
  return !!printer && (printer.connection === 'network' || looksLikeIpv4(printerHost(printer.address)));
}

/** Addresses the super admin has explicitly allowed for network printers outside the LAN (SEC-M17). */
async function printerAllowlist(restaurantId) {
  const { rows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [restaurantId, 'printer_allowlist'],
  );
  return Array.isArray(rows[0]?.data) ? rows[0].data.map((a) => printerHost(a)) : [];
}

/**
 * A network printer address must be a private LAN address, unless the super admin has allowed that exact address.
 * Anything else (public address, hostname) is refused before a job or a drawer kick is sent.
 */
async function assertPrinterAddress(req, printer) {
  if (!isNetworkPrinter(printer)) return;
  if (isLanPrinterAddress(printer.address)) return;
  const allowed = await printerAllowlist(rid(req));
  if (looksLikeIpv4(printerHost(printer.address)) && allowed.includes(printerHost(printer.address))) return;
  throw forbidden('Network printer address must be on the LAN, or allowed by the super admin');
}

/** Atomic per-restaurant call number (SEC-M17). Continues from the legacy call_seq value on first use. */
async function nextCallNumber(restaurantId) {
  const seqRows = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [restaurantId, 'call_seq'],
  );
  const seed = (+(seqRows.rows[0]?.data) || 230) + 1;
  const { rows } = await pool.query(
    `INSERT INTO call_counters (restaurant_id, last_no) VALUES ($1, $2)
     ON CONFLICT (restaurant_id) DO UPDATE SET last_no = call_counters.last_no + 1
     RETURNING last_no`,
    [restaurantId, seed],
  );
  return Number(rows[0].last_no);
}

router.post('/print/jobs', asyncHandler(async (req, res) => {
  const { printer_id, html, title, copies, drawer } = req.body || {};
  // A job that opens the drawer goes through the same policy and audit as /print/drawer (SEC-H12).
  if (drawer) {
    await assertDrawerAllowed(req, req.body || {});
    await auditDrawerOpen(req, req.body || {}, printer_id);
  }
  const printers = await loadPrinters(rid(req), printBranch(req));
  const found = printers.find((p) => p.id === printer_id) || printers.find((p) => p.role === 'receipt' && p.active !== false);
  // SEC-M15: there is no fake default printer. With no printer the job is queued unassigned (it is never reported as
  // printed), and the queue keeps it until a printer is set up for it.
  const printer = found || { id: printer_id || null, connection: 'none', cut: true };
  if (found) await assertPrinterAddress(req, printer);

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
  if (agentUrl && found) {
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
      await appendPrintLog(rid(req), { ...job, via: 'agent', ok: true }, printBranch(req));
      return ok(res, { ok: true, via: 'agent', job_id: job.id, result: data });
    } catch (err) {
      if (printer.connection !== 'network') {
        console.error(`[print] agent failed: job=${job.id} error=${err.message}`);
        throw badRequest(err.message || 'Print agent unreachable');
      }
      // A network printer falls through to direct ESC/POS below.
      console.error(`[print] agent failed for network printer, trying direct: job=${job.id} error=${err.message}`);
    }
  }

  // 2) Direct network ESC/POS from the server. A failure is logged and reported; it is not queued as printed (SEC-M15).
  if (isNetworkPrinter(printer)) {
    try {
      const result = await printNetwork(printer, html || title || ' ', { drawer });
      await appendPrintLog(rid(req), { ...job, via: 'network', ok: true }, printBranch(req));
      return ok(res, { ok: true, via: 'network', job_id: job.id, result });
    } catch (err) {
      console.error(`[print] network print failed: job=${job.id} printer=${printer.id} error=${err.message}`);
      await appendPrintLog(rid(req), { ...job, via: 'network', ok: false, error: String(err.message || '').slice(0, 200) }, printBranch(req)).catch(() => {});
      throw badRequest(`Network printer did not accept the job: ${err.message || 'connection failed'}`);
    }
  }

  // 3) Queue for the print agent to claim (also the path for a job with no printer set up yet)
  await enqueuePrintJob(rid(req), { ...job, status: 'queued' }, encodeText(html || title || '', { cut: printer.cut !== false, drawer }).toString('base64'), printBranch(req));
  await appendPrintLog(rid(req), { ...job, via: 'queue', ok: true }, printBranch(req));
  ok(res, {
    ok: true,
    via: 'queue',
    job_id: job.id,
    printer_id: printer.id,
    status: 'queued',
    hint: found
      ? 'Install print-agent on the till PC (USB printers) or set PRINT_AGENT_URL. Network printers need a reachable IP.'
      : 'No printer is set up for this job yet. It is queued and will print once a printer is added under Till management.',
  });
}));

/** Super admin only: the printer addresses allowed outside the LAN (SEC-M17). */
router.put('/print/allowlist', asyncHandler(async (req, res) => {
  if (req.user?.role !== 'super') throw forbidden('Only the super admin can change the printer address allow-list');
  const input = (req.body || {}).addresses;
  if (!Array.isArray(input)) throw badRequest('addresses must be an array of IPv4 addresses');
  const list = input.map((a) => printerHost(a)).filter((a) => looksLikeIpv4(a));
  if (list.length !== input.length) throw badRequest('Every entry must be an IPv4 address');
  await pool.query(
    `INSERT INTO restaurant_blobs (restaurant_id, key, data, updated_at)
     VALUES ($1, 'printer_allowlist', $2::jsonb, NOW())
     ON CONFLICT (restaurant_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [rid(req), JSON.stringify(list.slice(0, 50))],
  );
  ok(res, { addresses: list.slice(0, 50) });
}));

/**
 * Cash drawer (SEC-H12). Opens only from a till session or an admin session. A "no sale" open needs the PIN of a
 * restaurant manager (can_approve). Every open is written to the audit log first, and if that write fails the drawer stays shut.
 */
async function assertDrawerAllowed(req, body) {
  if (!tillId(req) && req.user?.role !== 'restaurant' && req.user?.role !== 'super') {
    throw forbidden('The cash drawer opens only from a till or an admin session');
  }
  if (String(body.reason || '') === 'no_sale') {
    // A single-use manager approval from the PIN verify route (drawer_no_sale). Consumed here, so it opens the drawer once.
    const token = String(body.approval_token || '');
    if (!token) throw forbidden('A manager approval is required to open the drawer for no sale');
    const { rows } = await pool.query(
      `UPDATE z_approvals SET status = 'consumed', consumed_at = NOW()
        WHERE token_hash = $1 AND restaurant_id = $2 AND action = 'drawer_no_sale' AND status = 'issued' AND expires_at > NOW()
        RETURNING id`,
      [crypto.createHash('sha256').update(token).digest('hex'), rid(req)],
    );
    if (!rows[0]) throw forbidden('The manager approval is invalid, expired or already used');
  }
}

async function auditDrawerOpen(req, body, printerId) {
  await pool.query(
    `INSERT INTO audit_events (id, actor, action, entity_type, entity_id, restaurant_id, detail, data)
     VALUES ($1, $2, 'drawer.open', 'printer', $3, $4, $5, $6::jsonb)`,
    [
      `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      req.user?.name || req.user?.sub || 'unknown',
      String(printerId || ''),
      rid(req),
      String(body.reason || 'sale'),
      JSON.stringify({ till_id: tillId(req) || null, role: req.user?.role || null }),
    ],
  );
}

router.post('/print/drawer', asyncHandler(async (req, res) => {
  await assertDrawerAllowed(req, req.body || {});
  const { printer_id } = req.body || {};
  const printers = await loadPrinters(rid(req), printBranch(req));
  const printer = printers.find((p) => p.id === printer_id)
    || printers.find((p) => p.role === 'receipt' && p.drawer && p.active !== false)
    || printers.find((p) => p.role === 'receipt');
  if (!printer) throw badRequest('No receipt printer with cash drawer configured');
  await assertPrinterAddress(req, printer);
  await auditDrawerOpen(req, req.body || {}, printer.id);

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
    return ok(res, { ok: true, via: 'agent', result: data });
  }

  try {
    const result = await openDrawerNetwork(printer);
    return ok(res, { ok: true, via: 'network', result });
  } catch (err) {
    console.error(`[print] drawer open failed: printer=${printer.id} error=${err.message}`);
    throw badRequest(err.message + ' — run print-agent on the till for USB drawers');
  }
}));

/**
 * Print agent poll (authenticated restaurant/epos). Queued jobs are claimed with SELECT ... FOR UPDATE SKIP LOCKED, so
 * two pollers never receive the same job. A claim that is not acknowledged within two minutes is offered again.
 */
router.get('/print/queue', asyncHandler(async (req, res) => {
  const r = rid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: picked } = await client.query(
      `SELECT id FROM print_jobs
        WHERE restaurant_id = $1 AND branch_id IS NOT DISTINCT FROM $2::text
          AND (status = 'queued' OR (status = 'claimed' AND claimed_at < NOW() - INTERVAL '2 minutes'))
        ORDER BY created_at, id
        LIMIT 50
        FOR UPDATE SKIP LOCKED`,
      [r, printBranch(req)],
    );
    let claimed = [];
    if (picked.length) {
      const { rows } = await client.query(
        `UPDATE print_jobs SET status = 'claimed', claimed_at = NOW()
          WHERE restaurant_id = $1 AND id = ANY($2::text[])
          RETURNING id, payload, payload_b64`,
        [r, picked.map((p) => p.id)],
      );
      claimed = rows;
    }
    await client.query('COMMIT');
    ok(res, claimed.map((j) => ({ ...(j.payload || {}), id: j.id, status: 'queued', payload_b64: j.payload_b64 })));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/print/queue/:id/ack', asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE print_jobs SET status = 'done', done_at = NOW()
      WHERE id = $1 AND restaurant_id = $2 AND status IN ('queued', 'claimed') AND branch_id IS NOT DISTINCT FROM $3::text`,
    [req.params.id, rid(req), printBranch(req)],
  );
  ok(res, { ok: true, acked: rowCount > 0 });
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
  // Calls come in on the restaurant's line and are kept at restaurant level. A branch login does not see them.
  if (branchId(req)) return ok(res, []);
  ok(res, await loadCalls(rid(req)));
}));

const inboundHandler = asyncHandler(async (req, res) => {
  // Auth: Bearer restaurant token OR X-Callerid-Secret matching integrations.callerid webhook_secret
  // Also accepts Twilio form posts with AccountSid matching stored username
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
    const secret = keys.webhook_secret || keys.password;
    // Only the shared secret authenticates a caller-ID event (constant-time compare). AccountSid is an
    // identifier, not a credential, so it no longer authorises a request (audit 04 S-10, roadmap 6.2).
    const given = Buffer.from(String(req.headers['x-callerid-secret'] || ''));
    const expected = Buffer.from(String(secret || ''));
    const okSecret = !!secret && given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!okSecret) throw unauthorized('Invalid caller ID webhook credentials');
  } else {
    throw unauthorized('restaurant_id required for caller ID webhook');
  }

  if (!phone) throw badRequest('Missing caller phone (From)');

  // Call number: atomic per restaurant (SEC-M17). The old read-then-write of call_seq lost updates and always read 230.
  const seq = await nextCallNumber(rId);


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
