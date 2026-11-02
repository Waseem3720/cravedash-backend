/**
 * Table booking for website customers. Tables come from dining_tables and bookings are written to bookings, so the
 * website and the dashboard read the same data. Availability is open to anyone; booking needs a customer sign-in.
 * The table is chosen by the system: the smallest free table that seats the party. Two bookings never share a table
 * for overlapping times, because the candidate tables are locked while a booking is written.
 */
const crypto = require('crypto');
const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { requireCustomer } = require('@cravedash/shared/src/authMiddleware');
const { AppError, badRequest } = require('@cravedash/shared/src/errors');

const customerReservations = express.Router();

const TIME_ZONE = 'Europe/London';
const FIRST_START = '12:00';
const LAST_START = '21:30';
const SLOT_MINUTES = 30;
const VISIT_MINUTES = 90;
const MAX_GUESTS = 8;
const DAYS_AHEAD = 30;
const CLOSED_STATUSES = ['cancelled', 'canceled', 'no_show'];

/** The London wall-clock parts of an instant. */
function londonParts(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +(o.hour === '24' ? '0' : o.hour), min: +o.minute };
}

/** The instant at which London shows this date and time (handles British summer time). */
function londonInstant(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wanted;
  for (let i = 0; i < 2; i += 1) {
    const p = londonParts(guess);
    guess += wanted - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  }
  return new Date(guess);
}

const isoDate = (p) => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;

/** The slot list the website shows: every 30 minutes from 12:00 to 21:30. */
function slotTimes() {
  const out = [];
  for (let t = 12 * 60; t <= 21 * 60 + 30; t += SLOT_MINUTES) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  return out;
}

function parseRequest(body) {
  const date = String(body.date || '').trim();
  const time = String(body.time || '').trim();
  const guests = Number(body.guests);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('date must be a date (YYYY-MM-DD)');
  if (!slotTimes().includes(time)) throw badRequest('time must be a booking slot between 12:00 and 21:30');
  if (!Number.isInteger(guests) || guests < 1 || guests > MAX_GUESTS) throw badRequest(`guests must be a whole number from 1 to ${MAX_GUESTS}`);
  const today = isoDate(londonParts(Date.now()));
  const last = isoDate(londonParts(Date.now() + DAYS_AHEAD * 24 * 60 * 60 * 1000));
  if (date < today) throw badRequest('That date has passed');
  if (date > last) throw badRequest(`Bookings open up to ${DAYS_AHEAD} days ahead`);
  const start = londonInstant(date, time);
  const end = new Date(start.getTime() + VISIT_MINUTES * 60 * 1000);
  return { date, time, guests, start, end };
}

/** The smallest free table that seats the party, or null. Runs inside the caller's client (locks are taken there). */
async function freeTableFor(client, restaurantId, guests, start, end) {
  const { rows } = await client.query(
    `SELECT t.id, t.number, t.seats FROM dining_tables t
      WHERE t.restaurant_id = $1 AND t.active IS DISTINCT FROM FALSE AND t.seats >= $2
        AND NOT EXISTS (
          SELECT 1 FROM bookings b
           WHERE b.restaurant_id = t.restaurant_id AND b.table_id = t.id
             AND NOT (b.status = ANY($5::text[]))
             AND b.booked_at < $4 AND b.booked_at + ($6 * INTERVAL '1 minute') > $3)
      ORDER BY t.seats ASC, t.number ASC
      LIMIT 1
      FOR UPDATE OF t`,
    [restaurantId, guests, start, end, CLOSED_STATUSES, VISIT_MINUTES],
  );
  return rows[0] || null;
}

/** The booking rules the website reads (the same defaults as the old booking page: 12:00 to 22:00, 90 minute visits). */
const SETTINGS = {
  enabled: true,
  days: [0, 1, 2, 3, 4, 5, 6],
  open: '12:00',
  close: '22:00',
  step: SLOT_MINUTES,
  duration: VISIT_MINUTES,
  max_guests: MAX_GUESTS,
  lead_min: 60,
  advance_days: DAYS_AHEAD,
  hidden: [],
  max_per_slot: 6,
};

async function restaurantOrThrow(req) {
  const restaurantId = String(req.query.restaurant_id || '').trim();
  if (!restaurantId) throw badRequest('restaurant_id is required');
  const { rows: known } = await pool.query('SELECT id, name FROM restaurants WHERE id = $1', [restaurantId]);
  if (!known[0]) throw badRequest('Unknown restaurant');
  return known[0];
}

customerReservations.get('/customer/reservations/settings', asyncHandler(async (req, res) => {
  const restaurant = await restaurantOrThrow(req);
  ok(res, { reservation_settings: SETTINGS, restaurant_name: restaurant.name });
}));

/** One table, if it is active, seats the party, and is free for the visit. Used when the customer chose a table. */
async function tableFreeFor(client, restaurantId, tableId, guests, start, end) {
  const { rows } = await client.query(
    `SELECT t.id, t.number, t.seats FROM dining_tables t
      WHERE t.restaurant_id = $1 AND t.id = $2 AND t.active IS DISTINCT FROM FALSE AND t.seats >= $3
        AND NOT EXISTS (
          SELECT 1 FROM bookings b
           WHERE b.restaurant_id = t.restaurant_id AND b.table_id = t.id
             AND NOT (b.status = ANY($6::text[]))
             AND b.booked_at < $5 AND b.booked_at + ($7 * INTERVAL '1 minute') > $4)
      FOR UPDATE OF t`,
    [restaurantId, tableId, guests, start, end, CLOSED_STATUSES, VISIT_MINUTES],
  );
  return rows[0] || null;
}

/** Every active table of the restaurant for a slot, with whether it is free for this party size and visit. */
customerReservations.get('/customer/reservations/tables', asyncHandler(async (req, res) => {
  const restaurantId = (await restaurantOrThrow(req)).id;
  const request = parseRequest({ date: req.query.date, time: req.query.time, guests: req.query.guests });
  const { rows } = await pool.query(
    `SELECT t.id, t.number, t.seats,
            NOT EXISTS (
              SELECT 1 FROM bookings b
               WHERE b.restaurant_id = t.restaurant_id AND b.table_id = t.id
                 AND NOT (b.status = ANY($4::text[]))
                 AND b.booked_at < $3 AND b.booked_at + ($5 * INTERVAL '1 minute') > $2) AS free
       FROM dining_tables t
      WHERE t.restaurant_id = $1 AND t.active IS DISTINCT FROM FALSE
      ORDER BY t.seats ASC, t.number ASC`,
    [restaurantId, request.start, request.end, CLOSED_STATUSES, VISIT_MINUTES],
  );
  ok(res, {
    date: request.date,
    time: request.time,
    guests: request.guests,
    tables: rows.map((t) => ({
      id: t.id,
      number: t.number,
      seats: t.seats,
      free: !!t.free && t.seats >= request.guests,
      fits: t.seats >= request.guests,
    })),
  });
}));

customerReservations.get('/customer/reservations/availability', asyncHandler(async (req, res) => {
  const restaurantId = (await restaurantOrThrow(req)).id;
  // Without a time, the answer is every slot of the day with its free capacity (the booking page's list).
  if (req.query.time === undefined || req.query.time === '') {
    const date = String(req.query.date || '').trim();
    const guests = Number(req.query.guests);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('date must be a date (YYYY-MM-DD)');
    if (!Number.isInteger(guests) || guests < 1 || guests > MAX_GUESTS) {
      throw badRequest(`guests must be a whole number from 1 to ${MAX_GUESTS}`);
    }
    const slots = [];
    for (const time of slotTimes()) {
      const request = parseRequest({ date, time, guests });
      const table = await freeTableFor(pool, restaurantId, guests, request.start, request.end);
      slots.push({ time, available: !!table, remaining_capacity: table ? 1 : 0 });
    }
    return ok(res, { date, guests, slots: slots.filter((slot) => slot.available) });
  }
  const request = parseRequest({ date: req.query.date, time: req.query.time, guests: req.query.guests });
  const table = await freeTableFor(pool, restaurantId, request.guests, request.start, request.end);
  ok(res, {
    date: request.date,
    time: request.time,
    guests: request.guests,
    available: !!table,
    table: table ? { id: table.id, number: table.number, seats: table.seats } : null,
    visit_minutes: VISIT_MINUTES,
  });
}));

customerReservations.post('/customer/reservations', requireCustomer, asyncHandler(async (req, res) => {
  const { id: customerId, restaurant_id: restaurantId } = req.customer;
  const request = parseRequest(req.body || {});
  const note = String((req.body || {}).notes || (req.body || {}).note || '').trim().slice(0, 500);
  const { rows: customers } = await pool.query(
    'SELECT id, name, email, phone FROM customers WHERE id = $1 AND restaurant_id = $2 AND status IS DISTINCT FROM FALSE',
    [customerId, restaurantId],
  );
  const customer = customers[0];
  if (!customer) throw new AppError('Customer account not found', 403, 'FORBIDDEN');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A table the customer chose is used only if it is still free and seats the party. Otherwise the restaurant picks one.
    const preferred = String((req.body || {}).preferred_table_id || '').trim();
    let table = null;
    if (preferred) {
      table = await tableFreeFor(client, restaurantId, preferred, request.guests, request.start, request.end);
      if (!table) {
        await client.query('ROLLBACK');
        throw new AppError('That table is no longer free for this time. Please choose another table.', 409, 'CONFLICT');
      }
    } else {
      table = await freeTableFor(client, restaurantId, request.guests, request.start, request.end);
    }
    if (!table) {
      await client.query('ROLLBACK');
      throw new AppError('No table is free for that time. Please choose another time.', 409, 'CONFLICT');
    }
    const id = `bk_${crypto.randomBytes(8).toString('hex')}`;
    // The name and phone the guest typed for this visit win; the account details are the fallback.
    const guestName = String((req.body || {}).name || '').trim().slice(0, 100) || customer.name || null;
    const guestPhone = String((req.body || {}).phone || '').trim().slice(0, 30) || customer.phone || null;
    await client.query(
      `INSERT INTO bookings (id, restaurant_id, customer_name, customer_phone, party_size, table_id, booked_at, status, note, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'booked', $8, $9::jsonb, NOW(), NOW())`,
      [
        id, restaurantId, guestName, guestPhone, request.guests, table.id, request.start, note,
        JSON.stringify({ source: 'website', customer_id: customer.id, email: customer.email || null, duration_minutes: VISIT_MINUTES }),
      ],
    );
    await client.query('COMMIT');
    ok(res, {
      id,
      status: 'booked',
      date: request.date,
      time: request.time,
      guests: request.guests,
      table: { id: table.id, number: table.number, seats: table.seats },
      booked_at: request.start.toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

customerReservations.get('/customer/reservations', requireCustomer, asyncHandler(async (req, res) => {
  const { id: customerId, restaurant_id: restaurantId } = req.customer;
  const { rows } = await pool.query(
    `SELECT b.id, b.status, b.party_size, b.booked_at, b.note, t.number AS table_number, t.seats AS table_seats
       FROM bookings b LEFT JOIN dining_tables t ON t.id = b.table_id AND t.restaurant_id = b.restaurant_id
      WHERE b.restaurant_id = $1 AND b.data->>'customer_id' = $2
      ORDER BY b.booked_at DESC LIMIT 50`,
    [restaurantId, customerId],
  );
  ok(res, { reservations: rows.map((r) => ({
    id: r.id, status: r.status, guests: r.party_size, booked_at: r.booked_at, note: r.note || '',
    table: r.table_number == null ? null : { number: r.table_number, seats: r.table_seats },
  })) });
}));

module.exports = { customerReservations, londonInstant, slotTimes };
