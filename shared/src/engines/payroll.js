const { readDoc, appendRow, listRows, round2, pool } = require('./helpers');
const accounting = require('./accounting');

/**
 * One payroll close at a time per restaurant. The check for an earlier close and the write of the new run must not
 * interleave with another close of the same period (BUG-019).
 */
async function withPayrollLock(restaurantId, fn) {
  const key = `payroll:${restaurantId}`;
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    return await fn();
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); } catch { /* ignore */ }
    client.release();
  }
}

async function getStaff(restaurantId) {
  const list = await readDoc(restaurantId, 'payroll', 'payroll_staff', []);
  return Array.isArray(list) ? list : [];
}

function hoursBetween(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = String(start).split(':').map(Number);
  const [eh, em] = String(end).split(':').map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return 0;
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return round2(mins / 60);
}

async function postAttendance(restaurantId, body) {
  const hours = body.hours != null
    ? round2(+body.hours)
    : hoursBetween(body.start, body.end);
  return appendRow(restaurantId, 'payroll', 'payroll_attendance', {
    staff: body.staff,
    staff_id: body.staff_id || null,
    date: body.date || new Date().toISOString().slice(0, 10),
    start: body.start || null,
    end: body.end || null,
    hours,
    note: body.note || null,
    by: body.by || null,
  });
}

/**
 * Close a payroll run for a date range: attendance × rates → payslip lines.
 */
async function closeRun(restaurantId, input) {
  return withPayrollLock(restaurantId, () => closeRunLocked(restaurantId, input));
}

async function closeRunLocked(restaurantId, {
  from, to, note, by, post_journal,
}) {
  const staff = await getStaff(restaurantId);
  const attendance = await listRows(restaurantId, 'payroll', 'payroll_attendance');
  const fromD = from || new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const toD = to || new Date().toISOString().slice(0, 10);

  // BUG-019: a period that overlaps an earlier closed run is refused, so wages are never posted twice.
  const existingRuns = await listRows(restaurantId, 'payroll', 'payroll_runs');
  const overlap = existingRuns.find((r) => r.status === 'closed' && String(r.from) <= toD && String(r.to) >= fromD);
  if (overlap) {
    const err = new Error(`Payroll for ${overlap.from} to ${overlap.to} is already closed`);
    err.status = 409;
    err.code = 'CONFLICT';
    throw err;
  }

  const inRange = attendance.filter((a) => {
    const d = String(a.date || '').slice(0, 10);
    return d >= fromD && d <= toD;
  });

  const lines = [];
  for (const s of staff) {
    const name = s.staff || s.name;
    const rows = inRange.filter((a) => String(a.staff) === String(name) || String(a.staff_id) === String(s.id));
    const hours = round2(rows.reduce((sum, a) => sum + (+a.hours || hoursBetween(a.start, a.end)), 0));
    let gross = 0;
    if (String(s.emp_type || '').toLowerCase() === 'salaried' || (+s.base > 0 && !(+s.hourly > 0))) {
      // Prorate monthly base by calendar days in range
      const days = Math.max(1, Math.round((new Date(toD) - new Date(fromD)) / 864e5) + 1);
      gross = round2((+s.base || 0) * (days / 30));
    } else {
      gross = round2(hours * (+s.hourly || 0));
    }
    const commissionPct = +s.commission || 0;
    const commission = round2(gross * (commissionPct / 100));
    const total = round2(gross + commission);
    if (total <= 0 && hours <= 0) continue;
    lines.push({
      staff: name,
      staff_id: s.id || null,
      emp_type: s.emp_type || null,
      hours,
      base_pay: gross,
      commission,
      total,
      attendance_rows: rows.length,
    });
  }

  const runTotal = round2(lines.reduce((s, l) => s + l.total, 0));
  // The run id is chosen first so the wages journal can reference it. The journal is posted before the run is saved:
  // if posting fails, nothing is saved, the period stays open, and the error reaches the caller (it used to be dropped).
  const runId = `payroll_runs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  let journal = null;
  if (post_journal !== false && runTotal > 0) {
    journal = await accounting.postJournal(restaurantId, {
      date: toD,
      description: `Payroll ${fromD} → ${toD}`,
      source: 'payroll',
      ref: runId,
      by,
      lines: [
        { account: '5100 Wages', debit: runTotal, credit: 0 },
        { account: '2300 Wages payable', debit: 0, credit: runTotal },
      ],
    });
  }
  let run;
  try {
    run = await appendRow(restaurantId, 'payroll', 'payroll_runs', {
      id: runId,
      from: fromD,
      to: toD,
      note: note || null,
      status: 'closed',
      lines,
      total: runTotal,
      closed_at: new Date().toISOString(),
      by: by || null,
    });
  } catch (err) {
    // The journal is already posted but the run is not saved. Post the opposite journal so the ledger carries no wages
    // for a period that is not closed. If that also fails, the mismatch is logged for reconciliation.
    if (journal) {
      await accounting.postJournal(restaurantId, {
        date: toD,
        description: `Reversal of payroll ${fromD} → ${toD} (run not saved)`,
        source: 'payroll',
        ref: `${runId}:reversal`,
        by,
        lines: [
          { account: '5100 Wages', debit: 0, credit: runTotal },
          { account: '2300 Wages payable', debit: runTotal, credit: 0 },
        ],
      }).catch((revErr) => console.error('[payroll] reversal failed; reconcile', runId, revErr.message));
    }
    throw err;
  }

  return { run, journal };
}

async function report(restaurantId) {
  const runs = await listRows(restaurantId, 'payroll', 'payroll_runs');
  const attendance = await listRows(restaurantId, 'payroll', 'payroll_attendance');
  const staff = await getStaff(restaurantId);
  return {
    staff_count: staff.length,
    attendance_count: attendance.length,
    run_count: runs.length,
    last_run: runs.length ? runs[runs.length - 1] : null,
    total_paid: round2(runs.reduce((s, r) => s + (+r.total || 0), 0)),
  };
}

module.exports = {
  getStaff,
  postAttendance,
  closeRun,
  report,
  hoursBetween,
};
