const { now, addDays, parseLines, parseIntOrNull, parseDollars, docNumber } = require('../lib/util');
const { nextNumber, getLines, saveLines } = require('../lib/db');
const { getDoc, listDocs } = require('../lib/docs');
const { getCustomer, getVehicle, vehicleOptions, customerOptions, resolveParty, logEvent } = require('../lib/records');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = function (app, { xero, QUOTE_STATUSES }) {
  async function createDoc(db, req, type, fields, lines) {
    const today = req.res.locals.today;
    const settings = await db.get('SELECT payment_days FROM settings');
    const f = {
      job_id: null,
      odometer: null,
      notes: '',
      issue_date: today,
      // Quotes use due_date as "valid until".
      due_date: addDays(today, type === 'invoice' ? settings.payment_days : 30),
      status: type === 'invoice' ? 'issued' : 'draft',
      ...fields,
    };
    const doc = await db.get(
      `INSERT INTO documents (type, number, customer_id, vehicle_id, job_id, issue_date, due_date, status, odometer, notes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [type, await nextNumber(db, type), f.customer_id, f.vehicle_id, f.job_id, f.issue_date, f.due_date, f.status, f.odometer, f.notes, now(req.tz)]
    );
    if (lines) await saveLines(db, 'document', doc.id, lines);
    return doc.id;
  }

  app.get(['/invoices', '/quotes'], async (req, res) => {
    const type = req.path === '/quotes' ? 'quote' : 'invoice';
    const filter = req.query.show || (type === 'invoice' ? 'unpaid' : 'open');
    let docs = await listDocs(req.db, res.locals.today, 'd.type = $1', [type], 'ORDER BY d.issue_date DESC, d.number DESC LIMIT 1000');
    if (type === 'invoice' && filter === 'unpaid') docs = docs.filter((d) => d.state !== 'void' && d.balance > 0);
    if (type === 'quote' && filter === 'open') docs = docs.filter((d) => ['draft', 'sent'].includes(d.status));
    res.render('documents/index', { type, docs, filter });
  });

  async function renderNew(req, res, type, doc, error) {
    const [vehicles, customers] = await Promise.all([vehicleOptions(req.db), customerOptions(req.db)]);
    res.render('documents/new', { type, doc, vehicles, customers, error });
  }

  app.get('/documents/new', (req, res) =>
    renderNew(
      req,
      res,
      req.query.type === 'quote' ? 'quote' : 'invoice',
      { vehicle_id: Number(req.query.vehicle_id) || null, customer_id: Number(req.query.customer_id) || null },
      null
    )
  );

  app.post('/documents', async (req, res) => {
    const type = req.body.type === 'quote' ? 'quote' : 'invoice';
    const party = await resolveParty(req.db, req.body);
    if (!party) return renderNew(req, res.status(400), type, req.body, 'Pick a vehicle or customer.');
    const vehicle = party.vehicle_id ? await getVehicle(req.db, party.vehicle_id) : null;
    const id = await req.db.tx((db) =>
      createDoc(db, req, type, {
        ...party,
        odometer: vehicle ? vehicle.odometer : null,
        notes: String(req.body.notes || '').trim().slice(0, 5000),
      })
    );
    res.redirect(`/documents/${id}`);
  });

  app.get('/documents/:id', async (req, res, next) => {
    const doc = await getDoc(req.db, req.params.id, res.locals.today);
    if (!doc) return next();
    const [lines, payments, converted] = await Promise.all([
      getLines(req.db, 'document', doc.id),
      req.db.all('SELECT * FROM payments WHERE document_id = $1 ORDER BY date, id', [doc.id]),
      doc.job_id ? req.db.all('SELECT id, type, number FROM documents WHERE job_id = $1 AND id != $2', [doc.job_id, doc.id]) : [],
    ]);
    const xeroStatus = doc.type === 'invoice' && (await xero.isConnected(req.db)) ? (await xero.invoiceStatus(req.db, doc.id)) || { status: 'not sent' } : null;
    res.render('documents/show', { doc, lines, payments, converted, xeroStatus, saved: req.query.saved === '1' });
  });

  app.post('/documents/:id', async (req, res, next) => {
    const doc = await getDoc(req.db, req.params.id, res.locals.today);
    if (!doc) return next();
    const g = (k) => String(req.body[k] ?? '').trim();
    const status = doc.type === 'quote' && QUOTE_STATUSES[g('status')] ? g('status') : doc.status;
    await req.db.tx(async (db) => {
      await db.run(`UPDATE documents SET issue_date = $1, due_date = $2, status = $3, odometer = $4, notes = $5 WHERE id = $6`, [
        DATE_RE.test(g('issue_date')) ? g('issue_date') : doc.issue_date,
        DATE_RE.test(g('due_date')) ? g('due_date') : null,
        status,
        parseIntOrNull(req.body.odometer),
        g('notes').slice(0, 5000),
        doc.id,
      ]);
      await saveLines(db, 'document', doc.id, parseLines(req.body));
    });
    await xero.queueInvoice(req.db, doc.id);
    res.redirect(`/documents/${doc.id}?saved=1`);
  });

  app.get('/documents/:id/print', async (req, res, next) => {
    const doc = await getDoc(req.db, req.params.id, res.locals.today);
    if (!doc) return next();
    res.render('documents/print', {
      doc,
      lines: await getLines(req.db, 'document', doc.id),
      payments: await req.db.all('SELECT * FROM payments WHERE document_id = $1 ORDER BY date, id', [doc.id]),
      customer: await getCustomer(req.db, doc.customer_id),
      vehicle: doc.vehicle_id ? await getVehicle(req.db, doc.vehicle_id) : null,
    });
  });

  app.post('/documents/:id/payments', async (req, res, next) => {
    const doc = await getDoc(req.db, req.params.id, res.locals.today);
    if (!doc || doc.type !== 'invoice') return next();
    const amount = parseDollars(req.body.amount);
    if (amount !== 0 && Math.abs(amount) < 1e9) {
      await req.db.run(`INSERT INTO payments (document_id, date, amount_cents, method, created_at) VALUES ($1, $2, $3, $4, $5)`, [
        doc.id,
        DATE_RE.test(req.body.date || '') ? req.body.date : res.locals.today,
        amount,
        String(req.body.method || '').trim().slice(0, 50),
        now(req.tz),
      ]);
      await xero.queueInvoice(req.db, doc.id);
    }
    res.redirect(`/documents/${doc.id}`);
  });

  app.post('/documents/:id/payments/:pid/delete', async (req, res) => {
    const payment = await req.db.get('SELECT id FROM payments WHERE id = $1 AND document_id = $2', [req.params.pid, req.params.id]);
    if (payment) {
      await xero.queuePaymentDeleted(req.db, payment.id, Number(req.params.id));
      await req.db.run('DELETE FROM payments WHERE id = $1', [payment.id]);
    }
    res.redirect(`/documents/${req.params.id}`);
  });

  // Quote accepted: invoice it directly.
  app.post('/documents/:id/invoice', async (req, res, next) => {
    const quote = await getDoc(req.db, req.params.id, res.locals.today);
    if (!quote || quote.type !== 'quote') return next();
    const id = await req.db.tx(async (db) => {
      await db.run(`UPDATE documents SET status = 'accepted' WHERE id = $1`, [quote.id]);
      if (quote.job_id) await db.run(`UPDATE jobs SET status = 'invoiced' WHERE id = $1`, [quote.job_id]);
      return createDoc(
        db,
        req,
        'invoice',
        { customer_id: quote.customer_id, vehicle_id: quote.vehicle_id, job_id: quote.job_id, odometer: quote.odometer, notes: quote.notes },
        await getLines(db, 'document', quote.id)
      );
    });
    await xero.queueInvoice(req.db, id);
    res.redirect(`/documents/${id}`);
  });

  // Quote accepted: book the work in as a job card with the quoted lines.
  app.post('/documents/:id/job', async (req, res, next) => {
    const quote = await getDoc(req.db, req.params.id, res.locals.today);
    if (!quote || quote.type !== 'quote') return next();
    if (quote.job_id) return res.redirect(`/jobs/${quote.job_id}`);
    const jobId = await req.db.tx(async (db) => {
      const job = await db.get(
        `INSERT INTO jobs (number, customer_id, vehicle_id, status, description, odometer, created_at)
         VALUES ($1, $2, $3, 'open', $4, $5, $6) RETURNING id`,
        [await nextNumber(db, 'job'), quote.customer_id, quote.vehicle_id, quote.notes || `From quote ${docNumber(quote)}`, quote.odometer, now(req.tz)]
      );
      await saveLines(db, 'job', job.id, await getLines(db, 'document', quote.id));
      await db.run(`UPDATE documents SET status = 'accepted', job_id = $1 WHERE id = $2`, [job.id, quote.id]);
      await logEvent(db, job.id, req.user.id, 'created', `Job opened from quote ${docNumber(quote)}`);
      return job.id;
    });
    res.redirect(`/jobs/${jobId}`);
  });

  // Invoices are voided rather than deleted, so the numbering has no gaps.
  app.post('/documents/:id/void', async (req, res, next) => {
    const doc = await getDoc(req.db, req.params.id, res.locals.today);
    if (!doc || doc.type !== 'invoice') return next();
    await req.db.tx(async (db) => {
      await db.run(`UPDATE documents SET status = 'void' WHERE id = $1`, [doc.id]);
      if (doc.job_id) {
        await db.run(`UPDATE jobs SET status = 'ready' WHERE id = $1 AND status = 'invoiced'`, [doc.job_id]);
        await logEvent(db, doc.job_id, req.user.id, 'invoice', `Invoice ${docNumber(doc)} voided`);
      }
    });
    await xero.queueInvoice(req.db, doc.id);
    res.redirect(`/documents/${doc.id}`);
  });

  app.post('/documents/:id/unvoid', async (req, res, next) => {
    const doc = await getDoc(req.db, req.params.id, res.locals.today);
    if (!doc || doc.type !== 'invoice') return next();
    await req.db.run(`UPDATE documents SET status = 'issued' WHERE id = $1`, [doc.id]);
    await xero.queueInvoice(req.db, doc.id);
    res.redirect(`/documents/${doc.id}`);
  });

  app.post('/documents/:id/delete', async (req, res, next) => {
    const doc = await getDoc(req.db, req.params.id, res.locals.today);
    if (!doc || doc.type !== 'quote') return next();
    await req.db.run('DELETE FROM documents WHERE id = $1', [doc.id]);
    res.redirect('/quotes');
  });
};
