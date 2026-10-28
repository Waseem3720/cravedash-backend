const { readDoc, appendRow, listRows, round2 } = require('./helpers');

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
async function postJournal(restaurantId, {
  date, description, lines, source, ref, by,
}) {
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
  const journal = await appendRow(restaurantId, 'accounting', 'acc_journals', {
    date: date || new Date().toISOString().slice(0, 10),
    description: description || null,
    source: source || 'manual',
    ref: ref || null,
    debit,
    credit,
    lines: normalized,
    by: by || null,
  });
  const ledgerEntries = [];
  for (const line of normalized) {
    const entry = await appendRow(restaurantId, 'accounting', 'acc_ledger', {
      journal_id: journal.id,
      date: journal.date,
      account: line.account,
      account_name: line.account_name,
      description: line.description || journal.description,
      debit: line.debit,
      credit: line.credit,
      source: journal.source,
      ref: journal.ref,
    });
    ledgerEntries.push(entry);
  }
  return { journal, ledger: ledgerEntries };
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

/** Auto-post a sale from an order using payment method mapping (+ VAT split). */
async function postSaleFromOrder(restaurantId, order) {
  if (!order || !order.id) return null;
  const existingRows = await listRows(restaurantId, 'accounting', 'acc_journals');
  const alreadyPosted = existingRows.find((j) => String(j.ref) === String(order.id) && j.source === 'sale');
  if (alreadyPosted) {
    return { journal: alreadyPosted, idempotent: true };
  }

  const mapping = await getMapping(restaurantId);
  const total = round2(+order.total || 0);
  if (total <= 0) return null;
  const method = String(order.payment_method || order.pay || 'cash').toLowerCase();
  const assetAccount = mapping[method]
    || mapping[`pay_${method}`]
    || (method.includes('stripe') ? '1200 Stripe clearing'
      : method.includes('card') ? '1100 Card clearing'
        : method.includes('wallet') ? '1400 Accounts receivable'
          : '1000 Cash on hand');
  const salesAccount = mapping.sales || mapping.food_sales || '4000 Food sales';
  const vatAccount = mapping.vat || mapping.vat_payable || '2100 VAT payable';
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
  const saleDate = order.created_at instanceof Date
    ? order.created_at.toISOString().slice(0, 10)
    : (order.created_at ? String(order.created_at).slice(0, 10) : new Date().toISOString().slice(0, 10));

  const lines = [
    { account: assetAccount, debit: debitTotal, credit: 0 },
    { account: salesAccount, debit: 0, credit: net },
  ];
  if (vat > 0) lines.push({ account: vatAccount, debit: 0, credit: vat });
  return await postJournal(restaurantId, {
    date: saleDate,
    description: `Sale #${order.id}${vat > 0 ? ` (VAT ${vatRate}%)` : ''}`,
    source: 'sale',
    ref: order.id,
    lines,
  });
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
  postJournal,
  postExpense,
  postSaleFromOrder,
  reports,
  computeFromLedger,
  getCoa,
  getMapping,
};
