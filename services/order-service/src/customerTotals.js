/**
 * Pure totals for a customer order (Phase 4b). No database access here: the route reads the settings, the delivery areas
 * and the coupon, and passes them in. The rules match the website's current calculation, with the server as the authority.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Settings flags come from the dashboard form: true, 'true', 1 or '1' mean on. */
const isOn = (v) => v === true || v === 'true' || v === 1 || v === '1';

/** Uppercase, and spaces removed. Used for postcodes and coupon codes. */
const normalizeCode = (v) => String(v || '').toUpperCase().replace(/\s+/g, '');

/**
 * Coupon discount (mirrors website lib/product.js couponDiscount): min purchase, percent or amount, capped by max_discount,
 * and never more than the subtotal.
 */
function couponDiscount(subtotal, coupon) {
  if (!coupon || subtotal <= 0) return 0;
  const minPurchase = Number(coupon.min_purchase || 0);
  if (minPurchase > 0 && subtotal < minPurchase) return 0;
  const value = Number(coupon.discount || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const type = String(coupon.discount_type || 'amount').toLowerCase();
  let amount = type === 'percent' || type === 'percentage' ? (subtotal * value) / 100 : value;
  const cap = Number(coupon.max_discount || 0);
  if (cap > 0) amount = Math.min(amount, cap);
  return round2(Math.max(0, Math.min(subtotal, amount)));
}

/**
 * Delivery area for a postcode. The full postcode is tried first, then the outward code (the postcode without its last
 * three characters). Returns null when nothing matches.
 */
function matchDeliveryArea(postcode, areas) {
  const full = normalizeCode(postcode);
  if (!full || !Array.isArray(areas)) return null;
  const outward = full.length > 3 ? full.slice(0, -3) : full;
  const byName = (name) => areas.find((a) => a && normalizeCode(a.area_name) === name);
  return byName(full) || byName(outward) || null;
}

/** Delivery fee: 0 for collection, 0 when the free threshold is met, otherwise the matched area's charge. */
function deliveryFee({ orderType, subtotal, settings, area }) {
  if (orderType !== 'delivery') return 0;
  const threshold = Number(settings.free_delivery_over_amount || 0);
  if (isOn(settings.free_delivery_over_status) && threshold > 0 && subtotal >= threshold) return 0;
  return round2(area ? area.delivery_charge : 0);
}

/**
 * All money for one order. The client's own total, discount and delivery charge are never an input.
 */
function computeTotals({ subtotal, orderType, settings, area, couponAmount }) {
  const sub = round2(subtotal);
  const discount = round2(Math.min(sub, Number(couponAmount) || 0));
  const delivery = deliveryFee({ orderType, subtotal: sub, settings, area });
  const service = isOn(settings.service_fee_status) ? round2(settings.service_fee) : 0;
  const bag = isOn(settings.bag_charge_status) ? round2(settings.bag_charge) : 0;
  const total = round2(sub - discount + delivery + service + bag);
  return {
    subtotal: sub,
    discount,
    delivery_charge: delivery,
    service_charge: round2(service + bag),
    service_fee: service,
    bag_charge: bag,
    total,
  };
}

/** A coupon that cannot be used now. Returns the reason, or null when it is valid at `now`. */
function couponProblem(coupon, { now, subtotal }) {
  if (!coupon || coupon.status === false) return 'Coupon code is not valid';
  if (coupon.start_at && now < new Date(coupon.start_at)) return 'Coupon is not active yet';
  if (coupon.expire_at && now > new Date(coupon.expire_at)) return 'Coupon has expired';
  const minPurchase = Number(coupon.min_purchase || 0);
  if (minPurchase > 0 && subtotal < minPurchase) return `Minimum purchase for this coupon is £${minPurchase.toFixed(2)}`;
  return null;
}

module.exports = {
  round2,
  isOn,
  normalizeCode,
  couponDiscount,
  matchDeliveryArea,
  deliveryFee,
  computeTotals,
  couponProblem,
};
