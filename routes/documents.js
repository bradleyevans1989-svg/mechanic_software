const { now, addDays, parseLines, parseIntOrNull, parseDollars, docNumber } = require('../lib/util');
const { nextNumber, getLines, saveLines } = require('../lib/db');
const { getDoc, listDocs } = require('../lib/docs');
const { dollars, csvCell } = require('../lib/util');
const { getCustomer, getVehicle, vehicleOptions, customerOptions, resolveParty, logEvent } = require('../lib/records');
const { shareToken, appUrl } = require('./share');
const mail = require('../lib/mail');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = function (app, { store, xero, QUOTE_STATUSES }) {
  async function createDoc(db, req, type, fields, lines) {
    const today = req.res.locals.today;
    const settings = await db.get('SELECT payment_days, quote_days FROM settings');
    const f = {
      job_id: null,
      odometer: null,
      notes: '',
      issue_date: today,
      // Estimates use due_date as "valid until".
      due_date: addDays(today, type === 'invoice' ? settings.payment_days : settings.quote_days),
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

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const STATES = { invoice: ['unpaid', 'part paid', 'overdue', 'paid', 'void'], quote: ['draft', 'sent', 'accepted', 'declined'] };
  const SORTS = {
    newest: { label: 'Newest first', fn: (a, b) => (b.issue_date + b.number).localeCompare(a.issue_date + a.number) },
    oldest: { label: 'Oldest first', fn: (a, b) => (a.issue_date + a.number).localeCompare(b.issue_date + b.number) },
    due: { label: 'Due date', fn: (a, b) => String(a.due_date || '9').localeCompare(String(b.due_date || '9')) },
    customer: { label: 'Customer A to Z', fn: (a, b) => a.customer_name.localeCompare(b.customer_name) },
    total_desc: { label: 'Total, highest first', fn: (a, b) => b.total - a.total },
    balance_desc: { label: 'Balance owing, highest first', fn: (a, b) => b.balance - a.balance },
  };

  // The list with its filters: search, dates, status, sort. Shared by the page, the CSV and bulk actions.
  async function filteredList(req, type) {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : '';
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : '';
    const wanted = [].concat(req.query.state || []).filter((s) => STATES[type].includes(s));
    const show = req.query.show === 'all' ? 'all' : wanted.length || q || from || to ? 'filtered' : type === 'invoice' ? 'unpaid' : 'open';
    const sort = SORTS[req.query.sort] ? req.query.sort : 'newest';
    let docs = await listDocs(req.db, res_today(req), 'd.type = $1', [type], 'ORDER BY d.issue_date DESC, d.number DESC LIMIT 2000');
    if (show === 'unpaid') docs = docs.filter((d) => d.state !== 'void' && d.balance > 0);
    if (show === 'open') docs = docs.filter((d) => ['draft', 'sent'].includes(d.status));
    if (wanted.length) docs = docs.filter((d) => wanted.includes(d.state));
    if (from) docs = docs.filter((d) => d.issue_date >= from);
    if (to) docs = docs.filter((d) => d.issue_date <= to);
    if (q) {
      const compact = q.replace(/\s/g, '');
      docs = docs.filter((d) =>
        [docNumber(d), String(d.number), d.customer_name, d.customer_phone, d.rego, d.make, d.model, d.notes].some((v) => String(v || '').toLowerCase().replace(/\s/g, '').includes(compact))
      );
    }
    docs.sort(SORTS[sort].fn);
    return { docs, filters: { q, from, to, state: wanted, sort, show }, STATES: STATES[type], SORTS };
  }
  const res_today = (req) => req.res.locals.today;

  app.get(['/quotes', '/quotes.csv'], (req, res) => res.redirect(301, req.path.replace('/quotes', '/estimates') + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')));

  app.get(['/invoices', '/estimates'], async (req, res) => {
    const type = req.path === '/estimates' ? 'quote' : 'invoice';
    const { docs, filters, STATES: states, SORTS: sorts } = await filteredList(req, type);
    res.render('documents/index', { type, docs, filters, filter: filters.show, states, sorts, done: req.query.done || '' });
  });

  // Download the list as it is filtered, for a spreadsheet.
  app.get(['/invoices.csv', '/estimates.csv'], async (req, res) => {
    const type = req.path === '/estimates.csv' ? 'quote' : 'invoice';
    let { docs } = await filteredList(req, type);
    const ids = [].concat(req.query.ids || []).map(Number).filter(Boolean);
    if (ids.length) docs = docs.filter((d) => ids.includes(d.id));
    const rows = [['Number', 'Date', 'Due', 'Customer', 'Phone', 'Rego', 'Vehicle', 'Subtotal ex GST', 'GST', 'Total', 'Paid', 'Balance', 'Status', 'Job']];
    for (const d of docs) rows.push([docNumber(d), d.issue_date, d.due_date || '', d.customer_name, d.customer_phone, d.rego || '', [d.year, d.make, d.model].filter(Boolean).join(' '), dollars(d.subtotal), dollars(d.gst), dollars(d.total), dollars(d.paid), dollars(d.balance), d.state, d.job_id ? `J${d.job_number || ''}` : '']);
    res.type('text/csv').attachment(`${type === 'quote' ? 'estimates' : 'invoices'}.csv`).send(rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
  });

  // Bulk actions on ticked rows.
  app.post('/documents/bulk', async (req, res) => {
    const type = req.body.type === 'quote' ? 'quote' : 'invoice';
    const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean).slice(0, 200);
    const back = `/${type === 'quote' ? 'estimates' : 'invoices'}${req.body.back && /^\?[\w=&%+.-]*$/.test(req.body.back) ? req.body.back : ''}`;
    const action = String(req.body.action || '');
    if (!ids.length) return res.redirect(back);
    if (action === 'download') return res.redirect(`/${type === 'quote' ? 'estimates' : 'invoices'}.csv?${ids.map((i) => 'ids=' + i).join('&')}`);
    let n = 0;
    for (const id of ids) {
      const doc = await getDoc(req.db, id, res.locals.today);
      if (!doc || doc.type !== type) continue;
      if (action === 'sent' && ['draft', 'sent', 'issued'].includes(doc.status) && doc.status !== 'void') {
        await req.db.run(`UPDATE documents SET sent_at = COALESCE(sent_at, now()), sent_via = CASE WHEN sent_via = '' THEN 'marked' ELSE sent_via END${type === 'quote' ? ", status = 'sent'" : ''} WHERE id = $1`, [doc.id]);
        n++;
      } else if (action === 'void' && type === 'invoice' && doc.status !== 'void' && doc.paid === 0) {
        await req.db.tx(async (db) => {
          await db.run(`UPDATE documents SET status = 'void' WHERE id = $1`, [doc.id]);
          if (doc.job_id) {
            await db.run(`UPDATE jobs SET status = 'ready' WHERE id = $1 AND status = 'invoiced'`, [doc.job_id]);
            await logEvent(db, doc.job_id, req.user.id, 'invoice', `Invoice ${docNumber(doc)} voided`);
          }
        });
        await xero.queueInvoice(req.db, doc.id);
        n++;
      } else if (action === 'declined' && type === 'quote' && ['draft', 'sent'].includes(doc.status)) {
        await req.db.run(`UPDATE documents SET status = 'declined' WHERE id = $1`, [doc.id]);
        n++;
      } else if (action === 'delete' && type === 'quote') {
        await req.db.run('DELETE FROM documents WHERE id = $1', [doc.id]);
        await store.system.run('DELETE FROM share_links WHERE workshop_id = $1 AND document_id = $2', [req.user.workshop_id, doc.id]);
        n++;
      }
    }
    res.redirect(`${back}${back.includes('?') ? '&' : '?'}done=${n}`);
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
    const shareUrl = `${appUrl(req)}/share/${await shareToken(store, req.user.workshop_id, doc.id)}`;
    res.render('documents/show', {
      doc, lines, payments, converted, xeroStatus, shareUrl,
      canEmail: mail.configured(),
      saved: req.query.saved === '1',
      sent: req.query.sent === '1',
      error: String(req.query.error || '').slice(0, 300),
    });
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
        [await nextNumber(db, 'job'), quote.customer_id, quote.vehicle_id, quote.notes || `From estimate ${docNumber(quote)}`, quote.odometer, now(req.tz)]
      );
      await saveLines(db, 'job', job.id, await getLines(db, 'document', quote.id));
      await db.run(`UPDATE documents SET status = 'accepted', job_id = $1 WHERE id = $2`, [job.id, quote.id]);
      await logEvent(db, job.id, req.user.id, 'created', `Job opened from estimate ${docNumber(quote)}`);
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
    await store.system.run('DELETE FROM share_links WHERE workshop_id = $1 AND document_id = $2', [req.user.workshop_id, doc.id]);
    res.redirect('/estimates');
  });
};
