const { now, today, addDays, parseLines, parseIntOrNull, parseDollars, docNumber } = require('../lib/util');
const { nextNumber, getLines, saveLines } = require('../lib/db');
const { getDoc, listDocs } = require('../lib/docs');
const { getCustomer, getVehicle, vehicleOptions, customerOptions, resolveParty } = require('../lib/records');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = function (app, { db, xero, QUOTE_STATUSES }) {
  function createDoc(type, fields, lines) {
    return db.transaction(() => {
      const settings = db.prepare('SELECT payment_days FROM settings WHERE id = 1').get();
      const id = db
        .prepare(
          `INSERT INTO documents (type, number, customer_id, vehicle_id, job_id, issue_date, due_date, status, odometer, notes, created_at)
           VALUES (@type, @number, @customer_id, @vehicle_id, @job_id, @issue_date, @due_date, @status, @odometer, @notes, @created_at)`
        )
        .run({
          type,
          number: nextNumber(db, type),
          job_id: null,
          odometer: null,
          notes: '',
          issue_date: today(),
          // Quotes use due_date as "valid until".
          due_date: addDays(today(), type === 'invoice' ? settings.payment_days : 30),
          status: type === 'invoice' ? 'issued' : 'draft',
          created_at: now(),
          ...fields,
        }).lastInsertRowid;
      if (lines) saveLines(db, 'document', id, lines);
      return id;
    })();
  }

  app.get(['/invoices', '/quotes'], (req, res) => {
    const type = req.path === '/quotes' ? 'quote' : 'invoice';
    const filter = req.query.show || (type === 'invoice' ? 'unpaid' : 'open');
    let docs = listDocs(db, 'd.type = ?', [type], 'ORDER BY d.issue_date DESC, d.number DESC LIMIT 1000');
    if (type === 'invoice' && filter === 'unpaid') docs = docs.filter((d) => d.state !== 'void' && d.balance > 0);
    if (type === 'quote' && filter === 'open') docs = docs.filter((d) => ['draft', 'sent'].includes(d.status));
    res.render('documents/index', { type, docs, filter });
  });

  app.get('/documents/new', (req, res) => {
    const type = req.query.type === 'quote' ? 'quote' : 'invoice';
    res.render('documents/new', {
      type,
      doc: { vehicle_id: Number(req.query.vehicle_id) || null, customer_id: Number(req.query.customer_id) || null },
      vehicles: vehicleOptions(db),
      customers: customerOptions(db),
      error: null,
    });
  });

  app.post('/documents', (req, res) => {
    const type = req.body.type === 'quote' ? 'quote' : 'invoice';
    const party = resolveParty(db, req.body);
    if (!party) {
      return res.status(400).render('documents/new', {
        type,
        doc: req.body,
        vehicles: vehicleOptions(db),
        customers: customerOptions(db),
        error: 'Pick a vehicle or customer.',
      });
    }
    const vehicle = party.vehicle_id ? getVehicle(db, party.vehicle_id) : null;
    const id = createDoc(type, {
      ...party,
      odometer: vehicle ? vehicle.odometer : null,
      notes: String(req.body.notes || '').trim(),
    });
    res.redirect(`/documents/${id}`);
  });

  app.get('/documents/:id', (req, res, next) => {
    const doc = getDoc(db, req.params.id);
    if (!doc) return next();
    const lines = getLines(db, 'document', doc.id);
    const payments = db.prepare('SELECT * FROM payments WHERE document_id = ? ORDER BY date, id').all(doc.id);
    const converted = db
      .prepare(`SELECT id, type, number FROM documents WHERE job_id IS NOT NULL AND job_id = ? AND id != ?`)
      .all(doc.job_id, doc.id);
    const xeroStatus = doc.type === 'invoice' && xero.state().connected ? xero.invoiceStatus(doc.id) || { status: 'not sent' } : null;
    res.render('documents/show', { doc, lines, payments, converted, xeroStatus, saved: req.query.saved === '1', today: today() });
  });

  app.post('/documents/:id', (req, res, next) => {
    const doc = getDoc(db, req.params.id);
    if (!doc) return next();
    const g = (k) => String(req.body[k] ?? '').trim();
    let status = doc.status;
    if (doc.type === 'quote' && QUOTE_STATUSES[g('status')]) status = g('status');
    db.transaction(() => {
      db.prepare(
        `UPDATE documents SET issue_date = ?, due_date = ?, status = ?, odometer = ?, notes = ? WHERE id = ?`
      ).run(
        DATE_RE.test(g('issue_date')) ? g('issue_date') : doc.issue_date,
        DATE_RE.test(g('due_date')) ? g('due_date') : null,
        status,
        parseIntOrNull(req.body.odometer),
        g('notes'),
        doc.id
      );
      saveLines(db, 'document', doc.id, parseLines(req.body));
    })();
    xero.queueInvoice(doc.id);
    res.redirect(`/documents/${doc.id}?saved=1`);
  });

  app.get('/documents/:id/print', (req, res, next) => {
    const doc = getDoc(db, req.params.id);
    if (!doc) return next();
    res.render('documents/print', {
      doc,
      lines: getLines(db, 'document', doc.id),
      payments: db.prepare('SELECT * FROM payments WHERE document_id = ? ORDER BY date, id').all(doc.id),
      customer: getCustomer(db, doc.customer_id),
      vehicle: doc.vehicle_id ? getVehicle(db, doc.vehicle_id) : null,
    });
  });

  app.post('/documents/:id/payments', (req, res, next) => {
    const doc = getDoc(db, req.params.id);
    if (!doc || doc.type !== 'invoice') return next();
    const amount = parseDollars(req.body.amount);
    if (amount !== 0) {
      db.prepare(`INSERT INTO payments (document_id, date, amount_cents, method, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        doc.id,
        DATE_RE.test(req.body.date || '') ? req.body.date : today(),
        amount,
        String(req.body.method || '').trim(),
        now()
      );
      xero.queueInvoice(doc.id);
    }
    res.redirect(`/documents/${doc.id}`);
  });

  app.post('/documents/:id/payments/:pid/delete', (req, res) => {
    const payment = db.prepare('SELECT id FROM payments WHERE id = ? AND document_id = ?').get(req.params.pid, req.params.id);
    if (payment) xero.queuePaymentDeleted(payment.id, Number(req.params.id));
    db.prepare('DELETE FROM payments WHERE id = ? AND document_id = ?').run(req.params.pid, req.params.id);
    res.redirect(`/documents/${req.params.id}`);
  });

  // Quote accepted: invoice it directly.
  app.post('/documents/:id/invoice', (req, res, next) => {
    const quote = getDoc(db, req.params.id);
    if (!quote || quote.type !== 'quote') return next();
    const id = db.transaction(() => {
      db.prepare(`UPDATE documents SET status = 'accepted' WHERE id = ?`).run(quote.id);
      if (quote.job_id) db.prepare(`UPDATE jobs SET status = 'invoiced' WHERE id = ?`).run(quote.job_id);
      return createDoc(
        'invoice',
        {
          customer_id: quote.customer_id,
          vehicle_id: quote.vehicle_id,
          job_id: quote.job_id,
          odometer: quote.odometer,
          notes: quote.notes,
        },
        getLines(db, 'document', quote.id)
      );
    })();
    xero.queueInvoice(id);
    res.redirect(`/documents/${id}`);
  });

  // Quote accepted: book the work in as a job card with the quoted lines.
  app.post('/documents/:id/job', (req, res, next) => {
    const quote = getDoc(db, req.params.id);
    if (!quote || quote.type !== 'quote') return next();
    if (quote.job_id) return res.redirect(`/jobs/${quote.job_id}`);
    const jobId = db.transaction(() => {
      const id = db
        .prepare(
          `INSERT INTO jobs (number, customer_id, vehicle_id, status, description, odometer, created_at)
           VALUES (?, ?, ?, 'open', ?, ?, ?)`
        )
        .run(
          nextNumber(db, 'job'),
          quote.customer_id,
          quote.vehicle_id,
          quote.notes || `From quote ${docNumber(quote)}`,
          quote.odometer,
          now()
        ).lastInsertRowid;
      saveLines(db, 'job', id, getLines(db, 'document', quote.id));
      db.prepare(`UPDATE documents SET status = 'accepted', job_id = ? WHERE id = ?`).run(id, quote.id);
      return id;
    })();
    res.redirect(`/jobs/${jobId}`);
  });

  // Invoices are voided rather than deleted, so the numbering has no gaps.
  app.post('/documents/:id/void', (req, res, next) => {
    const doc = getDoc(db, req.params.id);
    if (!doc || doc.type !== 'invoice') return next();
    db.transaction(() => {
      db.prepare(`UPDATE documents SET status = 'void' WHERE id = ?`).run(doc.id);
      if (doc.job_id) db.prepare(`UPDATE jobs SET status = 'ready' WHERE id = ? AND status = 'invoiced'`).run(doc.job_id);
    })();
    xero.queueInvoice(doc.id);
    res.redirect(`/documents/${doc.id}`);
  });

  app.post('/documents/:id/unvoid', (req, res, next) => {
    const doc = getDoc(db, req.params.id);
    if (!doc || doc.type !== 'invoice') return next();
    db.prepare(`UPDATE documents SET status = 'issued' WHERE id = ?`).run(doc.id);
    xero.queueInvoice(doc.id);
    res.redirect(`/documents/${doc.id}`);
  });

  app.post('/documents/:id/delete', (req, res, next) => {
    const doc = getDoc(db, req.params.id);
    if (!doc || doc.type !== 'quote') return next();
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    res.redirect('/quotes');
  });
};
