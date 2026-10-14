const { today, addDays, parseDollars, parseIntOrNull, docNumber, vehicleLabel } = require('../lib/util');
const { listDocs } = require('../lib/docs');
const { requireOwner } = require('../lib/auth');

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = function (app, { db }) {
  app.get('/', (req, res) => {
    const t = today();
    const bookings = db
      .prepare(
        `SELECT b.*, c.name AS customer_name, c.phone AS customer_phone, v.rego, v.make, v.model
         FROM bookings b JOIN customers c ON c.id = b.customer_id LEFT JOIN vehicles v ON v.id = b.vehicle_id
         WHERE b.date = ? AND b.status != 'cancelled' ORDER BY b.time = '', b.time`
      )
      .all(t);
    const jobs = db
      .prepare(
        `SELECT j.*, c.name AS customer_name, v.rego, v.make, v.model, m.name AS mechanic_name FROM jobs j
         JOIN customers c ON c.id = j.customer_id LEFT JOIN vehicles v ON v.id = j.vehicle_id
         LEFT JOIN users m ON m.id = j.mechanic_id
         WHERE j.status NOT IN ('invoiced', 'cancelled') ORDER BY j.created_at`
      )
      .all();
    const unpaid = listDocs(db, `d.type = 'invoice' AND d.status != 'void'`, [], 'ORDER BY d.due_date').filter(
      (d) => d.balance > 0
    );
    const monthStart = t.slice(0, 8) + '01';
    const month = listDocs(db, `d.type = 'invoice' AND d.status != 'void' AND d.issue_date >= ?`, [monthStart]);
    const due = db
      .prepare(
        `SELECT v.*, c.name AS customer_name, c.phone AS customer_phone FROM vehicles v
         JOIN customers c ON c.id = v.customer_id
         WHERE (v.next_service_date BETWEEN ? AND ?) OR (v.rego_due BETWEEN ? AND ?)
         ORDER BY MIN(COALESCE(v.next_service_date, '9999'), COALESCE(v.rego_due, '9999'))`
      )
      .all(addDays(t, -30), addDays(t, 30), addDays(t, -30), addDays(t, 30));
    res.render('dashboard', {
      bookings,
      jobs,
      unpaid,
      due,
      stats: {
        monthTotal: month.reduce((s, d) => s + d.total, 0),
        monthCount: month.length,
        owing: unpaid.reduce((s, d) => s + d.balance, 0),
        overdue: unpaid.filter((d) => d.state === 'overdue').length,
      },
    });
  });

  app.get('/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.redirect('/');
    const like = `%${q}%`;
    const vehicles = db
      .prepare(
        `SELECT v.*, c.name AS customer_name FROM vehicles v JOIN customers c ON c.id = v.customer_id
         WHERE REPLACE(v.rego, ' ', '') LIKE REPLACE(?, ' ', '') OR v.vin LIKE ? OR v.make LIKE ? OR v.model LIKE ?
         ORDER BY v.rego LIMIT 50`
      )
      .all(like, like, like, like);
    const customers = db
      .prepare(
        `SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? OR REPLACE(phone, ' ', '') LIKE ? OR email LIKE ?
         ORDER BY name LIMIT 50`
      )
      .all(like, like, `%${q.replace(/\s/g, '')}%`, like);
    const num = parseIntOrNull(q.replace(/^(inv-?|q|j)/i, ''));
    const docs = num ? listDocs(db, 'd.number = ?', [num]) : [];
    const jobs = num
      ? db
          .prepare(`SELECT j.*, v.rego FROM jobs j LEFT JOIN vehicles v ON v.id = j.vehicle_id WHERE j.number = ?`)
          .all(num)
      : [];
    const total = vehicles.length + customers.length + docs.length + jobs.length;
    if (total === 1) {
      if (vehicles.length) return res.redirect(`/vehicles/${vehicles[0].id}`);
      if (customers.length) return res.redirect(`/customers/${customers[0].id}`);
      if (docs.length) return res.redirect(`/documents/${docs[0].id}`);
      return res.redirect(`/jobs/${jobs[0].id}`);
    }
    res.render('search', { q, vehicles, customers, docs, jobs });
  });

  app.get('/settings', requireOwner, (req, res) => res.render('settings', { saved: req.query.saved === '1' }));

  app.post('/settings', requireOwner, (req, res) => {
    const g = (k) => String(req.body[k] ?? '').trim();
    const n = (k, min) => Math.max(parseIntOrNull(req.body[k]) ?? min, min);
    db.prepare(
      `UPDATE settings SET business_name = ?, abn = ?, address = ?, phone = ?, email = ?, bank_details = ?,
         invoice_terms = ?, labour_rate_cents = ?, payment_days = ?, next_invoice_no = ?, next_quote_no = ?,
         next_job_no = ?
       WHERE id = 1`
    ).run(
      g('business_name') || 'My Workshop',
      g('abn'),
      g('address'),
      g('phone'),
      g('email'),
      g('bank_details'),
      g('invoice_terms'),
      parseDollars(req.body.labour_rate),
      n('payment_days', 0),
      n('next_invoice_no', 1),
      n('next_quote_no', 1),
      n('next_job_no', 1)
    );
    res.redirect('/settings?saved=1');
  });

  app.get('/reports', requireOwner, (req, res) => {
    const year = parseIntOrNull(req.query.year) || Number(today().slice(0, 4));
    const invoices = listDocs(db, `d.type = 'invoice' AND d.status != 'void' AND d.issue_date LIKE ?`, [`${year}-%`]);
    const payments = db
      .prepare(
        `SELECT p.* FROM payments p JOIN documents d ON d.id = p.document_id
         WHERE d.status != 'void' AND p.date LIKE ?`
      )
      .all(`${year}-%`);
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
    const year_totals = { count: sum('count'), subtotal: sum('subtotal'), gst: sum('gst'), total: sum('total'), received: sum('received') };
    res.render('reports', { year, months, totals: year_totals });
  });

  // Invoice list for the accountant / BAS.
  app.get('/reports/invoices.csv', requireOwner, (req, res) => {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '0000-01-01';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '9999-12-31';
    const docs = listDocs(db, `d.type = 'invoice' AND d.issue_date BETWEEN ? AND ?`, [from, to], 'ORDER BY d.issue_date, d.number');
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
