const { listRows, appendRow, round2, readDoc, writeDoc } = require('./helpers');
const pool = require('../db');

/**
 * Allocate tips for a period from paid orders with tip > 0.
 * Uses tips_config from ops domain or defaults: FOH 60% / BOH 40%, split by hours if attendance given.
 */
async function allocate(restaurantId, { from, to, by }) {
  const fromD = from || new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const toD = to || new Date().toISOString().slice(0, 10);
  const cfg = await readDoc(restaurantId, 'ops', 'tips_config', {
    foh_percent: 60,
    boh_percent: 40,
  });
  // BUG-018: a configured 0 is a real value (it was replaced by the default), and the two pools must add up to all tips.
  const percentOf = (value, fallback) => (value === undefined || value === null || value === '' ? fallback : Number(value));
  const fohRaw = percentOf(cfg.foh_percent, 60);
  const bohRaw = percentOf(cfg.boh_percent, 40);
  if (!Number.isFinite(fohRaw) || !Number.isFinite(bohRaw) || fohRaw < 0 || bohRaw < 0 || fohRaw + bohRaw !== 100) {
    const err = new Error('FOH and BOH percentages must be zero or more and add up to 100');
    err.status = 400;
    err.code = 'BAD_REQUEST';
    throw err;
  }
  const fohPct = fohRaw / 100;
  const bohPct = bohRaw / 100;

  const { rows: orders } = await pool.query(
    `SELECT id, tip, created_at FROM orders
     WHERE restaurant_id = $1 AND COALESCE(tip,0) > 0
       AND payment_status = 'paid'
       AND created_at::date >= $2::date AND created_at::date <= $3::date`,
    [restaurantId, fromD, toD],
  );
  const totalTips = round2(orders.reduce((s, o) => s + (+o.tip || 0), 0));
  const fohPool = round2(totalTips * fohPct);
  const bohPool = round2(totalTips * bohPct);

  const staff = await readDoc(restaurantId, 'payroll', 'payroll_staff', []);
  const attendance = await listRows(restaurantId, 'payroll', 'payroll_attendance');
  const inRange = attendance.filter((a) => {
    const d = String(a.date || '').slice(0, 10);
    return d >= fromD && d <= toD;
  });

  const fohStaff = (Array.isArray(staff) ? staff : []).filter((s) =>
    /server|foh|front|waiter|manager|shift/i.test(String(s.designation || s.emp_type || '')));
  const bohStaff = (Array.isArray(staff) ? staff : []).filter((s) =>
    /kitchen|chef|cook|boh/i.test(String(s.designation || '')));
  const fohList = fohStaff.length ? fohStaff : (Array.isArray(staff) ? staff : []).slice(0, Math.ceil(staff.length / 2) || 0);
  const bohList = bohStaff.length ? bohStaff : (Array.isArray(staff) ? staff : []).slice(Math.ceil(staff.length / 2));

  function splitPool(poolAmt, people) {
    if (!people.length || poolAmt <= 0) return [];
    const hours = people.map((p) => {
      const name = p.staff || p.name;
      const hrs = inRange
        .filter((a) => String(a.staff) === String(name))
        .reduce((s, a) => s + (+a.hours || 0), 0);
      return { name, hours: hrs || 1 };
    });
    const totalH = hours.reduce((s, h) => s + h.hours, 0) || hours.length;
    return hours.map((h) => ({
      staff: h.name,
      hours: h.hours,
      amount: round2(poolAmt * (h.hours / totalH)),
    }));
  }

  const allocations = [
    ...splitPool(fohPool, fohList).map((a) => ({ ...a, pool: 'foh' })),
    ...splitPool(bohPool, bohList).map((a) => ({ ...a, pool: 'boh' })),
  ];

  const run = await appendRow(restaurantId, 'ops', 'tips_runs', {
    from: fromD,
    to: toD,
    total_tips: totalTips,
    order_count: orders.length,
    foh_pool: fohPool,
    boh_pool: bohPool,
    allocations,
    status: 'closed',
    closed_at: new Date().toISOString(),
    by: by || null,
  });

  return { run, orders: orders.length, total_tips: totalTips, allocations };
}

async function report(restaurantId) {
  const runs = await listRows(restaurantId, 'ops', 'tips_runs');
  return {
    run_count: runs.length,
    last: runs.length ? runs[runs.length - 1] : null,
    total_allocated: round2(runs.reduce((s, r) => s + (+r.total_tips || 0), 0)),
  };
}

module.exports = { allocate, report };
