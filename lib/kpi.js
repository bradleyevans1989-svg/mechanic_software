// Workshop KPIs for a period, with the period before it to compare against.
// Dates are [from, to) as YYYY-MM-DD, counted on the invoice date like the other reports.
const { listDocs } = require('./docs');
const { addDays, addMonths } = require('./util');

// Australian financial years run 1 July to 30 June.
function periods(today) {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const monthStart = `${today.slice(0, 7)}-01`;
  const qStart = `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  const fyStart = m >= 7 ? `${y}-07-01` : `${y - 1}-07-01`;
  return {
    month: { label: 'This month', from: monthStart, to: addMonths(monthStart, 1) },
    'last-month': { label: 'Last month', from: addMonths(monthStart, -1), to: monthStart },
    quarter: { label: 'This quarter', from: qStart, to: addMonths(qStart, 3) },
    '90d': { label: 'Last 90 days', from: addDays(today, -89), to: addDays(today, 1) },
    fy: { label: 'This financial year', from: fyStart, to: addMonths(fyStart, 12) },
    'last-fy': { label: 'Last financial year', from: addMonths(fyStart, -12), to: fyStart },
  };
}

// The same length of time just before, to compare against.
function previous(from, to) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5);
  // Whole months compare with the same number of whole months before.
  if (from.endsWith('-01') && to.endsWith('-01')) {
    const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
    return { from: addMonths(from, -months), to: from };
  }
  return { from: addDays(from, -days), to: from };
}

const ratio = (a, b) => (b ? a / b : null);

async function compute(db, tz, from, to, today) {
  const [invoices, lines, quotes, clocked, jobs, bookings, earlier, newCustomers, partsCost] = await Promise.all([
    listDocs(db, today, `d.type = 'invoice' AND d.status != 'void' AND d.issue_date >= $1 AND d.issue_date < $2`, [from, to]),
    db.all(
      `SELECT l.kind, SUM(ROUND((l.qty * l.unit_cents)::numeric))::bigint AS cents, SUM(l.qty) AS qty
       FROM line_items l JOIN documents d ON d.id = l.document_id
       WHERE d.type = 'invoice' AND d.status != 'void' AND d.issue_date >= $1 AND d.issue_date < $2 GROUP BY l.kind`,
      [from, to]
    ),
    db.all(`SELECT status FROM documents WHERE type = 'quote' AND issue_date >= $1 AND issue_date < $2`, [from, to]),
    // Time clocked on the jobs behind this period's invoices, and by whom.
    db.all(
      `SELECT j.mechanic_id, t.user_id, d.id AS document_id,
         SUM(EXTRACT(EPOCH FROM (COALESCE(t.ended_at, now()) - t.started_at)) / 3600) AS hours
       FROM documents d JOIN jobs j ON j.id = d.job_id JOIN time_entries t ON t.job_id = j.id
       WHERE d.type = 'invoice' AND d.status != 'void' AND d.issue_date >= $1 AND d.issue_date < $2
       GROUP BY j.mechanic_id, t.user_id, d.id`,
      [from, to]
    ),
    db.all(
      `SELECT j.id, j.mechanic_id, m.name AS mechanic_name, j.created_at, j.completed_at, d.id AS document_id
       FROM documents d JOIN jobs j ON j.id = d.job_id LEFT JOIN users m ON m.id = j.mechanic_id
       WHERE d.type = 'invoice' AND d.status != 'void' AND d.issue_date >= $1 AND d.issue_date < $2`,
      [from, to]
    ),
    db.all(`SELECT status FROM bookings WHERE date >= $1 AND date < $2 AND date < $3`, [from, to, today]),
    // Customers who'd been invoiced before this period.
    db.all(
      `SELECT DISTINCT customer_id FROM documents WHERE type = 'invoice' AND status != 'void' AND issue_date < $1`,
      [from]
    ),
    db.get(`SELECT COUNT(*)::int AS n FROM customers WHERE created_at >= $1 AND created_at < $2`, [from, to]),
    // What the parts on this period's jobs cost from suppliers.
    db.get(
      `SELECT COALESCE(SUM(ROUND((pl.received_qty * pl.cost_cents)::numeric)), 0)::bigint AS cents
       FROM purchase_order_lines pl JOIN purchase_orders o ON o.id = pl.order_id
       WHERE o.job_id IN (SELECT d.job_id FROM documents d WHERE d.type = 'invoice' AND d.status != 'void'
         AND d.issue_date >= $1 AND d.issue_date < $2 AND d.job_id IS NOT NULL)`,
      [from, to]
    ),
  ]);

  const byKind = (k) => lines.find((l) => l.kind === k) || { cents: 0, qty: 0 };
  const labour = byKind('labour');
  const parts = byKind('part');
  const other = byKind('other');
  const sales = invoices.reduce((s, d) => s + d.subtotal, 0);
  const cars = new Set(invoices.filter((d) => d.vehicle_id).map((d) => d.vehicle_id)).size + invoices.filter((d) => !d.vehicle_id).length;
  const customers = new Set(invoices.map((d) => d.customer_id));
  const before = new Set(earlier.map((r) => r.customer_id));
  const returning = [...customers].filter((c) => before.has(c)).length;
  const hoursClocked = clocked.reduce((s, r) => s + Number(r.hours), 0);
  // Labour hours sold on invoices that came from a job with clocked time, against that time.
  const jobDocs = new Set(clocked.map((r) => r.document_id));
  const soldOnClocked = invoices.filter((d) => jobDocs.has(d.id)).length
    ? await db.get(
        `SELECT COALESCE(SUM(qty), 0) AS qty FROM line_items WHERE kind = 'labour' AND document_id = ANY($1::int[])`,
        [[...jobDocs]]
      )
    : { qty: 0 };
  const decided = quotes.filter((q) => q.status !== 'draft');
  const turnaround = jobs
    .filter((j) => j.completed_at)
    .map((j) => (Date.parse(String(j.completed_at).replace(' ', 'T')) - Date.parse(String(j.created_at).replace(' ', 'T'))) / 864e5)
    .filter((d) => Number.isFinite(d) && d >= 0);
  const pastBookings = bookings.filter((b) => b.status !== 'cancelled');

  // Each mechanic: jobs, labour hours sold and sales on their invoices, and hours they clocked.
  const mech = {};
  const docsById = Object.fromEntries(invoices.map((d) => [d.id, d]));
  for (const j of jobs) {
    const key = j.mechanic_id || 0;
    const m = mech[key] || (mech[key] = { name: j.mechanic_name || 'No mechanic', jobs: 0, sales: 0, docIds: [], clocked: 0 });
    m.jobs++;
    m.sales += docsById[j.document_id] ? docsById[j.document_id].subtotal : 0;
    m.docIds.push(j.document_id);
  }
  for (const r of clocked) {
    const m = mech[r.mechanic_id || 0];
    if (m) m.clocked += Number(r.hours);
  }
  const mechanics = Object.values(mech);
  for (const m of mechanics) {
    m.sold = Number((await db.get(`SELECT COALESCE(SUM(qty), 0) AS qty FROM line_items WHERE kind = 'labour' AND document_id = ANY($1::int[])`, [m.docIds])).qty);
    m.efficiency = ratio(m.sold, m.clocked);
    delete m.docIds;
  }
  mechanics.sort((a, b) => b.sales - a.sales);

  return {
    sales,
    invoices: invoices.length,
    cars,
    averageInvoice: ratio(sales, invoices.length),
    labour: Number(labour.cents),
    parts: Number(parts.cents),
    other: Number(other.cents),
    labourShare: ratio(Number(labour.cents), sales),
    hoursSold: Number(labour.qty),
    labourRate: ratio(Number(labour.cents), Number(labour.qty)),
    hoursClocked,
    efficiency: ratio(Number(soldOnClocked.qty), hoursClocked),
    partsCost: Number(partsCost.cents),
    partsMargin: Number(partsCost.cents) > 0 ? ratio(Number(parts.cents) - Number(partsCost.cents), Number(parts.cents)) : null,
    quotes: decided.length,
    closeRate: ratio(decided.filter((q) => q.status === 'accepted').length, decided.length),
    customers: customers.size,
    returningShare: ratio(returning, customers.size),
    newCustomers: newCustomers.n,
    turnaroundDays: turnaround.length ? turnaround.reduce((s, d) => s + d, 0) / turnaround.length : null,
    noShowRate: ratio(pastBookings.filter((b) => b.status === 'no_show').length, pastBookings.length),
    mechanics,
  };
}

// Days of sales tied up in unpaid invoices, from the last 90 days of sales.
async function debtorDays(db, today) {
  const docs = await listDocs(db, today, `d.type = 'invoice' AND d.status != 'void'`);
  const owing = docs.reduce((s, d) => s + Math.max(d.balance, 0), 0);
  const recent = docs.filter((d) => d.issue_date > addDays(today, -90) && d.issue_date <= today).reduce((s, d) => s + d.total, 0);
  return { owing, days: recent ? owing / (recent / 90) : null };
}

module.exports = { periods, previous, compute, debtorDays };
