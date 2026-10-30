const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { buildCrud } = require('@cravedash/shared/src/crud');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, branchId, assertBranchAccess } = require('@cravedash/shared/src/authMiddleware');
const { notFound, forbidden, badRequest, unauthorized, conflict } = require('@cravedash/shared/src/errors');

const router = express.Router();

/** Keys restaurant tenants may write into restaurants.data (entitlements / billing stay platform-only). */
const TENANT_DATA_ALLOW = new Set([
  'currency',
  'timezone',
  'vat_number',
  'vat_registered',
  'restaurantTerms',
  'platformTermsAccepted',
  'platform_terms_version',
  'users',
  'admins',
  'menu_presentation',
  'branches',
  'card_brand',
  'card_last4',
]);

const TENANT_BODY_TO_DATA = [
  'users',
  'admins',
  'restaurantTerms',
  'platformTermsAccepted',
  'platform_terms_version',
];

function rid(req) {
  return restaurantId(req);
}

function isPlatformSuper(req) {
  return req.user?.role === 'super' && !req.user?.impersonating;
}

function pickTenantData(existing, incoming) {
  const out = { ...(existing && typeof existing === 'object' ? existing : {}) };
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return out;
  for (const key of TENANT_DATA_ALLOW) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      out[key] = incoming[key];
    }
  }
  return out;
}

function mount(path, table, opts = {}) {
  const crud = buildCrud(pool, table, {
    restaurantColumn: 'restaurant_id',
    jsonColumns: opts.jsonColumns || ['data', 'payload', 'perms', 'settings'],
    ...opts,
  });

  router.get(path, asyncHandler(async (req, res) => {
    const r = rid(req);
    const bound = opts.branchScope ? branchId(req) : null;
    const query = { ...req.query };
    if (query.search) {
      const term = `%${query.search}%`;
      const { rows } = await pool.query(
        `SELECT * FROM ${table} WHERE restaurant_id = $1 AND (name ILIKE $2 OR phone ILIKE $2 OR email ILIKE $2) ORDER BY id ASC`,
        [r, term],
      );
      return ok(res, opts.parseRow ? rows.map(opts.parseRow) : rows);
    }
    if (query.phone) {
      const { rows } = await pool.query(
        `SELECT * FROM ${table} WHERE restaurant_id = $1 AND phone = $2 ORDER BY id ASC`,
        [r, query.phone],
      );
      return ok(res, opts.parseRow ? rows.map(opts.parseRow) : rows);
    }
    if (!bound) {
      const rows = await crud.list(r, query);
      return ok(res, opts.parseRow ? rows.map(opts.parseRow) : rows);
    }
    // Phase C.1: branch JWT sees own branch + HQ-shared (null branch_id)
    const { rows } = await pool.query(
      `SELECT * FROM ${table} WHERE restaurant_id = $1 AND (branch_id IS NULL OR branch_id = $2) ORDER BY id ASC`,
      [r, bound],
    );
    ok(res, opts.parseRow ? rows.map(opts.parseRow) : rows);
  }));
  router.get(`${path}/:id`, asyncHandler(async (req, res) => {
    const row = await crud.getById(req.params.id, rid(req));
    if (!row) throw notFound();
    if (opts.branchScope) assertBranchAccess(req, row.branch_id, { allowShared: true });
    ok(res, opts.parseRow ? opts.parseRow(row) : row);
  }));
  router.post(path, asyncHandler(async (req, res) => {
    let body = { ...req.body };
    if (opts.transformBody) body = opts.transformBody(body);
    if (!body.id) body.id = `${table.slice(0, 4)}_${Date.now().toString(36)}`;
    if (opts.branchScope) {
      const bound = branchId(req);
      if (bound) {
        body.branch_id = bound; // cannot invent another branch
      } else if (body.branch_id) {
        assertBranchAccess(req, body.branch_id, { allowShared: true });
      }
    }
    const createdRow = await crud.create(body, rid(req));
    created(res, opts.parseRow ? opts.parseRow(createdRow) : createdRow);
  }));
  router.put(`${path}/:id`, asyncHandler(async (req, res) => {
    const existing = await crud.getById(req.params.id, rid(req));
    if (!existing) throw notFound();
    if (opts.branchScope) assertBranchAccess(req, existing.branch_id, { allowShared: true });
    let body = { ...req.body };
    if (opts.transformBody) body = opts.transformBody(body, existing);
    if (opts.branchScope && branchId(req)) delete body.branch_id; // cannot reassign out of scope
    const updatedRow = await crud.update(req.params.id, body, rid(req));
    ok(res, opts.parseRow ? opts.parseRow(updatedRow) : updatedRow);
  }));
  router.patch(`${path}/:id`, asyncHandler(async (req, res) => {
    const existing = await crud.getById(req.params.id, rid(req));
    if (!existing) throw notFound();
    if (opts.branchScope) assertBranchAccess(req, existing.branch_id, { allowShared: true });
    let body = { ...req.body };
    if (opts.transformBody) body = opts.transformBody(body, existing);
    if (opts.branchScope && branchId(req)) delete body.branch_id;
    const updatedRow = await crud.update(req.params.id, body, rid(req));
    ok(res, opts.parseRow ? opts.parseRow(updatedRow) : updatedRow);
  }));
  router.delete(`${path}/:id`, asyncHandler(async (req, res) => {
    const existing = await crud.getById(req.params.id, rid(req));
    if (!existing) throw notFound();
    if (opts.branchScope) assertBranchAccess(req, existing.branch_id, { allowShared: true });
    ok(res, await crud.remove(req.params.id, rid(req)));
  }));
}

mount('/customers', 'customers', {
  branchScope: true,
  // Block wallet/loyalty mass-assignment — use dedicated ledger endpoints later
  allowedColumns: [
    'id', 'name', 'email', 'phone', 'status', 'data',
    'f_name', 'l_name', 'address', 'branch', 'branch_id',
  ],
  transformBody: (b, existing) => {
    const existingData = (existing && existing.data && typeof existing.data === 'object') ? existing.data : {};
    const data = { ...existingData, ...(b.data || {}) };
    if (b.notes !== undefined) data.notes = b.notes;
    if (b.postcode !== undefined) data.postcode = b.postcode;
    if (b.rating !== undefined) data.rating = b.rating;
    if (b.review_note !== undefined) data.review_note = b.review_note;
    if (b.stars !== undefined) data.stars = b.stars;
    return { ...b, data };
  },
  parseRow: (r) => {
    if (!r) return r;
    const row = { ...r };
    if (row.data && typeof row.data === 'object') {
      if (row.data.rating !== undefined && row.rating === undefined) row.rating = row.data.rating;
      if (row.data.stars !== undefined && row.stars === undefined) row.stars = row.data.stars;
      if (row.data.review_note !== undefined && row.review_note === undefined) row.review_note = row.data.review_note;
      if (row.data.notes !== undefined && row.notes === undefined) row.notes = row.data.notes;
      if (row.data.postcode !== undefined && row.postcode === undefined) row.postcode = row.data.postcode;
    }
    return row;
  },
});

/**
 * PATCH /api/v1/customers/:id/rating (CD-CON-047 / BACKEND-003)
 * Updates customer star rating and review note.
 */
async function customerRatingHandler(req, res) {
  const targetId = req.params.id;
  const user = req.user;
  if (!user) throw unauthorized('Authentication required');

  // Role check: customer (for own record), restaurant, epos, super
  if (!['customer', 'super', 'restaurant', 'epos'].includes(user.role)) {
    throw forbidden('Role not authorized to rate customers');
  }

  // Cross-customer authorization: customer role can only rate their own record
  if (user.role === 'customer') {
    const customerSelfId = user.sub || user.id;
    if (String(customerSelfId) !== String(targetId)) {
      throw forbidden("Cannot modify another customer's record");
    }
  }

  // Tenant scope resolution
  const r = rid(req);
  if (!r) throw badRequest('restaurant_id missing from session');

  // Rating input validation
  const body = req.body || {};
  const rawStars = body.stars !== undefined ? body.stars : body.rating;

  // Validate rating type
  if (rawStars === undefined || rawStars === null) {
    throw badRequest('Rating is required (field: stars or rating)');
  }
  if (typeof rawStars !== 'number' || Number.isNaN(rawStars)) {
    throw badRequest('Rating must be a numeric value');
  }

  // Permitted range: 0 to 5 in 0.5 increments
  const VALID_STARS = new Set([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
  if (rawStars < 0 || rawStars > 5) {
    throw badRequest('Rating must be between 0 and 5');
  }
  if (!VALID_STARS.has(rawStars)) {
    throw badRequest('Rating must be in 0.5 increments (e.g. 0, 0.5, 1.0, ..., 5.0)');
  }

  // Review note validation and sanitization
  const MAX_REVIEW_NOTE_LENGTH = 500;
  let reviewNote = null;
  if (body.review_note !== undefined && body.review_note !== null) {
    if (typeof body.review_note !== 'string') {
      throw badRequest('review_note must be a string');
    }
    const rawNote = body.review_note.trim();
    if (rawNote.length > MAX_REVIEW_NOTE_LENGTH) {
      throw badRequest(`review_note must not exceed ${MAX_REVIEW_NOTE_LENGTH} characters`);
    }
    // Sanitize: strip HTML tags to prevent stored XSS
    reviewNote = rawNote.replace(/<[^>]*>?/gm, '').trim();
  }

  // Branch scope check (if staff is branch-scoped)
  const boundBranch = branchId(req);

  // Fetch existing customer within tenant scope
  const { rows: existingRows } = await pool.query(
    'SELECT * FROM customers WHERE id = $1 AND restaurant_id = $2',
    [targetId, r],
  );
  if (!existingRows[0]) {
    throw notFound('Customer not found');
  }

  const existing = existingRows[0];
  if (boundBranch) {
    assertBranchAccess(req, existing.branch_id, { allowShared: true });
  }

  const currentData = (typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data) || {};
  const updatedData = {
    ...currentData,
    rating: rawStars,
    stars: rawStars,
    review_note: reviewNote,
    rated_at: new Date().toISOString(),
    rated_by: user.sub || user.id || user.role,
    rated_by_role: user.role,
  };

  const { rows: updatedRows } = await pool.query(
    `UPDATE customers
     SET data = $1::jsonb, updated_at = NOW()
     WHERE id = $2 AND restaurant_id = $3
     RETURNING *`,
    [JSON.stringify(updatedData), targetId, r],
  );

  const updated = updatedRows[0];
  if (!updated) throw notFound('Customer not found');

  const parsedData = (typeof updated.data === 'string' ? JSON.parse(updated.data) : updated.data) || {};
  const responseData = {
    ...updated,
    data: parsedData,
    rating: rawStars,
    stars: rawStars,
    review_note: reviewNote,
  };

  // Optional audit event logging
  const auditId = `ae_rate_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  pool.query(
    `INSERT INTO audit_events (id, actor, action, entity_type, entity_id, restaurant_id, detail, data, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())`,
    [
      auditId,
      user.sub || user.id || user.role,
      'CUSTOMER_RATED',
      'customer',
      targetId,
      r,
      `Customer rating set to ${rawStars} stars`,
      JSON.stringify({ stars: rawStars, review_note: reviewNote, actor_role: user.role }),
    ],
  ).catch(() => {});

  ok(res, responseData);
}

router.patch('/customers/:id/rating', asyncHandler(customerRatingHandler));
router.patch('/customer/:id/rating', asyncHandler(customerRatingHandler));

mount('/coupons', 'coupons');
mount('/employees/roles', 'employee_roles', { idColumn: 'id' });
mount('/employees', 'employees', {
  branchScope: true,
  allowedColumns: [
    'id', 'f_name', 'l_name', 'email', 'phone', 'role_id', 'branch', 'branch_id', 'status', 'data',
  ],
});
// Helper to hash tableId and restaurantId into a 64-bit BigInt for pg_advisory_xact_lock
function computeTableLockKey(restaurantId, tableId) {
  const str = `${restaurantId || ''}:${tableId || ''}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c64e6d;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const high = BigInt(h1 >>> 0);
  const low = BigInt(h2 >>> 0);
  // Return signed 64-bit BigInt string representation for PostgreSQL bigint
  const combined = (high << 32n) | low;
  const signed = BigInt.asIntN(64, combined);
  return signed.toString();
}

// --- Bookings with table capacity and clash checking ---
async function validateTableBooking(restaurantId, body, excludeBookingId = null, dbClient = null) {
  const db = dbClient || pool;
  const partySize = Number(body.party_size || body.guests || body.guest_count) || 1;
  if (partySize <= 0) {
    throw badRequest('Party size must be greater than zero');
  }

  const tableId = body.table_id || null;
  const bookedAtRaw = body.booked_at || body.start_time || (body.date && body.time ? `${body.date}T${body.time}` : null);
  const durationMinutes = Number(body.duration_minutes || body.duration || (body.data && body.data.duration_minutes)) || 90;

  let tableBranchId = undefined;
  if (tableId) {
    // If inside a transaction client, acquire transaction-level advisory lock on this table
    if (dbClient) {
      const lockKey = computeTableLockKey(restaurantId, tableId);
      await dbClient.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey]);
    }

    const { rows: tableRows } = await db.query(
      'SELECT * FROM dining_tables WHERE id = $1 AND restaurant_id = $2',
      [tableId, restaurantId]
    );
    const table = tableRows[0];
    if (!table) throw badRequest('Table does not exist');
    if (table.active === false) throw badRequest('Table is not active');
    tableBranchId = (table.data && table.data.branch_id) || table.branch_id || null;
    if (table.seats != null && partySize > table.seats) {
      throw badRequest(`Party size (${partySize}) exceeds table capacity (${table.seats})`);
    }

    if (bookedAtRaw) {
      const startTime = new Date(bookedAtRaw);
      if (isNaN(startTime.getTime())) throw badRequest('Invalid booking date/time');
      const endTime = new Date(startTime.getTime() + durationMinutes * 60000);

      // Clash check: find overlapping active bookings on this table
      const clashSql = `
        SELECT id, customer_name, booked_at, COALESCE((data->>'duration_minutes')::int, 90) as duration
        FROM bookings
        WHERE restaurant_id = $1
          AND table_id = $2
          AND status NOT IN ('canceled', 'rejected')
          AND ($3::text IS NULL OR id != $3)
          AND booked_at < $5
          AND (booked_at + (COALESCE((data->>'duration_minutes')::int, 90) * INTERVAL '1 minute')) > $4
      `;
      const { rows: clashRows } = await db.query(clashSql, [
        restaurantId,
        tableId,
        excludeBookingId,
        startTime,
        endTime,
      ]);

      if (clashRows.length > 0) {
        throw conflict(`Table is already booked for this time slot (conflicts with booking ${clashRows[0].id})`);
      }
    }
  }

  return {
    partySize,
    tableId,
    tableBranchId,
    bookedAt: bookedAtRaw ? new Date(bookedAtRaw) : null,
    durationMinutes,
  };
}

const bookingsCrud = buildCrud(pool, 'bookings', {
  restaurantColumn: 'restaurant_id',
  jsonColumns: ['data'],
});

router.get('/bookings', asyncHandler(async (req, res) => {
  const r = rid(req);
  const bound = branchId(req);
  if (!bound) return ok(res, await bookingsCrud.list(r));
  const { rows } = await pool.query(
    `SELECT * FROM bookings WHERE restaurant_id = $1 AND (data->>'branch_id' IS NULL OR data->>'branch_id' = $2) ORDER BY booked_at DESC NULLS LAST, id ASC`,
    [r, bound]
  );
  ok(res, rows);
}));

/**
 * GET /bookings/availability (and /booking/availability, /reservations/availability)
 * Calculates available table slots for a requested date and party size.
 */
async function handleBookingAvailability(req, res) {
  const r = rid(req);
  const dateStr = String(req.query.date || new Date().toISOString().split('T')[0]);
  const guests = Number(req.query.guests || req.query.party_size || 2);
  const durationMinutes = Number(req.query.duration || 90);

  const { rows: tables } = await pool.query(
    'SELECT * FROM dining_tables WHERE restaurant_id = $1 AND active = true AND (seats IS NULL OR seats >= $2) ORDER BY seats ASC',
    [r, guests]
  );

  const dayStart = new Date(`${dateStr}T00:00:00Z`);
  const dayEnd = new Date(`${dateStr}T23:59:59Z`);
  const { rows: existingBookings } = await pool.query(
    `SELECT id, table_id, booked_at, COALESCE((data->>'duration_minutes')::int, 90) as duration
     FROM bookings
     WHERE restaurant_id = $1
       AND status NOT IN ('canceled', 'rejected')
       AND booked_at >= $2 AND booked_at <= $3`,
    [r, dayStart, dayEnd]
  );

  const slots = [];
  const times = [
    '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00',
    '17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00'
  ];

  for (const time of times) {
    const slotStart = new Date(`${dateStr}T${time}:00Z`);
    const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60000);

    const freeTables = tables.filter((t) => {
      const clash = existingBookings.some((b) => {
        if (b.table_id !== t.id) return false;
        const bStart = new Date(b.booked_at);
        const bEnd = new Date(bStart.getTime() + b.duration * 60000);
        return bStart < slotEnd && bEnd > slotStart;
      });
      return !clash;
    });

    slots.push({
      time,
      available: freeTables.length > 0,
      available_tables_count: freeTables.length,
      available_table_ids: freeTables.map((t) => t.id),
    });
  }

  ok(res, { date: dateStr, guests, duration_minutes: durationMinutes, slots });
}

router.get('/bookings/availability', asyncHandler(handleBookingAvailability));
router.get('/booking/availability', asyncHandler(handleBookingAvailability));
router.get('/reservations/availability', asyncHandler(handleBookingAvailability));

router.get('/bookings/:id', asyncHandler(async (req, res) => {
  const row = await bookingsCrud.getById(req.params.id, rid(req));
  if (!row) throw notFound();
  ok(res, row);
}));

router.post('/bookings', asyncHandler(async (req, res) => {
  const r = rid(req);
  const body = { ...req.body };
  if (!body.id) body.id = `book_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const validation = await validateTableBooking(r, body, null, client);
    body.party_size = validation.partySize;
    body.table_id = validation.tableId;
    if (validation.bookedAt) body.booked_at = validation.bookedAt;
    body.data = {
      ...(body.data || {}),
      duration_minutes: validation.durationMinutes,
    };

    const bound = branchId(req);
    if (bound) {
      body.data.branch_id = bound;
    }

    const { rows } = await client.query(
      `INSERT INTO bookings (id, restaurant_id, customer_name, customer_phone, party_size, table_id, booked_at, status, note, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW(), NOW())
       RETURNING *`,
      [
        body.id,
        r,
        body.customer_name || null,
        body.customer_phone || null,
        body.party_size,
        body.table_id,
        body.booked_at || null,
        body.status || 'pending',
        body.note || null,
        JSON.stringify(body.data || {}),
      ]
    );

    await client.query('COMMIT');
    created(res, bookingsCrud.parseRow(rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.put('/bookings/:id', asyncHandler(async (req, res) => {
  const r = rid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query(
      'SELECT * FROM bookings WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
      [req.params.id, r]
    );
    if (!existingRows[0]) throw notFound();
    const existing = bookingsCrud.parseRow(existingRows[0]);

    // Validate branch access to existing booking
    assertBranchAccess(req, existing.data?.branch_id, { allowShared: true });

    const body = { ...req.body };
    const validation = await validateTableBooking(r, { ...existing, ...body }, req.params.id, client);

    // If changing table/branch, validate branch access to destination table's branch
    if (validation.tableBranchId !== undefined) {
      assertBranchAccess(req, validation.tableBranchId, { allowShared: true });
    }
    if (body.branch_id || (body.data && body.data.branch_id)) {
      assertBranchAccess(req, body.branch_id || body.data?.branch_id, { allowShared: true });
    }

    body.party_size = validation.partySize;
    body.table_id = validation.tableId;
    if (validation.bookedAt) body.booked_at = validation.bookedAt;
    body.data = {
      ...(existing.data || {}),
      ...(body.data || {}),
      duration_minutes: validation.durationMinutes,
    };
    if (validation.tableBranchId !== undefined) {
      body.data.branch_id = validation.tableBranchId || body.data.branch_id;
    }

    const { rows: updatedRows } = await client.query(
      `UPDATE bookings
       SET customer_name = $3, customer_phone = $4, party_size = $5, table_id = $6,
           booked_at = $7, status = $8, note = $9, data = $10::jsonb, updated_at = NOW()
       WHERE id = $1 AND restaurant_id = $2
       RETURNING *`,
      [
        req.params.id,
        r,
        body.customer_name !== undefined ? body.customer_name : existing.customer_name,
        body.customer_phone !== undefined ? body.customer_phone : existing.customer_phone,
        body.party_size,
        body.table_id,
        body.booked_at || null,
        body.status !== undefined ? body.status : existing.status,
        body.note !== undefined ? body.note : existing.note,
        JSON.stringify(body.data || {}),
      ]
    );

    await client.query('COMMIT');
    ok(res, bookingsCrud.parseRow(updatedRows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.patch('/bookings/:id', asyncHandler(async (req, res) => {
  const r = rid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query(
      'SELECT * FROM bookings WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
      [req.params.id, r]
    );
    if (!existingRows[0]) throw notFound();
    const existing = bookingsCrud.parseRow(existingRows[0]);

    // Validate branch access to existing booking
    assertBranchAccess(req, existing.data?.branch_id, { allowShared: true });

    const body = { ...req.body };
    const validation = await validateTableBooking(r, { ...existing, ...body }, req.params.id, client);

    // If changing table/branch, validate branch access to destination table's branch
    if (validation.tableBranchId !== undefined) {
      assertBranchAccess(req, validation.tableBranchId, { allowShared: true });
    }
    if (body.branch_id || (body.data && body.data.branch_id)) {
      assertBranchAccess(req, body.branch_id || body.data?.branch_id, { allowShared: true });
    }

    body.party_size = validation.partySize;
    body.table_id = validation.tableId;
    if (validation.bookedAt) body.booked_at = validation.bookedAt;
    body.data = {
      ...(existing.data || {}),
      ...(body.data || {}),
      duration_minutes: validation.durationMinutes,
    };
    if (validation.tableBranchId !== undefined) {
      body.data.branch_id = validation.tableBranchId || body.data.branch_id;
    }

    const { rows: updatedRows } = await client.query(
      `UPDATE bookings
       SET customer_name = $3, customer_phone = $4, party_size = $5, table_id = $6,
           booked_at = $7, status = $8, note = $9, data = $10::jsonb, updated_at = NOW()
       WHERE id = $1 AND restaurant_id = $2
       RETURNING *`,
      [
        req.params.id,
        r,
        body.customer_name !== undefined ? body.customer_name : existing.customer_name,
        body.customer_phone !== undefined ? body.customer_phone : existing.customer_phone,
        body.party_size,
        body.table_id,
        body.booked_at || null,
        body.status !== undefined ? body.status : existing.status,
        body.note !== undefined ? body.note : existing.note,
        JSON.stringify(body.data || {}),
      ]
    );

    await client.query('COMMIT');
    ok(res, bookingsCrud.parseRow(updatedRows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.delete('/bookings/:id', asyncHandler(async (req, res) => {
  const existing = await bookingsCrud.getById(req.params.id, rid(req));
  if (!existing) throw notFound();
  ok(res, await bookingsCrud.remove(req.params.id, rid(req)));
}));
mount('/approvals', 'approval_requests', { jsonColumns: ['payload'] });
const deliverymenWorkflow = require('./deliverymen');
router.use('/deliverymen', deliverymenWorkflow);
router.use('/riders', deliverymenWorkflow);
router.get('/riders', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { status, radius_miles, search, phone } = req.query;
  const params = [r];
  let where = 'restaurant_id = $1';
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length} OR email ILIKE $${params.length})`;
  } else if (phone) {
    params.push(phone);
    where += ` AND phone = $${params.length}`;
  }
  const { rows } = await pool.query(`SELECT * FROM deliverymen WHERE ${where} ORDER BY id ASC`, params);
  let riders = rows.map((dm) => {
    const data = typeof dm.data === 'string' ? JSON.parse(dm.data) : (dm.data || {});
    const isOnline = data.available !== false && data.vehicleAvailable !== false && (!dm.status || dm.status === 'active' || dm.status === 'approved');
    return {
      id: dm.id,
      restaurant_id: dm.restaurant_id,
      branch_id: dm.branch_id || null,
      name: dm.name,
      phone: dm.phone || '',
      email: dm.email || '',
      vehicle: dm.vehicle || 'bike',
      reg: data.reg || data.vehicle_reg || '',
      status: dm.status,
      is_available: isOnline,
      vehicleAvailable: isOnline,
      available: isOnline,
      zones: data.zones || [],
      capacity: Number(data.capacity || 3),
      avg_rating: Number(data.avg_rating || 5.0),
      review_count: Number(data.review_count || 0),
      data,
    };
  });
  if (status && status !== 'all') {
    if (status === 'available') {
      riders = riders.filter((r) => r.is_available);
    } else if (status === 'busy') {
      riders = riders.filter((r) => !r.is_available);
    }
  }
  ok(res, riders);
}));

mount('/deliverymen', 'deliverymen');
mount('/riders', 'deliverymen');
mount('/chefs', 'chefs');

router.get('/tables', asyncHandler(async (req, res) => {
  const r = rid(req);
  const areas = await buildCrud(pool, 'areas', { restaurantColumn: 'restaurant_id' }).list(r);
  const tables = await buildCrud(pool, 'dining_tables', { restaurantColumn: 'restaurant_id' }).list(r);
  ok(res, { areas, tables });
}));

router.post('/tables/areas', asyncHandler(async (req, res) => {
  const crud = buildCrud(pool, 'areas', { restaurantColumn: 'restaurant_id' });
  const body = { ...req.body, id: req.body.id || `area_${Date.now().toString(36)}` };
  created(res, await crud.create(body, rid(req)));
}));

router.put('/tables/areas/:id', asyncHandler(async (req, res) => {
  const crud = buildCrud(pool, 'areas', { restaurantColumn: 'restaurant_id' });
  ok(res, await crud.update(req.params.id, req.body, rid(req)));
}));

router.delete('/tables/areas/:id', asyncHandler(async (req, res) => {
  const r = rid(req);
  const areaId = req.params.id;
  // Remove tables in this area first, then the area
  await pool.query('DELETE FROM dining_tables WHERE restaurant_id = $1 AND area_id = $2', [r, areaId]);
  const crud = buildCrud(pool, 'areas', { restaurantColumn: 'restaurant_id' });
  ok(res, await crud.remove(areaId, r));
}));

router.post('/tables', asyncHandler(async (req, res) => {
  const crud = buildCrud(pool, 'dining_tables', { restaurantColumn: 'restaurant_id' });
  const body = { ...req.body, id: req.body.id || `T${req.body.number || Date.now()}` };
  created(res, await crud.create(body, rid(req)));
}));

router.put('/tables/:id', asyncHandler(async (req, res) => {
  const crud = buildCrud(pool, 'dining_tables', { restaurantColumn: 'restaurant_id' });
  ok(res, await crud.update(req.params.id, req.body, rid(req)));
}));

router.delete('/tables/:id', asyncHandler(async (req, res) => {
  const crud = buildCrud(pool, 'dining_tables', { restaurantColumn: 'restaurant_id' });
  ok(res, await crud.remove(req.params.id, rid(req)));
}));

/** Phase B.4: per-user UI prefs (sidebar, terminal) — not restaurant business settings. */
let prefsTableReady = null;
async function ensureUserPrefsTable() {
  if (!prefsTableReady) {
    prefsTableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS user_prefs (
        user_id TEXT PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `).catch((e) => { prefsTableReady = null; throw e; });
  }
  return prefsTableReady;
}

function prefsUserId(req) {
  const id = req.user?.sub || req.user?.id;
  if (!id) throw unauthorized('No user session');
  return String(id);
}

router.get('/settings/prefs', asyncHandler(async (req, res) => {
  await ensureUserPrefsTable();
  const uid = prefsUserId(req);
  const { rows } = await pool.query('SELECT data FROM user_prefs WHERE user_id = $1', [uid]);
  ok(res, rows[0]?.data || {});
}));

router.put('/settings/prefs', asyncHandler(async (req, res) => {
  await ensureUserPrefsTable();
  const uid = prefsUserId(req);
  const incoming = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  // Merge patch into existing prefs (shallow)
  const { rows: cur } = await pool.query('SELECT data FROM user_prefs WHERE user_id = $1', [uid]);
  const merged = Object.assign({}, (cur[0]?.data && typeof cur[0].data === 'object') ? cur[0].data : {}, incoming);
  let raw;
  try {
    raw = JSON.stringify(merged);
  } catch {
    throw badRequest('Prefs payload is not JSON-serializable');
  }
  if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) throw badRequest('Prefs exceed 64 KiB');
  const { rows } = await pool.query(
    `INSERT INTO user_prefs (user_id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
     RETURNING data`,
    [uid, raw],
  );
  ok(res, rows[0].data);
}));

router.get('/settings', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { rows } = await pool.query('SELECT settings FROM restaurant_settings WHERE restaurant_id = $1', [r]);
  ok(res, rows[0]?.settings || {});
}));

router.put('/settings', asyncHandler(async (req, res) => {
  const r = rid(req);
  const settings = req.body || {};
  const { rows } = await pool.query(
    `INSERT INTO restaurant_settings (restaurant_id, settings, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (restaurant_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()
     RETURNING settings`,
    [r, JSON.stringify(settings)],
  );
  ok(res, rows[0].settings);
}));

router.get('/restaurant', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { rows } = await pool.query('SELECT * FROM restaurants WHERE id = $1', [r]);
  if (!rows[0]) throw notFound('Restaurant not found');
  ok(res, rows[0]);
}));

router.get('/restaurant/profile', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { rows } = await pool.query('SELECT * FROM restaurants WHERE id = $1', [r]);
  if (!rows[0]) throw notFound('Restaurant not found');
  ok(res, rows[0]);
}));

router.get('/restaurant/integrations', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [rid(req), 'integrations'],
  );
  const data = rows[0]?.data || {};
  ok(res, {
    epos: { connected: true, status: 'online' },
    printers: { connected: true, status: 'online' },
    tables: { connected: true, status: 'online' },
    caller_id: { connected: true, status: 'active' },
    integrations: data,
  });
}));

router.get('/brand/config', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { rows } = await pool.query('SELECT * FROM restaurants WHERE id = $1', [r]);
  const rest = rows[0] || {};
  const data = rest.data || {};
  ok(res, {
    brand_name: rest.name || 'Porto Piri Piri',
    theme: {
      primary_color: data.website_primary_color || data.primary_color || '#ff6b00',
      logo_url: data.logo || 'https://img.cravedash.com/logo.png',
      light_logo: data.light_logo || data.logo,
      dark_logo: data.dark_logo || data.logo,
      fav_icon: data.fav_icon || data.logo,
      currency: data.currency || 'GBP',
      currency_symbol: data.currency_symbol || '£',
    },
    order_settings: data.order_settings || { delivery: true, takeaway: true, dine_in: true },
  });
}));

router.get('/notifications', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { unread_only, limit = 20, page = 1 } = req.query;

  const { rows: blobRows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [r, 'notifications_feed'],
  );
  let notifications = Array.isArray(blobRows[0]?.data) ? blobRows[0].data : [];

  if (!notifications.length) {
    const { rows: orderRows } = await pool.query(
      `SELECT id, order_type, status, total, created_at, customer
       FROM orders
       WHERE restaurant_id = $1 AND status IN ('pending', 'confirmed', 'cooking')
       ORDER BY created_at DESC LIMIT 10`,
      [r],
    );
    notifications = orderRows.map((o) => ({
      id: `notif_${o.id}`,
      title: `New ${o.order_type || 'Takeaway'} Order #${o.id}`,
      message: `Order #${o.id} for £${Number(o.total).toFixed(2)} received in kitchen`,
      order_id: String(o.id),
      is_read: false,
      created_at: o.created_at,
    }));
  }

  if (unread_only === 'true' || unread_only === true || unread_only === '1') {
    notifications = notifications.filter((n) => !n.is_read);
  }

  const offset = (Math.max(1, +page) - 1) * Math.min(100, +limit || 20);
  const paginated = notifications.slice(offset, offset + Math.min(100, +limit || 20));
  ok(res, paginated);
}));

router.patch('/notifications/:id/read', asyncHandler(async (req, res) => {
  const r = rid(req);
  const notifId = req.params.id;
  const { rows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [r, 'notifications_feed'],
  );
  let list = Array.isArray(rows[0]?.data) ? rows[0].data : [];
  let found = false;
  list = list.map((n) => {
    if (String(n.id) === String(notifId)) {
      found = true;
      return { ...n, is_read: req.body?.is_read !== false };
    }
    return n;
  });
  if (!found) {
    list.push({ id: notifId, is_read: true, updated_at: new Date().toISOString() });
  }
  await pool.query(
    `INSERT INTO restaurant_blobs (restaurant_id, key, data, updated_at)
     VALUES ($1, 'notifications_feed', $2::jsonb, NOW())
     ON CONFLICT (restaurant_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [r, JSON.stringify(list)],
  );
  ok(res, { id: notifId, is_read: true, message: 'Notification marked as read' });
}));

router.post('/notifications/mark-all-read', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { rows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [r, 'notifications_feed'],
  );
  let list = Array.isArray(rows[0]?.data) ? rows[0].data : [];
  list = list.map((n) => ({ ...n, is_read: true }));
  await pool.query(
    `INSERT INTO restaurant_blobs (restaurant_id, key, data, updated_at)
     VALUES ($1, 'notifications_feed', $2::jsonb, NOW())
     ON CONFLICT (restaurant_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [r, JSON.stringify(list)],
  );
  ok(res, { success: true, message: 'All notifications marked as read' });
}));

/**
 * Restaurant admin self-update. Tenants may only patch profile / terms / panel ACL keys.
 * modules, api_key, access_level, billing, invoices, etc. require platform super
 * via PATCH /restaurants/:id — never this tenant endpoint.
 */
router.patch('/restaurant', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { rows: existing } = await pool.query('SELECT * FROM restaurants WHERE id = $1', [r]);
  if (!existing[0]) throw notFound('Restaurant not found');
  const cur = existing[0];
  const body = req.body || {};
  let data;

  if (isPlatformSuper(req)) {
    data = Object.assign({}, cur.data || {}, body.data || {});
    if (body.billing) data.billing = Object.assign({}, data.billing || {}, body.billing);
    ['users', 'admins', 'restaurantTerms', 'platformTermsAccepted', 'platform_terms_version', 'invoices'].forEach((k) => {
      if (body[k] !== undefined) data[k] = body[k];
    });
  } else {
    if (req.user?.role === 'epos') throw forbidden('EPOS cannot update restaurant profile');
    data = pickTenantData(cur.data, body.data);
    TENANT_BODY_TO_DATA.forEach((k) => {
      if (body[k] !== undefined) data[k] = body[k];
    });
    // Ignore privileged top-level fields from tenants (billing, invoices, modules, …)
  }

  const name = body.name != null ? body.name : cur.name;
  const phone = body.phone != null ? body.phone : cur.phone;
  const address = body.address != null ? body.address : cur.address;
  const { rows } = await pool.query(
    `UPDATE restaurants SET name = $2, phone = $3, address = $4, data = $5::jsonb, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [r, name, phone, address, JSON.stringify(data)],
  );
  ok(res, rows[0]);
}));

router.patch('/approvals/:id/resolve', asyncHandler(async (req, res) => {
  // Till-bound EPOS must use manager PIN path — not raw API self-approve
  if (req.user?.role === 'epos' || req.user?.till_id) {
    throw forbidden('EPOS cannot resolve approvals via API — use manager PIN / remote approval');
  }
  if (req.user?.role !== 'restaurant' && req.user?.role !== 'super') {
    throw forbidden('Only restaurant or platform admins can resolve approvals');
  }
  const { status = 'approved', resolved_by } = req.body || {};
  const next = String(status).toLowerCase();
  if (!['approved', 'rejected'].includes(next)) throw badRequest('status must be approved or rejected');
  const crud = buildCrud(pool, 'approval_requests', { restaurantColumn: 'restaurant_id', jsonColumns: ['payload'] });
  const existing = await crud.getById(req.params.id, rid(req));
  if (!existing) throw notFound();
  if (existing.status && existing.status !== 'pending') {
    throw badRequest(`Approval already ${existing.status}`);
  }
  ok(res, await crud.update(req.params.id, {
    status: next,
    resolved_at: new Date().toISOString(),
    resolved_by: resolved_by || req.user?.name,
  }, rid(req)));
}));

// Generic store blobs for inventory / payroll / banners / etc.
// Phase 3.1: allowlisted keys + size cap (H2 — no arbitrary key overwrite).
// Inventory / payroll / accounting moved to /domain/* (domain_docs) — not writable via blobs.
const BLOB_KEY_ALLOW = new Set([
  'report_schedules', 'custom_pages', 'faqs', 'social_links',
  'offline_methods', 'banners', 'mobile_banners', 'auto_discounts',
  'push_notifications',
  'subscribed', 'subscribers', 'dm_requests', 'dm_reviews',
  'offline_verifications', 'reviews', 'languages',
  'promotions', 'conversations', 'notifications_feed',
  'payouts', 'audit_log',
  'deals_enabled', 'driver_pay_policies', 'driver_payments',
  'restaurantTerms', 'platformTermsAccepted', 'staff_activity',
  'settings_integration_handoff', 'mobile_app_brand',
  'invoices',
  'print_log', 'call_log', 'calls_live', 'call_seq', 'print_queue',
  'remote_state', 'report_state',
]);
const BLOB_PROTECTED = new Set(['integrations']);
const BLOB_SENSITIVE = new Set([
  'wallet_txns', 'wallet_bonus', 'loyalty_txns', 'payouts', 'invoices',
  'integrations', 'audit_log', 'driver_payments', 'driver_pay_policies',
  'settings_integration_handoff', 'subscribed', 'subscribers',
]);
function isEposSession(req) {
  return req.user?.role === 'epos' || !!req.user?.till_id;
}

function assertBlobReadable(key, req) {
  const k = normalizeBlobKey(key);
  if (BLOB_PROTECTED.has(k)) {
    throw forbidden('Use /api/v1/integrations APIs for integration credentials');
  }
  if (BLOB_SENSITIVE.has(k) && isEposSession(req)) {
    throw forbidden('EPOS cannot read sensitive blobs');
  }
  return k;
}
const BLOB_MOVED_TO_DOMAIN = new Set([
  'ingredients', 'wastage', 'recipes', 'stock_moves', 'suppliers',
  'purchase_po', 'purchase_grn', 'purchase_payments', 'purchase_reports',
  'coa', 'acc_mapping', 'acc_journals', 'acc_manual', 'acc_ledger', 'acc_expenses',
  'acc_drawer', 'acc_ar', 'acc_ap', 'acc_tb', 'acc_pl', 'acc_bs',
  'payroll_staff', 'payroll_shifts', 'payroll_roster', 'payroll_attendance',
  'payroll_runs', 'payroll_reports',
  // Phase B.2 → domain ops
  'branches', 'delivery_zones', 'delivery_areas', 'reservation_settings',
  'approval_rules', 'epos_settings', 'menuPresentation', 'tips_config',
  'employee_roles', 'time_slots', 'print_settings', 'print_rules', 'print_routes',
  'card_terminals', 'epos_devices', 'pos_devices', 'printers',
  'epos_customers', 'till_counts',
]);
const BLOB_MAX_BYTES = 512 * 1024; // 512 KiB per key

function normalizeBlobKey(key) {
  const k = String(key || '');
  if (!/^[a-z][a-z0-9_]{1,63}$/i.test(k)) throw badRequest('Invalid blob key');
  return k;
}

function assertBlobWritable(key, req) {
  const k = normalizeBlobKey(key);
  if (BLOB_PROTECTED.has(k)) {
    throw forbidden('Use /api/v1/integrations APIs for integration credentials');
  }
  if (BLOB_MOVED_TO_DOMAIN.has(k)) {
    throw forbidden(`Use /domain APIs for "${k}" (inventory/payroll/accounting ledgers)`);
  }
  const allowed = BLOB_KEY_ALLOW.has(k) || k.startsWith('settings_');
  if (!allowed) throw forbidden(`Blob key "${k}" is not allowlisted`);
  if (BLOB_SENSITIVE.has(k) && isEposSession(req)) {
    throw forbidden('EPOS cannot write sensitive blobs');
  }
  return k;
}

router.get('/blobs', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { rows } = await pool.query(
    'SELECT key, data FROM restaurant_blobs WHERE restaurant_id = $1',
    [r],
  );
  const out = {};
  const epos = isEposSession(req);
  rows.forEach((row) => {
    if (BLOB_PROTECTED.has(row.key)) return;
    if (epos && BLOB_SENSITIVE.has(row.key)) return;
    out[row.key] = row.data;
  });
  ok(res, out);
}));

router.get('/blobs/:key', asyncHandler(async (req, res) => {
  const r = rid(req);
  const key = assertBlobReadable(req.params.key, req);
  const { rows } = await pool.query(
    'SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = $2',
    [r, key],
  );
  ok(res, rows[0]?.data ?? []);
}));

router.put('/blobs/:key', asyncHandler(async (req, res) => {
  const r = rid(req);
  const key = assertBlobWritable(req.params.key, req);
  const data = req.body === undefined ? [] : req.body;
  let raw;
  try {
    raw = JSON.stringify(data);
  } catch {
    throw badRequest('Blob payload is not JSON-serializable');
  }
  if (Buffer.byteLength(raw, 'utf8') > BLOB_MAX_BYTES) {
    throw badRequest(`Blob exceeds ${BLOB_MAX_BYTES} byte limit`);
  }
  const { rows } = await pool.query(
    `INSERT INTO restaurant_blobs (restaurant_id, key, data, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (restaurant_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
     RETURNING data`,
    [r, key, raw],
  );
  ok(res, rows[0].data);
}));

/**
 * Public Storefront Bootstrap & Configuration Subsystem (Task 6)
 */
router.get('/config', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { rows: restRows } = await pool.query('SELECT * FROM restaurants WHERE id = $1', [r]);
  if (!restRows[0]) throw notFound('Restaurant not found');
  const rest = restRows[0];
  const restData = rest.data && typeof rest.data === 'object' ? rest.data : {};

  const { rows: setRows } = await pool.query(
    'SELECT settings FROM restaurant_settings WHERE restaurant_id = $1',
    [r],
  ).catch(() => ({ rows: [] }));
  const settings = setRows[0]?.settings || {};

  // Resolve branches: branches table first, then restaurant_blobs ('branches'), then default
  let branches = [];
  const { rows: branchRows } = await pool.query(
    'SELECT * FROM branches WHERE restaurant_id = $1 ORDER BY id ASC',
    [r],
  ).catch(() => ({ rows: [] }));

  if (branchRows.length) {
    branches = branchRows.map((b) => {
      const bData = b.data && typeof b.data === 'object' ? b.data : {};
      const fee = Number(b.delivery_fee != null ? b.delivery_fee : (bData.delivery_fee != null ? bData.delivery_fee : 2.50));
      const minOrder = Number(b.min_order != null ? b.min_order : (bData.min_order != null ? bData.min_order : 10.00));
      const freeOver = Number(b.free_delivery_over_amount != null ? b.free_delivery_over_amount : (bData.free_delivery_over_amount != null ? bData.free_delivery_over_amount : 0));
      const freeStatus = b.free_delivery_over_status != null
        ? Number(b.free_delivery_over_status)
        : (bData.free_delivery_over_status != null ? Number(bData.free_delivery_over_status) : (freeOver > 0 ? 1 : 0));

      return {
        id: b.id,
        name: b.name,
        address: b.address || '',
        phone: b.phone || '',
        email: b.email || '',
        status: b.status !== false,
        delivery_fee: fee,
        min_order: minOrder,
        free_delivery_over_amount: freeOver,
        free_delivery_over_status: freeStatus,
      };
    });
  } else {
    const { rows: blobRows } = await pool.query(
      `SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = 'branches'`,
      [r],
    ).catch(() => ({ rows: [] }));
    if (blobRows[0]?.data && Array.isArray(blobRows[0].data) && blobRows[0].data.length) {
      branches = blobRows[0].data;
    } else {
      branches = [{
        id: 'main',
        name: rest.name || 'Main Branch',
        address: rest.address || '',
        phone: rest.phone || '',
        email: rest.email || '',
        status: true,
        delivery_fee: 2.50,
        min_order: 10.00,
        free_delivery_over_amount: 0,
        free_delivery_over_status: 0,
      }];
    }
  }

  const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
  const currencyCode = restData.currency || settings.currency || 'GBP';
  const currencySymbol = restData.currency_symbol || settings.currency_symbol || (currencyCode === 'USD' ? '$' : '£');
  const logo = restData.logo || 'default-logo.png';

  const deliveryChargeVal = Number(restData.delivery_charge || settings.delivery_charge || 2.50);
  const minOrderVal = Number(restData.min_order || settings.min_order || 10.00);

  const config = {
    restaurant_id: rest.id,
    restaurant_name: rest.name,
    name: rest.name,
    restaurant_phone: rest.phone || '',
    phone: rest.phone || '',
    restaurant_email: rest.email || '',
    email: rest.email || '',
    restaurant_address: rest.address || '',
    restaurant_logo: logo,
    restaurant_light_logo: restData.light_logo || logo,
    restaurant_dark_logo: restData.dark_logo || logo,
    fav_icon: restData.fav_icon || logo,
    website_primary_color: restData.website_primary_color || restData.primary_color || '#ff6b00',
    currency_symbol: currencySymbol,
    currency_code: currencyCode,
    currency: currencyCode,
    currency_position: restData.currency_position || settings.currency_position || 'left',
    currency_model: restData.currency_model || 'multi_currency',
    ordering: {
      delivery_charge: deliveryChargeVal,
      free_delivery_over: Number(restData.free_delivery_over || settings.free_delivery_over || 20.00),
      minimum_order: minOrderVal,
      service_fee: Number(restData.service_fee || settings.service_fee || 0.50),
      bag_charge: Number(restData.bag_charge || settings.bag_charge || 0.20),
    },
    payment_methods: restData.payment_methods || ['cash', 'card'],
    base_urls: {
      restaurant_image_url: `${baseUrl}/uploads/restaurant`,
      restaurant_cover_photo_url: `${baseUrl}/uploads/restaurant/cover`,
      category_image_url: `${baseUrl}/uploads/category`,
      product_image_url: `${baseUrl}/uploads/product`,
      banner_image_url: `${baseUrl}/uploads/banner`,
      customer_image_url: `${baseUrl}/uploads/customer`,
      chat_image_url: `${baseUrl}/uploads/chat`,
    },
    branches,
    order_settings: {
      delivery: true,
      takeaway: true,
      schedule_order: true,
      ...(settings.order_settings || {}),
    },
    restaurant_schedule_time: restData.schedule || settings.schedule || [],
    delivery_charge: deliveryChargeVal,
    min_order: minOrderVal,
  };
  ok(res, config);
}));

router.get('/config/delivery-fee', asyncHandler(async (req, res) => {
  const r = rid(req);
  const branchReq = req.query.branch_id;
  let branch = null;
  if (branchReq) {
    const { rows: bRows } = await pool.query(
      'SELECT * FROM branches WHERE restaurant_id = $1 AND id = $2',
      [r, String(branchReq)],
    ).catch(() => ({ rows: [] }));
    branch = bRows[0];
  }
  const { rows: restRows } = await pool.query('SELECT data FROM restaurants WHERE id = $1', [r]).catch(() => ({ rows: [] }));
  const restData = restRows[0]?.data || {};
  const bData = branch?.data && typeof branch.data === 'object' ? branch.data : {};
  const fee = Number(branch?.delivery_fee != null ? branch.delivery_fee : (bData.delivery_fee != null ? bData.delivery_fee : 2.50));
  const minOrder = Number(branch?.min_order != null ? branch.min_order : (bData.min_order != null ? bData.min_order : 10.00));
  const defaultFreeOver = Number(restData.free_delivery_over || 20.00);
  const freeOver = Number(branch?.free_delivery_over_amount != null ? branch.free_delivery_over_amount : (bData.free_delivery_over_amount != null ? bData.free_delivery_over_amount : defaultFreeOver));
  const freeStatus = branch?.free_delivery_over_status != null
    ? Number(branch.free_delivery_over_status)
    : (bData.free_delivery_over_status != null ? Number(bData.free_delivery_over_status) : (freeOver > 0 ? 1 : 0));

  const subtotal = Number(req.query.subtotal || req.query.amount || 0);
  const isFree = freeOver > 0 && subtotal >= freeOver;
  const distance = Number(req.query.distance || 2.4);

  ok(res, {
    delivery_fee: isFree ? 0 : fee,
    distance_km: distance,
    free_delivery: isFree,
    min_order: minOrder,
    delivery_charge_setup: {
      free_delivery_over_amount: freeOver,
      free_delivery_over_status: freeStatus,
    },
    delivery_setup: {
      free_delivery_over_amount: freeOver,
      free_delivery_over_status: freeStatus,
    },
  });
}));

router.get('/config/check-postcode', asyncHandler(async (req, res) => {
  const r = rid(req);
  const rawPostcode = String(req.query.postcode || '').trim();
  if (!rawPostcode) throw badRequest('Postcode is required');
  const branchReq = req.query.branch_id;

  const normalized = rawPostcode.replace(/\s+/g, '').toUpperCase();
  const outwardMatch = rawPostcode.match(/^([A-Z]{1,2}\d[A-Z\d]?)/i);
  const outward = outwardMatch ? outwardMatch[1].toUpperCase() : normalized;

  const { rows: blobRows } = await pool.query(
    `SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = 'delivery_zones'`,
    [r],
  ).catch(() => ({ rows: [] }));

  const rawZones = blobRows[0]?.data;
  const zones = Array.isArray(rawZones)
    ? rawZones
    : (rawZones && typeof rawZones === 'object' ? Object.values(rawZones) : []);

  if (zones.length > 0) {
    const matchedZone = zones.find((z) => {
      if (branchReq && z.branch_id && String(z.branch_id) !== String(branchReq)) return false;
      const pcList = Array.isArray(z.postcodes)
        ? z.postcodes
        : (typeof z.postcodes === 'string' ? z.postcodes.split(/[,\s]+/) : []);
      const normalizedList = pcList.map((p) => String(p).replace(/\s+/g, '').toUpperCase()).filter(Boolean);
      return normalizedList.some((p) => p === normalized || p === outward || normalized.startsWith(p));
    });

    if (matchedZone) {
      const fee = Number(matchedZone.delivery_fee ?? matchedZone.delivery_charge ?? 2.50);
      const minOrder = Number(matchedZone.min_order ?? matchedZone.minimum_order ?? 10.00);
      const freeOver = Number(matchedZone.free_delivery_over ?? matchedZone.free_delivery_over_amount ?? 0);
      const freeStatus = matchedZone.free_delivery_over_status ? 1 : (freeOver > 0 ? 1 : 0);
      return ok(res, {
        deliverable: true,
        is_covered: true,
        zone: matchedZone.name || 'Local Delivery Zone',
        zone_id: matchedZone.id || null,
        zone_name: matchedZone.name || null,
        delivery_fee: fee,
        delivery_charge: fee,
        estimated_delivery_minutes: 45,
        postcode: rawPostcode.toUpperCase(),
        postcode_normalized: normalized,
        min_order: minOrder,
        free_delivery_over_amount: freeOver,
        free_delivery_over_status: freeStatus,
        message: 'We deliver to this location',
      });
    }

    return ok(res, {
      deliverable: false,
      is_covered: false,
      zone: null,
      delivery_fee: null,
      postcode: rawPostcode.toUpperCase(),
      postcode_normalized: normalized,
      message: 'We do not deliver to this postcode',
    });
  }

  // Default fallback if no zones defined: open delivery
  ok(res, {
    deliverable: true,
    is_covered: true,
    zone: 'London Central Delivery Zone',
    delivery_fee: 2.50,
    delivery_charge: 2.50,
    estimated_delivery_minutes: 45,
    postcode: rawPostcode.toUpperCase(),
    postcode_normalized: normalized,
    min_order: 10.00,
    free_delivery_over_amount: 0,
    free_delivery_over_status: 0,
    message: 'We deliver to this location',
  });
}));

router.get('/banners', asyncHandler(async (req, res) => {
  const r = rid(req);
  const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');

  const { rows: blobRows } = await pool.query(
    `SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = 'banners'`,
    [r],
  ).catch(() => ({ rows: [] }));

  let banners = [];
  if (blobRows[0]?.data && Array.isArray(blobRows[0].data)) {
    banners = blobRows[0].data;
  } else {
    const { rows: restRows } = await pool.query('SELECT data FROM restaurants WHERE id = $1', [r]);
    if (Array.isArray(restRows[0]?.data?.banners)) {
      banners = restRows[0].data.banners;
    }
  }

  const formatted = banners
    .filter((b) => b && (b.status == null || b.status === true || b.status === 1 || b.status === 'active'))
    .map((b, idx) => {
      const img = b.image || b.image_url || `banner_${b.id || idx}.jpg`;
      const fullUrl = img.startsWith('http://') || img.startsWith('https://')
        ? img
        : `${baseUrl}/uploads/banner/${img}`;
      return {
        id: b.id || `banner_${idx + 1}`,
        title: b.title || '',
        sub_title: b.sub_title || b.subtitle || '',
        image: img,
        image_full_url: fullUrl,
        link: b.link || b.link_url || '',
        status: 1,
        sort_order: Number(b.sort_order || b.priority || idx),
      };
    });

  ok(res, formatted);
}));

router.get('/coupon/list', asyncHandler(async (req, res) => {
  const r = rid(req);
  const { rows } = await pool.query(
    `SELECT id, title, code, coupon_type, discount_type, discount, min_purchase, max_discount, usage_limit, used, start_at, expire_at, status
     FROM coupons
     WHERE restaurant_id = $1 AND status = true
       AND (expire_at IS NULL OR expire_at >= NOW())
       AND (start_at IS NULL OR start_at <= NOW())
       AND (usage_limit = 0 OR usage_limit IS NULL OR used < usage_limit)
     ORDER BY id ASC`,
    [r],
  );
  ok(res, rows);
}));

async function applyCouponHandler(req, res) {
  const r = rid(req);
  const code = String(req.query.code || req.body?.code || '').trim();
  if (!code) throw badRequest('Coupon code is required');
  const amount = Number(
    req.query.amount || req.query.order_amount || req.query.subtotal ||
    req.body?.amount || req.body?.order_amount || req.body?.subtotal || 0
  );

  const { rows } = await pool.query(
    `SELECT * FROM coupons WHERE restaurant_id = $1 AND LOWER(code) = LOWER($2)`,
    [r, code],
  );
  if (!rows[0]) throw badRequest('Invalid coupon code');
  const coupon = rows[0];

  if (coupon.status === false) throw badRequest('Coupon is inactive');
  if (coupon.expire_at && new Date(coupon.expire_at) < new Date()) {
    throw badRequest('Coupon has expired');
  }
  if (coupon.start_at && new Date(coupon.start_at) > new Date()) {
    throw badRequest('Coupon is not active yet');
  }
  if (coupon.usage_limit > 0 && coupon.used >= coupon.usage_limit) {
    throw badRequest('Coupon usage limit reached');
  }

  const minPurchase = Number(coupon.min_purchase || 0);
  if (minPurchase > 0 && amount > 0 && amount < minPurchase) {
    throw badRequest(`Minimum purchase for this coupon is ${minPurchase}`);
  }

  const discountVal = Number(coupon.discount || 0);
  let discountAmount = 0;
  if (coupon.discount_type === 'percent') {
    discountAmount = amount > 0 ? (amount * discountVal) / 100 : discountVal;
    const maxDiscount = Number(coupon.max_discount || 0);
    if (maxDiscount > 0 && discountAmount > maxDiscount) {
      discountAmount = maxDiscount;
    }
  } else {
    discountAmount = discountVal;
    if (amount > 0 && discountAmount > amount) {
      discountAmount = amount;
    }
  }
  discountAmount = Math.round(discountAmount * 100) / 100;
  const finalAmount = amount > 0 ? Math.max(0, Math.round((amount - discountAmount) * 100) / 100) : 0;

  ok(res, {
    valid: true,
    ...coupon,
    discount_amount: discountAmount,
    final_amount: finalAmount,
    coupon: {
      id: coupon.id,
      code: coupon.code,
      title: coupon.title,
      discount_type: coupon.discount_type,
      discount: discountVal,
      min_spend: minPurchase,
      expiry: coupon.expire_at,
    },
  });
}

router.get('/coupon/apply', asyncHandler(applyCouponHandler));
router.post('/coupon/apply', asyncHandler(applyCouponHandler));

/**
 * Customer Self-Service Profile & Address Book Subsystem (Task 7)
 */
function customerId(req) {
  const id = req.user?.sub || req.user?.id;
  if (!id) throw unauthorized('Authentication required');
  return String(id);
}

function deriveRoad(fullAddress, line1, city) {
  if (!fullAddress || typeof fullAddress !== 'string') return line1 || '';
  let str = fullAddress;
  if (line1 && typeof line1 === 'string' && line1.trim()) {
    str = str.replace(new RegExp(line1.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '');
  }
  if (city && typeof city === 'string' && city.trim()) {
    str = str.replace(new RegExp(city.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '');
  }
  str = str.replace(/^[,\s]+|[,\s]+$/g, '').trim();
  str = str.replace(/,\s*,/g, ',').trim();
  return str || fullAddress;
}

router.get('/customer/info', asyncHandler(async (req, res) => {
  const custId = customerId(req);
  const r = rid(req);
  const { rows } = await pool.query(
    `SELECT id, restaurant_id, name, f_name, l_name, email, phone, wallet_balance, loyalty_points, status, address, data, created_at
     FROM customers
     WHERE id = $1 AND restaurant_id = $2 AND status = TRUE`,
    [custId, r],
  );
  if (!rows[0]) throw notFound('Customer profile not found');
  const c = rows[0];
  ok(res, {
    user: {
      id: c.id,
      name: c.name || '',
      f_name: c.f_name || c.name?.split(' ')[0] || '',
      l_name: c.l_name || c.name?.split(' ').slice(1).join(' ') || '',
      email: c.email || '',
      phone: c.phone || '',
      avatar_url: c.avatar_url || c.data?.avatar_url || '',
    },
    wallet_balance: Number(Number(c.wallet_balance || 0).toFixed(2)),
    loyalty_points: Number(c.loyalty_points || 0),
    status: c.status !== false,
  });
}));

async function updateCustomerProfileHandler(req, res) {
  const custId = customerId(req);
  const r = rid(req);
  const body = req.body || {};

  const { rows: curRows } = await pool.query(
    'SELECT * FROM customers WHERE id = $1 AND restaurant_id = $2 AND status = TRUE',
    [custId, r],
  );
  if (!curRows[0]) throw notFound('Customer not found');
  const cur = curRows[0];

  const f_name = body.f_name != null ? String(body.f_name).trim() : cur.f_name;
  const l_name = body.l_name != null ? String(body.l_name).trim() : cur.l_name;
  const name = body.name != null
    ? String(body.name).trim()
    : ([f_name, l_name].filter(Boolean).join(' ') || cur.name);
  const phone = body.phone != null ? String(body.phone).trim() : cur.phone;
  const address = body.address != null ? String(body.address).trim() : cur.address;

  let passwordHash = cur.password_hash;
  if (body.password && String(body.password).length >= 6) {
    const bcrypt = require('bcryptjs');
    passwordHash = await bcrypt.hash(String(body.password), 10);
  }

  const { rows } = await pool.query(
    `UPDATE customers
     SET name = $3, f_name = $4, l_name = $5, phone = $6, address = $7, password_hash = $8, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2
     RETURNING id, restaurant_id, name, f_name, l_name, email, phone, wallet_balance, loyalty_points, status, address, data, created_at, updated_at`,
    [custId, r, name, f_name, l_name, phone, address, passwordHash],
  );
  const updated = rows[0];
  ok(res, {
    id: updated.id,
    name: updated.name,
    f_name: updated.f_name || updated.name?.split(' ')[0] || '',
    l_name: updated.l_name || updated.name?.split(' ').slice(1).join(' ') || '',
    email: updated.email,
    phone: updated.phone,
    wallet_balance: Number(Number(updated.wallet_balance || 0).toFixed(2)),
    loyalty_points: Number(updated.loyalty_points || 0),
  });
}

router.put('/customer/info', asyncHandler(updateCustomerProfileHandler));
router.put('/customer/update-profile', asyncHandler(updateCustomerProfileHandler));

router.delete('/customer/remove-account', asyncHandler(async (req, res) => {
  const custId = customerId(req);
  const r = rid(req);
  await pool.query(
    `UPDATE customers
     SET status = FALSE, email = CONCAT('deleted_', id, '@anonymized.local'), phone = NULL, name = 'Deleted Account', updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2`,
    [custId, r],
  );
  ok(res, { message: 'Account removed successfully' });
}));

router.get('/customer/address/list', asyncHandler(async (req, res) => {
  const custId = customerId(req);
  const r = rid(req);
  const { rows } = await pool.query(
    `SELECT id, customer_id, restaurant_id, address_type, contact_person_name, contact_person_number, address, line1, line2, city, postcode, latitude, longitude, is_default, data, created_at, updated_at
     FROM customer_addresses
     WHERE customer_id = $1 AND (restaurant_id = $2 OR restaurant_id IS NULL)
     ORDER BY is_default DESC, id DESC`,
    [custId, r],
  );
  const formatted = rows.map((a) => {
    const line1 = a.line1 || a.address || '';
    const line2 = a.line2 || '';
    const road = deriveRoad(a.address, line1, a.city);
    return {
      id: a.id,
      customer_id: a.customer_id,
      address_type: a.address_type,
      contact_person_name: a.contact_person_name,
      contact_person_number: a.contact_person_number,
      address: a.address,
      address_line_1: line1,
      address_line_2: line2,
      road: road || a.address,
      city: a.city,
      postcode: a.postcode,
      is_default: !!a.is_default,
    };
  });
  ok(res, formatted);
}));

router.post('/customer/address/add', asyncHandler(async (req, res) => {
  const custId = customerId(req);
  const r = rid(req);
  const body = req.body || {};

  const addrId = `addr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const addressType = body.address_type || 'home';
  const contactName = body.contact_person_name || body.name || '';
  const contactNumber = body.contact_person_number || body.phone || '';
  const line1 = body.line1 || body.address_line_1 || body.address || '';
  const line2 = body.line2 || body.address_line_2 || '';
  const addressText = body.address || [line1, line2, body.city, body.postcode].filter(Boolean).join(', ');
  const city = body.city || '';
  const postcode = (body.postcode || '').trim().toUpperCase();
  const isDefault = !!body.is_default;
  const latitude = body.latitude != null ? Number(body.latitude) : null;
  const longitude = body.longitude != null ? Number(body.longitude) : null;

  if (isDefault) {
    await pool.query(
      'UPDATE customer_addresses SET is_default = FALSE WHERE customer_id = $1 AND (restaurant_id = $2 OR restaurant_id IS NULL)',
      [custId, r],
    );
  }

  const { rows } = await pool.query(
    `INSERT INTO customer_addresses (id, customer_id, restaurant_id, address_type, contact_person_name, contact_person_number, address, line1, line2, city, postcode, latitude, longitude, is_default, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, NOW(), NOW())
     RETURNING *`,
    [
      addrId, custId, r, addressType, contactName, contactNumber,
      addressText, line1, line2, city, postcode, latitude, longitude,
      isDefault, JSON.stringify(body.data || {}),
    ],
  );
  created(res, {
    message: 'Address saved successfully',
    address_id: rows[0].id,
    id: rows[0].id,
    address_type: rows[0].address_type,
    address: rows[0].address,
    address_line_1: rows[0].line1 || rows[0].address,
    address_line_2: rows[0].line2 || '',
    city: rows[0].city,
    postcode: rows[0].postcode,
    is_default: !!rows[0].is_default,
  });
}));

async function updateAddressHandler(req, res) {
  const custId = customerId(req);
  const r = rid(req);
  const addrId = req.params.id;
  const body = req.body || {};

  const { rows: curRows } = await pool.query(
    'SELECT * FROM customer_addresses WHERE id = $1 AND customer_id = $2 AND (restaurant_id = $3 OR restaurant_id IS NULL)',
    [addrId, custId, r],
  );
  if (!curRows[0]) throw notFound('Address not found');
  const cur = curRows[0];

  const isDefault = body.is_default !== undefined ? !!body.is_default : cur.is_default;
  if (isDefault && !cur.is_default) {
    await pool.query(
      'UPDATE customer_addresses SET is_default = FALSE WHERE customer_id = $1 AND (restaurant_id = $2 OR restaurant_id IS NULL) AND id != $3',
      [custId, r, addrId],
    );
  }

  const addressType = body.address_type != null ? body.address_type : cur.address_type;
  const contactName = body.contact_person_name != null ? body.contact_person_name : cur.contact_person_name;
  const contactNumber = body.contact_person_number != null ? body.contact_person_number : cur.contact_person_number;
  const line1 = body.line1 != null ? body.line1 : (body.address_line_1 != null ? body.address_line_1 : cur.line1);
  const line2 = body.line2 != null ? body.line2 : (body.address_line_2 != null ? body.address_line_2 : cur.line2);
  const addressText = body.address != null ? body.address : cur.address;
  const city = body.city != null ? body.city : cur.city;
  const postcode = body.postcode != null ? String(body.postcode).trim().toUpperCase() : cur.postcode;
  const latitude = body.latitude != null ? Number(body.latitude) : cur.latitude;
  const longitude = body.longitude != null ? Number(body.longitude) : cur.longitude;

  const { rows } = await pool.query(
    `UPDATE customer_addresses
     SET address_type = $4, contact_person_name = $5, contact_person_number = $6,
         address = $7, line1 = $8, line2 = $9, city = $10, postcode = $11,
         latitude = $12, longitude = $13, is_default = $14, updated_at = NOW()
     WHERE id = $1 AND customer_id = $2 AND (restaurant_id = $3 OR restaurant_id IS NULL)
     RETURNING *`,
    [
      addrId, custId, r, addressType, contactName, contactNumber,
      addressText, line1, line2, city, postcode, latitude, longitude, isDefault,
    ],
  );
  ok(res, {
    message: 'Address updated successfully',
    id: rows[0].id,
    address_type: rows[0].address_type,
    address: rows[0].address,
    address_line_1: rows[0].line1 || rows[0].address,
    address_line_2: rows[0].line2 || '',
    city: rows[0].city,
    postcode: rows[0].postcode,
    is_default: !!rows[0].is_default,
  });
}

router.post('/customer/address/update/:id', asyncHandler(updateAddressHandler));
router.put('/customer/address/:id', asyncHandler(updateAddressHandler));

async function deleteAddressHandler(req, res) {
  const custId = customerId(req);
  const r = rid(req);
  const addrId = req.query.address_id || req.params.id;
  if (!addrId) throw badRequest('address_id is required');

  const { rowCount } = await pool.query(
    'DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2 AND (restaurant_id = $3 OR restaurant_id IS NULL)',
    [String(addrId), custId, r],
  );
  if (!rowCount) throw notFound('Address not found');
  ok(res, { message: 'Address deleted successfully' });
}

router.delete('/customer/address/delete', asyncHandler(deleteAddressHandler));
router.delete('/customer/address/:id', asyncHandler(deleteAddressHandler));

router.use(require('./domain'));

module.exports = router;
