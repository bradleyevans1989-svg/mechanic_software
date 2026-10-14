const { addDays, parseDollars, parseIntOrNull, docNumber, vehicleLabel } = require('../lib/util');
const { listDocs } = require('../lib/docs');
const { requireOwner } = require('../lib/auth');
const { DEFAULT_CHECKLIST } = require('../lib/records');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Timezones a workshop can pick (Australia and New Zealand).
const TIMEZONES = {
  'Australia/Sydney': 'NSW, ACT, Victoria (Sydney, Melbourne)',
  'Australia/Brisbane': 'Queensland (Brisbane)',
  'Australia/Adelaide': 'South Australia (Adelaide)',
  'Australia/Darwin': 'Northern Territory (Darwin)',
  'Australia/Perth': 'Western Australia (Perth)',
  'Australia/Hobart': 'Tasmania (Hobart)',
  'Pacific/Auckland': 'New Zealand (Auckland)',
};

function csvCell(v) {
  let s = String(v ?? '');
  // Stop spreadsheet apps treating a customer name like "=SUM(...)" as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = function (app) {
  app.get('/', async (req, res) => {
    const t = res.locals.today;
    const db = req.db;
    const [bookings, jobs, unpaidAll, month, due] = await Promise.all([
      db.all(
        `SELECT b.*, c.name AS customer_name, c.phone AS customer_phone, v.rego, v.make, v.model
         FROM bookings b JOIN customers c ON c.id = b.customer_id LEFT JOIN vehicles v ON v.id = b.vehicle_id
         WHERE b.date = $1 AND b.status != 'cancelled' ORDER BY b.time = '', b.time`,
        [t]
      ),
      db.all(
        `SELECT j.*, c.name AS customer_name, v.rego, v.make, v.model, m.name AS mechanic_name FROM jobs j
         JOIN customers c ON c.id = j.customer_id LEFT JOIN vehicles v ON v.id = j.vehicle_id
         LEFT JOIN users m ON m.id = j.mechanic_id
         WHERE j.status NOT IN ('invoiced', 'cancelled') ORDER BY j.priority = 'urgent' DESC, j.due_date NULLS LAST, j.due_time, j.created_at`
      ),
      listDocs(db, t, `d.type = 'invoice' AND d.status != 'void'`, [], 'ORDER BY d.due_date'),
      listDocs(db, t, `d.type = 'invoice' AND d.status != 'void' AND d.issue_date >= $1`, [t.slice(0, 8) + '01']),
      db.all(
        `SELECT v.*, c.name AS customer_name, c.phone AS customer_phone FROM vehicles v
         JOIN customers c ON c.id = v.customer_id
         WHERE (v.next_service_date BETWEEN $1 AND $2) OR (v.rego_due BETWEEN $1 AND $2)
         ORDER BY LEAST(COALESCE(v.next_service_date, '9999'), COALESCE(v.rego_due, '9999'))`,
        [addDays(t, -30), addDays(t, 30)]
      ),
    ]);
    const unpaid = unpaidAll.filter((d) => d.balance > 0);
    res.render('dashboard', {
      bookings,
      jobs,
      unpaid,
      due,
      welcome: false,
      stats: {
        monthTotal: month.reduce((s, d) => s + d.total, 0),
        monthCount: month.length,
        owing: unpaid.reduce((s, d) => s + d.balance, 0),
        overdue: unpaid.filter((d) => d.state === 'overdue').length,
      },
    });
  });

  app.get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) return res.redirect('/');
    const db = req.db;
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const compact = `%${q.replace(/\s/g, '').replace(/[\\%_]/g, '\\$&')}%`;
    const num = parseIntOrNull(q.replace(/^(inv-?|q|j)/i, ''));
    const [vehicles, customers, docs, jobs] = await Promise.all([
      db.all(
        `SELECT v.*, c.name AS customer_name FROM vehicles v JOIN customers c ON c.id = v.customer_id
         WHERE replace(v.rego, ' ', '') ILIKE $2 OR v.vin ILIKE $1 OR v.make ILIKE $1 OR v.model ILIKE $1
         ORDER BY v.rego LIMIT 50`,
        [like, compact]
      ),
      db.all(
        `SELECT * FROM customers WHERE name ILIKE $1 OR replace(phone, ' ', '') ILIKE $2 OR email ILIKE $1
         ORDER BY lower(name) LIMIT 50`,
        [like, compact]
      ),
      num ? listDocs(db, res.locals.today, 'd.number = $1', [num]) : [],
      num
        ? db.all(`SELECT j.*, v.rego FROM jobs j LEFT JOIN vehicles v ON v.id = j.vehicle_id WHERE j.number = $1`, [num])
        : [],
    ]);
    const total = vehicles.length + customers.length + docs.length + jobs.length;
    if (total === 1) {
      if (vehicles.length) return res.redirect(`/vehicles/${vehicles[0].id}`);
      if (customers.length) return res.redirect(`/customers/${customers[0].id}`);
      if (docs.length) return res.redirect(`/documents/${docs[0].id}`);
      return res.redirect(`/jobs/${jobs[0].id}`);
    }
    res.render('search', { q, vehicles, customers, docs, jobs });
  });

  app.get('/settings', requireOwner, (req, res) =>
    res.render('settings', { saved: req.query.saved === '1', welcome: req.query.welcome === '1', TIMEZONES, DEFAULT_CHECKLIST })
  );

  app.post('/settings', requireOwner, async (req, res) => {
    const g = (k) => String(req.body[k] ?? '').trim().slice(0, 2000);
    const n = (k, min) => Math.min(Math.max(parseIntOrNull(req.body[k]) ?? min, min), 999999999);
    await req.db.run(
      `UPDATE settings SET business_name = $1, abn = $2, address = $3, phone = $4, email = $5, bank_details = $6,
         invoice_terms = $7, labour_rate_cents = $8, payment_days = $9, next_invoice_no = $10, next_quote_no = $11,
         next_job_no = $12, timezone = $13, checklist = $14`,
      [
        g('business_name') || 'My Workshop',
        g('abn'),
        g('address'),
        g('phone'),
        g('email'),
        g('bank_details'),
        g('invoice_terms'),
        Math.max(parseDollars(req.body.labour_rate), 0),
        n('payment_days', 0),
        n('next_invoice_no', 1),
        n('next_quote_no', 1),
        n('next_job_no', 1),
        TIMEZONES[req.body.timezone] ? req.body.timezone : 'Australia/Sydney',
        String(req.body.checklist ?? '').trim().slice(0, 10000),
      ]
    );
    res.redirect('/settings?saved=1');
  });

  app.get('/reports', requireOwner, async (req, res) => {
    const year = parseIntOrNull(req.query.year) || Number(res.locals.today.slice(0, 4));
    const [invoices, payments] = await Promise.all([
      listDocs(req.db, res.locals.today, `d.type = 'invoice' AND d.status != 'void' AND d.issue_date LIKE $1`, [`${year}-%`]),
      req.db.all(
        `SELECT p.* FROM payments p JOIN documents d ON d.id = p.document_id
         WHERE d.status != 'void' AND p.date LIKE $1`,
        [`${year}-%`]
      ),
    ]);
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const key = `${year}-${String(m).padStart(2, '0')}`;
      const inv = invoices.filter((d) => d.issue_date.startsWith(key));
      months.push({
        key,
        count: inv.length,
        subtotal: inv.reduce((s, d) => s + d.subtotal, 0),
        gst: inv.reduce((s, d) => s + d.gst, 0),
        total: inv.reduce((s, d) => s + d.total, 0),
        received: payments.filter((p) => p.date.startsWith(key)).reduce((s, p) => s + p.amount_cents, 0),
      });
    }
    const sum = (k) => months.reduce((s, m) => s + m[k], 0);
    const totals = { count: sum('count'), subtotal: sum('subtotal'), gst: sum('gst'), total: sum('total'), received: sum('received') };
    res.render('reports', { year, months, totals });
  });

  // Invoice list for the accountant / BAS.
  app.get('/reports/invoices.csv', requireOwner, async (req, res) => {
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : '0000-01-01';
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : '9999-12-31';
    const docs = await listDocs(req.db, res.locals.today, `d.type = 'invoice' AND d.issue_date BETWEEN $1 AND $2`, [from, to], 'ORDER BY d.issue_date, d.number');
    const rows = [['Invoice', 'Date', 'Due', 'Customer', 'Vehicle', 'Ex GST', 'GST', 'Total', 'Paid', 'Balance', 'Status']];
    for (const d of docs) {
      rows.push([
        docNumber(d),
        d.issue_date,
        d.due_date || '',
        d.customer_name,
        vehicleLabel(d),
        (d.subtotal / 100).toFixed(2),
        (d.gst / 100).toFixed(2),
        (d.total / 100).toFixed(2),
        (d.paid / 100).toFixed(2),
        (d.balance / 100).toFixed(2),
        d.state,
      ]);
    }
    res.type('text/csv').attachment(`invoices-${from}-to-${to}.csv`.replace(/0000-01-01|9999-12-31/g, 'all'));
    res.send(rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
  });
};
