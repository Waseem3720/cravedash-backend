const pool = require('../db');
const { readDoc, appendRow, listRows, round2, ensureDomainTables } = require('./helpers');

async function getCoa(restaurantId) {
  const coa = await readDoc(restaurantId, 'accounting', 'coa', []);
  return Array.isArray(coa) ? coa : [];
}

async function getMapping(restaurantId) {
  const m = await readDoc(restaurantId, 'accounting', 'acc_mapping', {});
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

/**
 * Post a balanced journal. lines: [{ account, account_code, debit, credit, description }]
 */
/** Journal sources written only by the sales posting engine. A client cannot create them through postJournal. */
const PROTECTED_JOURNAL_SOURCES = new Set(['sale', 'sale_reversal', 'sale_refund']);

/**
 * Validates a journal and returns its normalized lines and totals. Throws on an unbalanced or malformed journal.
 * `system` is true only for the sales posting engine, which is the one trusted path for protected sources.
 */
function prepareJournal({ date, description, lines, source, ref, by, tax }, { system = false } = {}) {
  if (!system && PROTECTED_JOURNAL_SOURCES.has(String(source || '').trim().toLowerCase())) {
    const err = new Error(`Journal source "${source}" is written only by the sales posting engine`);
    err.status = 403; err.code = 'FORBIDDEN'; throw err;
  }
  const rawLines = Array.isArray(lines) ? lines : [];
  if (rawLines.length < 2) {
    const err = new Error('Journal needs at least two lines');
    err.status = 400; err.code = 'BAD_REQUEST'; throw err;
  }
  let debit = 0;
  let credit = 0;
  const normalized = rawLines.map((l, i) => {
    const d = round2(+l.debit || 0);
    const c = round2(+l.credit || 0);
    if (d < 0 || c < 0 || (d > 0 && c > 0)) {
      const err = new Error(`Line ${i + 1}: use debit OR credit, not both/negative`);
      err.status = 400; err.code = 'BAD_REQUEST'; throw err;
    }
    debit += d;
    credit += c;
    return {
      account: l.account || l.account_code || l.code,
      account_name: l.account_name || l.name || null,
      debit: d,
      credit: c,
      description: l.description || description || null,
    };
  });
  debit = round2(debit);
  credit = round2(credit);
  if (Math.abs(debit - credit) > 0.009) {
    const err = new Error(`Journal unbalanced: debit £${debit.toFixed(2)} ≠ credit £${credit.toFixed(2)}`);
    err.status = 400; err.code = 'BAD_REQUEST'; throw err;
  }
  return {
    date: date || new Date().toISOString().slice(0, 10),
    description: description || null,
    source: source || 'manual',
    ref: ref || null,
    debit,
    credit,
    normalized,
    by: by || null,
    tax: tax || null,
  };
}

/** Prepares a system journal (sale or sale_reversal). Only the sales posting engine calls this. */
function prepareSystemJournal(input) {
  return prepareJournal(input, { system: true });
}

/** Writes a prepared journal and its ledger rows with one client. The caller owns BEGIN/COMMIT/ROLLBACK. */
async function writeJournalTx(client, restaurantId, p) {
  const journal = await insertRowTx(client, restaurantId, 'accounting', 'acc_journals', {
    date: p.date,
    description: p.description,
    source: p.source,
    ref: p.ref,
    debit: p.debit,
    credit: p.credit,
    lines: p.normalized,
    by: p.by,
    tax: p.tax,
  });
  const ledgerEntries = [];
  for (const line of p.normalized) {
    ledgerEntries.push(await insertRowTx(client, restaurantId, 'accounting', 'acc_ledger', {
      journal_id: journal.id,
      date: journal.date,
      account: line.account,
      account_name: line.account_name,
      description: line.description || journal.description,
      debit: line.debit,
      credit: line.credit,
      source: journal.source,
      ref: journal.ref,
    }));
  }
  return { journal, ledger: ledgerEntries };
}

/**
 * Post a balanced journal. lines: [{ account, account_code, debit, credit, description }]
 * The journal row and every ledger row commit together, or none of them does.
 */
async function postJournal(restaurantId, input) {
  const prepared = prepareJournal(input);
  await ensureDomainTables();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await writeJournalTx(client, restaurantId, prepared);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** appendRow inside an open transaction (same id rules and conflict check as appendRow). */
async function insertRowTx(client, restaurantId, domain, collection, payload) {
  const id = String(payload.id || `${collection}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`);
  const data = Object.assign({}, payload, { id, created_at: payload.created_at || new Date().toISOString() });
  const { rows } = await client.query(
    `INSERT INTO domain_rows (restaurant_id, domain, collection, id, data, updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
     ON CONFLICT (restaurant_id, domain, collection, id) DO NOTHING
     RETURNING id, data, updated_at`,
    [restaurantId, domain, collection, id, JSON.stringify(data)],
  );
  if (!rows[0]) {
    const err = new Error('Ledger event id already exists');
    err.status = 400;
    err.code = 'BAD_REQUEST';
    throw err;
  }
  return Object.assign({}, rows[0].data, { id: rows[0].id, _at: rows[0].updated_at });
}

async function postExpense(restaurantId, body) {
  const amount = round2(+body.amount || +body.debit || 0);
  if (!amount) {
    const err = new Error('Expense amount required');
    err.status = 400; err.code = 'BAD_REQUEST'; throw err;
  }
  const expenseAccount = body.account || body.expense_account || '5200 Rent';
  const payAccount = body.pay_from || body.credit_account || '1010 Bank';
  const journal = await postJournal(restaurantId, {
    date: body.date,
    description: body.description || body.note || 'Expense',
    source: 'expense',
    ref: body.reference || null,
    by: body.by,
    lines: [
      { account: expenseAccount, debit: amount, credit: 0, description: body.description },
      { account: payAccount, debit: 0, credit: amount, description: body.description },
    ],
  });
  const expense = await appendRow(restaurantId, 'accounting', 'acc_expenses', {
    date: body.date || new Date().toISOString().slice(0, 10),
    account: expenseAccount,
    description: body.description || body.note || 'Expense',
    debit: amount,
    credit: 0,
    journal_id: journal.journal.id,
    by: body.by || null,
  });
  return { expense, ...journal };
}

function reconciliationError(message) {
  const err = new Error(`${message}: manual reconciliation required`);
  err.status = 409;
  err.code = 'CONFLICT';
  return err;
}

/** The newest journal with this source for an order (source 'sale' or 'sale_reversal'), or null. Reads through db. */
async function findOrderJournal(db, restaurantId, source, orderId) {
  const { rows } = await db.query(
    `SELECT id, data FROM domain_rows
      WHERE restaurant_id = $1 AND domain = 'accounting' AND collection = 'acc_journals'
        AND data->>'source' = $2 AND data->>'ref' = $3
      ORDER BY updated_at DESC LIMIT 1`,
    [restaurantId, source, String(orderId)],
  );
  return rows[0] ? { id: rows[0].id, ...rows[0].data } : null;
}

/** One ledger row's identity for comparison: account, debit and credit (amounts to the penny). */
function ledgerKey(account, debit, credit) {
  return `${String(account)}|${round2(+debit || 0).toFixed(2)}|${round2(+credit || 0).toFixed(2)}`;
}

/**
 * Compares a journal with its ledger rows by content. Returns a list of problems (empty when complete): missing rows,
 * extra or duplicate rows, and rows whose account or amounts differ from the journal line they should match.
 */
async function journalLedgerProblems(db, restaurantId, journal) {
  const problems = [];
  const lines = Array.isArray(journal.lines) ? journal.lines : [];
  if (!validStoredLines(lines)) {
    problems.push('journal lines are not a balanced, well-formed posting');
    return problems;
  }
  const headerDebit = round2(lines.reduce((s, l) => s + (+l.debit || 0), 0));
  if (Math.abs(headerDebit - round2(+journal.debit || 0)) > 0.005) problems.push('journal header debit does not match its lines');
  const { rows } = await db.query(
    `SELECT id, data FROM domain_rows
      WHERE restaurant_id = $1 AND domain = 'accounting' AND collection = 'acc_ledger' AND data->>'journal_id' = $2`,
    [restaurantId, String(journal.id)],
  );
  const expected = new Map();
  for (const l of lines) {
    const k = ledgerKey(l.account, l.debit, l.credit);
    expected.set(k, (expected.get(k) || 0) + 1);
  }
  const actual = new Map();
  for (const r of rows) {
    const k = ledgerKey(r.data.account, r.data.debit, r.data.credit);
    actual.set(k, (actual.get(k) || 0) + 1);
  }
  for (const [k, n] of expected) {
    const have = actual.get(k) || 0;
    if (have < n) problems.push(`missing ${n - have} ledger row(s) for ${k.replace(/\|/g, ' ')}`);
  }
  for (const [k, n] of actual) {
    const want = expected.get(k) || 0;
    if (n > want) problems.push(`${n - want} unexpected or duplicate ledger row(s) for ${k.replace(/\|/g, ' ')}`);
  }
  return problems;
}

/** Throws unless the existing journal's ledger matches it exactly by content. An incomplete journal is never accepted. */
async function verifyJournalContent(db, restaurantId, journal) {
  const problems = await journalLedgerProblems(db, restaurantId, journal);
  if (problems.length) {
    throw reconciliationError(`Journal ${journal.id} (${journal.source}, order ${journal.ref}) does not match its ledger: ${problems.join('; ')}`);
  }
  return journal;
}

/** The sale's accounts and VAT split, from the current payment mapping and the order. */
async function saleAmounts(restaurantId, order) {
  const mapping = await getMapping(restaurantId);
  const total = round2(+order.total || 0);
  const method = String(order.payment_method || order.pay || 'cash').toLowerCase();
  const assetAccount = mapping[method]
    || mapping[`pay_${method}`]
    || (method.includes('stripe') ? '1200 Stripe clearing'
      : method.includes('card') ? '1100 Card clearing'
        : method.includes('wallet') ? '1400 Accounts receivable'
          : '1000 Cash on hand');
  const salesAccount = mapping.sales || mapping.food_sales || '4000 Food sales';
  const vatAccount = mapping.vat || mapping.vat_payable || '2100 VAT payable';
  // The rate is recorded with where it came from. The 20% default is unchanged and reported as default_20.
  const rateSource = mapping.vat_rate != null ? 'mapping' : (order.vat_rate != null ? 'order' : 'default_20');
  const vatRate = +(mapping.vat_rate != null ? mapping.vat_rate : (order.vat_rate != null ? order.vat_rate : 20));
  const vatInclusive = mapping.vat_inclusive !== false;
  let net = total;
  let vat = 0;
  if (vatRate > 0) {
    if (vatInclusive) {
      net = round2(total / (1 + vatRate / 100));
      vat = round2(total - net);
    } else {
      vat = round2(total * (vatRate / 100));
      net = total;
    }
  }
  const debitTotal = vatInclusive ? total : round2(net + vat);
  const lines = [
    { account: assetAccount, debit: debitTotal, credit: 0 },
    { account: salesAccount, debit: 0, credit: net },
  ];
  if (vat > 0) lines.push({ account: vatAccount, debit: 0, credit: vat });
  return { total, vatRate, vatInclusive, rateSource, net, vat, lines };
}

/** Stored sale lines can be reversed exactly only when they are a balanced, well-formed posting. */
function validStoredLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2) return false;
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    if (!l || typeof l.account !== 'string' || l.account.trim() === '') return false;
    const d = Number(l.debit);
    const c = Number(l.credit);
    if (!Number.isFinite(d) || !Number.isFinite(c) || d < 0 || c < 0 || (d > 0 && c > 0)) return false;
    debit += d;
    credit += c;
  }
  return Math.abs(round2(debit) - round2(credit)) < 0.005;
}

/**
 * Serializes posting for one order across connections. The lock is held until the transaction ends, so two concurrent
 * retries for the same order run one after the other, and the second one sees the first one's committed journal.
 */
async function lockOrderPosting(client, restaurantId, orderId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`acct:${restaurantId}:${String(orderId)}`]);
}

async function postSaleTx(client, restaurantId, order, amounts) {
  const existing = await findOrderJournal(client, restaurantId, 'sale', order.id);
  if (existing) return verifyJournalContent(client, restaurantId, existing);
  if (amounts.total <= 0) return null;
  return writeJournalTx(client, restaurantId, prepareSystemJournal({
    date: (order.created_at || new Date().toISOString()).slice(0, 10),
    description: `Sale #${order.id}${amounts.vat > 0 ? ` (VAT ${amounts.vatRate}%)` : ''}`,
    source: 'sale',
    ref: order.id,
    lines: amounts.lines,
    tax: {
      schema: 1,
      rate: amounts.vatRate,
      inclusive: amounts.vatInclusive,
      rate_source: amounts.rateSource,
      net: amounts.net,
      vat: amounts.vat,
      branch_id: order.branch_id || null,
    },
  }));
}

async function postReversalTx(client, restaurantId, order) {
  const done = await findOrderJournal(client, restaurantId, 'sale_reversal', order.id);
  if (done) return verifyJournalContent(client, restaurantId, done);
  const sale = await findOrderJournal(client, restaurantId, 'sale', order.id);
  if (!sale) {
    // Nothing was posted for this order (for example a zero total). Nothing to reverse.
    if (round2(+order.total || 0) <= 0) return null;
    throw reconciliationError(`Order ${order.id} has no sale journal to reverse`);
  }
  // The sale must match its ledger before it is reversed. Otherwise the reversal would be built on a broken posting.
  await verifyJournalContent(client, restaurantId, sale);
  if (!validStoredLines(sale.lines)) {
    throw reconciliationError(`Sale journal ${sale.id} for order ${order.id} has lines that cannot be reversed exactly`);
  }
  if (!sale.tax) {
    // Legacy sale (before tax snapshots): the stored lines are the posted lines, so they are reversed exactly, and flagged.
    console.warn(`[accounting] order ${order.id}: reversing legacy sale ${sale.id} from its stored lines (no tax snapshot)`);
  }
  // BUG-017: refunds already reversed part of this sale. Only what is still standing is reversed, so nothing is reversed twice.
  const alreadyParts = await refundPartsTx(client, restaurantId, order.id);
  const lines = buildRefundLines(sale.lines, alreadyParts, 1, true, order.id, 'Reversal of sale');
  if (!lines.length) return null;
  return writeJournalTx(client, restaurantId, prepareSystemJournal({
    date: (order.created_at || new Date().toISOString()).slice(0, 10),
    description: `Reversal of sale #${order.id}`,
    source: 'sale_reversal',
    ref: order.id,
    lines,
    tax: sale.tax
      ? {
        schema: 1,
        reverses_journal: sale.id,
        rate: sale.tax.rate,
        inclusive: sale.tax.inclusive,
        rate_source: sale.tax.rate_source,
        snapshot: true,
      }
      : { schema: 1, reverses_journal: sale.id, legacy_no_snapshot: true, source: 'stored_lines' },
  }));
}

/** Net amount reversed per account by the refund journals of an order (credit minus debit, so it has the sale's sign). */
async function refundPartsTx(db, restaurantId, orderId) {
  const { rows } = await db.query(
    `SELECT data FROM domain_rows
      WHERE restaurant_id = $1 AND domain = 'accounting' AND collection = 'acc_journals'
        AND data->>'source' = 'sale_refund' AND data->>'ref' LIKE $2`,
    [restaurantId, `${String(orderId)}:%`],
  );
  const parts = new Map();
  for (const { data } of rows) {
    for (const l of Array.isArray(data.lines) ? data.lines : []) {
      parts.set(l.account, round2((parts.get(l.account) || 0) + (+l.credit || 0) - (+l.debit || 0)));
    }
  }
  return parts;
}

/**
 * The reversal lines for a sale. `saleLines` are the posted sale lines. `alreadyParts` is what earlier refunds reversed.
 * With `full`, the rest of each account is reversed. Otherwise `ratio` of the sale is reversed. Rounding goes on the largest line,
 * so the lines always balance.
 */
function buildRefundLines(saleLines, alreadyParts, ratio, full, orderId, label) {
  const net = new Map();
  const names = new Map();
  for (const l of saleLines) {
    net.set(l.account, round2((net.get(l.account) || 0) + (+l.debit || 0) - (+l.credit || 0)));
    names.set(l.account, l.account_name);
  }
  const parts = new Map();
  for (const [account, saleNet] of net) {
    const remaining = round2(saleNet - (alreadyParts.get(account) || 0));
    parts.set(account, full ? remaining : round2(saleNet * ratio));
  }
  const drift = round2([...parts.values()].reduce((s, v) => s + v, 0));
  if (Math.abs(drift) >= 0.005) {
    const [big] = [...parts.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    parts.set(big[0], round2(big[1] - drift));
  }
  return [...parts.entries()]
    .filter(([, v]) => Math.abs(v) >= 0.005)
    .map(([account, v]) => ({
      account,
      account_name: names.get(account),
      debit: v < 0 ? round2(-v) : 0,
      credit: v > 0 ? round2(v) : 0,
      description: `${label} #${orderId}`,
    }));
}

/**
 * BUG-017: a refund reverses the part of the sale it returns. A full refund reverses what is still standing, and a
 * partial refund reverses its share. Each refund has its own journal (source sale_refund, ref "<order>:<refund>"), so a
 * retry posts nothing twice. A sale that a cancel or return already reversed is left alone.
 */
async function postRefundSale(restaurantId, order, { refundAmount, refundKey, fullyRefunded }) {
  await ensureDomainTables();
  const ref = `${order.id}:${refundKey}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockOrderPosting(client, restaurantId, order.id);
    const { rows: done } = await client.query(
      `SELECT id, data FROM domain_rows
        WHERE restaurant_id = $1 AND domain = 'accounting' AND collection = 'acc_journals'
          AND data->>'source' = 'sale_refund' AND data->>'ref' = $2
        LIMIT 1`,
      [restaurantId, ref],
    );
    if (done[0]) {
      await client.query('COMMIT');
      return { id: done[0].id, ...done[0].data };
    }
    if (await findOrderJournal(client, restaurantId, 'sale_reversal', order.id)) {
      await client.query('COMMIT');
      return null;
    }
    const sale = await findOrderJournal(client, restaurantId, 'sale', order.id);
    const total = round2(+order.total || 0);
    if (!sale) {
      await client.query('COMMIT');
      if (total <= 0) return null;
      throw reconciliationError(`Order ${order.id} has no sale journal to refund`);
    }
    await verifyJournalContent(client, restaurantId, sale);
    if (!validStoredLines(sale.lines)) {
      throw reconciliationError(`Sale journal ${sale.id} for order ${order.id} has lines that cannot be refunded exactly`);
    }
    const ratio = total > 0 ? Math.min(1, round2(refundAmount) / total) : 1;
    const alreadyParts = await refundPartsTx(client, restaurantId, order.id);
    const lines = buildRefundLines(sale.lines, alreadyParts, ratio, Boolean(fullyRefunded), order.id, 'Refund of sale');
    if (!lines.length) {
      await client.query('COMMIT');
      return null;
    }
    const journal = await writeJournalTx(client, restaurantId, prepareSystemJournal({
      date: (order.created_at || new Date().toISOString()).slice(0, 10),
      description: `Refund of sale #${order.id}`,
      source: 'sale_refund',
      ref,
      lines,
      tax: { schema: 1, reverses_journal: sale.id, partial: !fullyRefunded, ratio, refund_key: String(refundKey) },
    }));
    await client.query('COMMIT');
    return journal;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Auto-post a sale (or its reversal) for an order. One transaction per call, under an advisory lock on the order.
 * A failed post throws, so the caller leaves the accounting effect not done. An existing journal is returned only when
 * its ledger matches it by content. A mismatched or incomplete journal is refused for reconciliation.
 */
async function postSaleFromOrder(restaurantId, order, { reverse = false } = {}) {
  await ensureDomainTables();
  // Everything that needs the pool is read before the transaction starts, so a posting holds one client and the lock.
  const amounts = reverse ? null : await saleAmounts(restaurantId, order);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockOrderPosting(client, restaurantId, order.id);
    const result = reverse
      ? await postReversalTx(client, restaurantId, order)
      : await postSaleTx(client, restaurantId, order, amounts);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function computeFromLedger(ledger) {
  const byAccount = {};
  for (const row of ledger) {
    const code = String(row.account || '').split(' ')[0] || row.account || 'unknown';
    if (!byAccount[code]) {
      byAccount[code] = {
        account: row.account,
        code,
        debit: 0,
        credit: 0,
      };
    }
    byAccount[code].debit = round2(byAccount[code].debit + (+row.debit || 0));
    byAccount[code].credit = round2(byAccount[code].credit + (+row.credit || 0));
  }
  const tb = Object.values(byAccount).map((a) => ({
    ...a,
    balance: round2(a.debit - a.credit),
  })).sort((x, y) => String(x.code).localeCompare(String(y.code)));

  const income = tb.filter((a) => /^4/.test(a.code));
  const expense = tb.filter((a) => /^5/.test(a.code));
  const incomeTotal = round2(income.reduce((s, a) => s + a.credit - a.debit, 0));
  const expenseTotal = round2(expense.reduce((s, a) => s + a.debit - a.credit, 0));
  const pl = {
    income: income.map((a) => ({ account: a.account, amount: round2(a.credit - a.debit) })),
    expenses: expense.map((a) => ({ account: a.account, amount: round2(a.debit - a.credit) })),
    net: round2(incomeTotal - expenseTotal),
  };

  const assets = tb.filter((a) => /^1/.test(a.code));
  const liabilities = tb.filter((a) => /^2/.test(a.code));
  const equity = tb.filter((a) => /^3/.test(a.code));
  const bs = {
    assets: assets.map((a) => ({ account: a.account, amount: round2(a.debit - a.credit) })),
    liabilities: liabilities.map((a) => ({ account: a.account, amount: round2(a.credit - a.debit) })),
    equity: equity.map((a) => ({ account: a.account, amount: round2(a.credit - a.debit) })),
    retained_earnings: pl.net,
  };

  return {
    trial_balance: tb,
    profit_loss: pl,
    balance_sheet: bs,
    totals: {
      debit: round2(tb.reduce((s, a) => s + a.debit, 0)),
      credit: round2(tb.reduce((s, a) => s + a.credit, 0)),
    },
  };
}

async function reports(restaurantId) {
  const ledger = await listRows(restaurantId, 'accounting', 'acc_ledger');
  const journals = await listRows(restaurantId, 'accounting', 'acc_journals');
  const computed = computeFromLedger(ledger);
  return {
    ...computed,
    journal_count: journals.length,
    ledger_count: ledger.length,
    source: 'ledger',
  };
}

module.exports = {
  journalLedgerProblems,
  findOrderJournal,
  postJournal,
  postExpense,
  postSaleFromOrder,
  postRefundSale,
  buildRefundLines,
  reports,
  computeFromLedger,
  getCoa,
  getMapping,
};
