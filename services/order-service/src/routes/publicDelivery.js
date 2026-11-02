/**
 * Public delivery checks for the website, with no sign-in: whether a postcode is in a delivery area, and the fee for it.
 * The tenant comes from the restaurant_id query, like the other public catalogue reads. The fee rules are the same as
 * the order route's (customerTotals.js), so the price shown before checkout is the price charged.
 */
const express = require('express');
const { ok } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { badRequest } = require('@cravedash/shared/src/errors');
const { loadOrderSettings, loadDeliveryAreas } = require('../orderSettings');
const { matchDeliveryArea, deliveryFee, round2 } = require('../customerTotals');

const router = express.Router();

function restaurantOf(req) {
  const id = String(req.query.restaurant_id || '').trim();
  if (!id) throw badRequest('restaurant_id is required');
  return id;
}

/** "Where should we deliver?" gate: is this postcode inside a delivery area, and what does it cost? */
router.get('/check-postcode', asyncHandler(async (req, res) => {
  const restaurant = restaurantOf(req);
  const postcode = String(req.query.postcode || '').trim();
  if (!postcode) throw badRequest('postcode is required');
  const area = matchDeliveryArea(postcode, await loadDeliveryAreas(restaurant));
  ok(res, {
    postcode,
    deliverable: Boolean(area),
    zone: area ? area.area_name : '',
    delivery_fee: area ? round2(area.delivery_charge) : null,
  });
}));

/** Delivery fee for a postcode and basket subtotal (0 when the free-delivery threshold is met). */
router.get('/delivery-fee', asyncHandler(async (req, res) => {
  const restaurant = restaurantOf(req);
  const postcode = String(req.query.postcode || '').trim();
  const subtotal = round2(req.query.subtotal);
  const area = postcode ? matchDeliveryArea(postcode, await loadDeliveryAreas(restaurant)) : null;
  const settings = await loadOrderSettings(restaurant);
  ok(res, {
    postcode,
    deliverable: Boolean(area),
    delivery_fee: deliveryFee({ orderType: 'delivery', subtotal, settings, area }),
  });
}));

module.exports = router;
