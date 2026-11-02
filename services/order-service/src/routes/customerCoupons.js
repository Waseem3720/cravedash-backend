/**
 * Coupons for the signed-in website customer: the codes that are open now, and whether one applies to a basket. The
 * same rules as checkout (customerTotals.js) decide it; applying a coupon here does not use it up, the order does.
 */
const pool = require('@cravedash/shared/src/db');
const { ok } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { requireCustomer } = require('@cravedash/shared/src/authMiddleware');
const { badRequest } = require('@cravedash/shared/src/errors');
const { couponDiscount, couponProblem, normalizeCode, round2 } = require('../customerTotals');
const express = require('express');

const router = express.Router();

/** A coupon as the website shows it. */
function couponView(row) {
  return {
    id: row.id,
    code: row.code,
    title: row.title || row.code,
    discount_type: row.discount_type,
    discount: Number(row.discount) || 0,
    min_purchase: Number(row.min_purchase) || 0,
    max_discount: Number(row.max_discount) || 0,
    expires_at: row.expire_at || null
  };
}

router.get('/list', requireCustomer, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM coupons
      WHERE restaurant_id = $1 AND status IS DISTINCT FROM FALSE
        AND (start_at IS NULL OR start_at <= NOW())
        AND (expire_at IS NULL OR expire_at >= NOW())
        AND (usage_limit = 0 OR used < usage_limit)
      ORDER BY created_at DESC`,
    [req.customer.restaurant_id],
  );
  ok(res, { coupons: rows.map(couponView) });
}));

router.post('/apply', requireCustomer, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const code = normalizeCode(body.code);
  if (!code) throw badRequest('Enter a coupon code');
  const subtotal = Math.max(0, Number(body.subtotal) || 0);
  const { rows } = await pool.query(
    'SELECT * FROM coupons WHERE restaurant_id = $1 AND UPPER(code) = $2',
    [req.customer.restaurant_id, code],
  );
  const coupon = rows[0];
  const problem = couponProblem(coupon, { now: new Date(), subtotal });
  if (problem) throw badRequest(problem);
  if (Number(coupon.usage_limit || 0) > 0 && Number(coupon.used || 0) >= Number(coupon.usage_limit)) {
    throw badRequest('This coupon has been used up');
  }
  ok(res, { ...couponView(coupon), discount_amount: round2(couponDiscount(subtotal, coupon)) });
}));

module.exports = router;
