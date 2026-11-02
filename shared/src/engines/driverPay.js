/**
 * Rider earnings from pay plans and delivered orders. Same rules as the Delivery Reports page used before the server
 * took over the calculation (frontend/src/lib/driverPay.js):
 *  - per delivered order: the plan rate for each delivered order on the day it was placed;
 *  - by distance: rate x distance (km, or miles converted to km); a missing distance is counted, not paid;
 *  - fixed weekly / monthly: the rate spread over each day the plan covers.
 * Dates are YYYY-MM-DD strings. `to` is exclusive.
 */
const KM_PER_MILE = 1.609344;
const DAY = 86400000;

function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function policyAt(policies, date) {
  return (
    (policies || [])
      .filter((p) => p.effective_from <= date && (!p.effective_to || date <= p.effective_to))
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] || null
  );
}

function charge(order, plan) {
  if (!plan || order.status !== 'delivered' || !['order', 'distance'].includes(plan.mode)) return { amount: 0, missing: false };
  if (plan.mode === 'order') return { amount: round(Number(plan.rate)), missing: false };
  const km = Number(order.km);
  if (order.km === undefined || order.km === null || order.km === '' || !Number.isFinite(km) || km < 0) {
    return { amount: 0, missing: true };
  }
  return { amount: round((km / (plan.unit === 'mile' ? KM_PER_MILE : 1)) * Number(plan.rate)), missing: false };
}

/** Earnings for the orders placed between from (inclusive) and to (exclusive). Orders need { day, status, km }. */
function earning(policies, orders, from, to) {
  let total = 0;
  let missing = 0;
  orders.forEach((o) => {
    if (o.day < from || o.day >= to) return;
    const result = charge(o, policyAt(policies, o.day));
    total += result.amount;
    if (result.missing) missing += 1;
  });
  for (let date = new Date(`${from}T00:00Z`), end = new Date(`${to}T00:00Z`); date < end; date = new Date(date.getTime() + DAY)) {
    const d = date.toISOString().slice(0, 10);
    const plan = policyAt(policies, d);
    if (!plan) continue;
    if (plan.mode === 'weekly') total += Number(plan.rate) / 7;
    if (plan.mode === 'monthly') {
      total += Number(plan.rate) / new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    }
  }
  return { amount: round(total), missing };
}

/**
 * The summary the report shows for one rider: earned in the period, the amount owed up to the end date (from the first
 * plan), and payments recorded. Nothing is posted; this only reads.
 */
function riderSummary({ policies, orders, payments, from, to }) {
  const period = earning(policies, orders, from, to);
  const start = policies.map((p) => p.effective_from).sort()[0];
  const accrued = start && start < to ? earning(policies, orders, start, to) : { amount: 0, missing: 0 };
  const paidAll = payments.filter((p) => p.date < to).reduce((s, p) => s + p.amount, 0);
  const paidInPeriod = payments.filter((p) => p.date >= from && p.date < to).reduce((s, p) => s + p.amount, 0);
  return {
    earned: period.amount,
    missing_distances: period.missing,
    paid_in_period: round(paidInPeriod),
    outstanding: round(Math.max(0, accrued.amount - paidAll)),
    credit: round(paidAll > accrued.amount ? paidAll - accrued.amount : 0),
  };
}

module.exports = { policyAt, charge, earning, riderSummary, round };
