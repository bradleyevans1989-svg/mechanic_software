const { now, today, addDays, parseLines, parseIntOrNull, totals } = require('../lib/util');
const { nextNumber, getLines, saveLines } = require('../lib/db');
const { getCustomer, getVehicle, vehicleOptions, customerOptions, resolveParty } = require('../lib/records');

module.exports = function (app, { db, JOB_STATUSES }) {
  const JOB_SELECT = `
    SELECT j.*, c.name AS customer_name, c.phone AS customer_phone, v.rego, v.make, v.model, v.year,
      (SELECT id FROM documents WHERE job_id = j.id AND type = 'invoice' AND status != 'void' LIMIT 1) AS invoice_id
    FROM jobs j JOIN customers c ON c.id = j.customer_id
    LEFT JOIN vehicles v ON v.id = j.vehicle_id`;

  function getJob(id) {
    return db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(id);
  }

  app.get('/jobs', (req, res) => {
    const filter = req.query.status || 'active';
    let where = `j.status NOT IN ('invoiced', 'cancelled')`;
    if (filter === 'all') where = '1=1';
    else if (JOB_STATUSES[filter]) where = `j.status = '${filter}'`;
    const jobs = db.prepare(`${JOB_SELECT} WHERE ${where} ORDER BY j.created_at DESC LIMIT 500`).all();
    res.render('jobs/index', { jobs, filter });
  });

  app.get('/jobs/new', (req, res) => {
    res.render('jobs/new', {
      job: { vehicle_id: Number(req.query.vehicle_id) || null, customer_id: Number(req.query.customer_id) || null },
      vehicles: vehicleOptions(db),
      customers: customerOptions(db),
      error: null,
    });
  });

  app.post('/jobs', (req, res) => {
    const party = resolveParty(db, req.body);
    if (!party) {
      return res.status(400).render('jobs/new', {
        job: req.body,
        vehicles: vehicleOptions(db),
        customers: customerOptions(db),
        error: 'Pick a vehicle or customer.',
      });
    }
    let odometer = parseIntOrNull(req.body.odometer);
    if (odometer === null && party.vehicle_id) odometer = getVehicle(db, party.vehicle_id).odometer;
    const id = db.transaction(() =>
      db
        .prepare(
          `INSERT INTO jobs (number, customer_id, vehicle_id, status, description, odometer, created_at)
           VALUES (?, ?, ?, 'open', ?, ?, ?)`
        )
        .run(nextNumber(db, 'job'), party.customer_id, party.vehicle_id, String(req.body.description || '').trim(), odometer, now())
        .lastInsertRowid
    )();
    res.redirect(`/jobs/${id}`);
  });

  app.get('/jobs/:id', (req, res, next) => {
    const job = getJob(req.params.id);
    if (!job) return next();
    const lines = getLines(db, 'job', job.id);
    res.render('jobs/show', { job, lines, totals: totals(lines), saved: req.query.saved === '1' });
  });

  app.post('/jobs/:id', (req, res, next) => {
    const job = getJob(req.params.id);
    if (!job) return next();
    const status = JOB_STATUSES[req.body.status] ? req.body.status : job.status;
    db.transaction(() => {
      db.prepare(
        `UPDATE jobs SET status = ?, description = ?, tech_notes = ?, odometer = ?,
           completed_at = CASE WHEN ? IN ('ready', 'invoiced') THEN COALESCE(completed_at, ?) ELSE NULL END
         WHERE id = ?`
      ).run(
        status,
        String(req.body.description || '').trim(),
        String(req.body.tech_notes || '').trim(),
        parseIntOrNull(req.body.odometer),
        status,
        now(),
        job.id
      );
      saveLines(db, 'job', job.id, parseLines(req.body));
    })();
    res.redirect(`/jobs/${job.id}?saved=1`);
  });

  app.get('/jobs/:id/print', (req, res, next) => {
    const job = getJob(req.params.id);
    if (!job) return next();
    res.render('jobs/print', {
      job,
      lines: getLines(db, 'job', job.id),
      customer: getCustomer(db, job.customer_id),
      vehicle: job.vehicle_id ? getVehicle(db, job.vehicle_id) : null,
    });
  });

  // Turn the job card into a tax invoice with the same lines.
  app.post('/jobs/:id/invoice', (req, res, next) => {
    const job = getJob(req.params.id);
    if (!job) return next();
    if (job.invoice_id) return res.redirect(`/documents/${job.invoice_id}`);
    const settings = db.prepare('SELECT payment_days FROM settings WHERE id = 1').get();
    const docId = db.transaction(() => {
      const id = db
        .prepare(
          `INSERT INTO documents (type, number, customer_id, vehicle_id, job_id, issue_date, due_date, status, odometer, notes, created_at)
           VALUES ('invoice', ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?)`
        )
        .run(
          nextNumber(db, 'invoice'),
          job.customer_id,
          job.vehicle_id,
          job.id,
          today(),
          addDays(today(), settings.payment_days),
          job.odometer,
          job.description,
          now()
        ).lastInsertRowid;
      saveLines(db, 'document', id, getLines(db, 'job', job.id));
      db.prepare(`UPDATE jobs SET status = 'invoiced', completed_at = COALESCE(completed_at, ?) WHERE id = ?`).run(now(), job.id);
      if (job.vehicle_id && job.odometer) {
        db.prepare('UPDATE vehicles SET odometer = MAX(COALESCE(odometer, 0), ?) WHERE id = ?').run(job.odometer, job.vehicle_id);
      }
      return id;
    })();
    res.redirect(`/documents/${docId}`);
  });

  app.post('/jobs/:id/delete', (req, res) => {
    db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
    res.redirect('/jobs');
  });
};
