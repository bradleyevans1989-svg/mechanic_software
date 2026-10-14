const { now, addDays, parseLines, parseIntOrNull, totals } = require('../lib/util');
const { nextNumber, getLines, saveLines } = require('../lib/db');
const { getCustomer, getVehicle, vehicleOptions, customerOptions, resolveParty, mechanics } = require('../lib/records');

const JOB_SELECT = `
  SELECT j.*, c.name AS customer_name, c.phone AS customer_phone, v.rego, v.make, v.model, v.year, m.name AS mechanic_name,
    (SELECT id FROM documents WHERE job_id = j.id AND type = 'invoice' AND status != 'void' LIMIT 1) AS invoice_id
  FROM jobs j JOIN customers c ON c.id = j.customer_id
  LEFT JOIN vehicles v ON v.id = j.vehicle_id
  LEFT JOIN users m ON m.id = j.mechanic_id`;

module.exports = function (app, { store, xero, JOB_STATUSES }) {
  const getJob = (db, id) => db.get(`${JOB_SELECT} WHERE j.id = $1`, [id]);

  // Only this workshop's own staff can be put on a job.
  async function validMechanic(req, value) {
    const id = parseIntOrNull(value);
    if (!id) return null;
    const m = await store.system.get('SELECT id FROM users WHERE id = $1 AND workshop_id = $2', [id, req.user.workshop_id]);
    return m ? m.id : null;
  }

  app.get('/jobs', async (req, res) => {
    const filter = req.query.status || 'active';
    let where = `j.status NOT IN ('invoiced', 'cancelled')`;
    const params = [];
    if (filter === 'all') where = 'true';
    else if (JOB_STATUSES[filter]) {
      where = 'j.status = $1';
      params.push(filter);
    }
    const jobs = await req.db.all(`${JOB_SELECT} WHERE ${where} ORDER BY j.created_at DESC LIMIT 500`, params);
    res.render('jobs/index', { jobs, filter });
  });

  async function renderNew(req, res, job, error) {
    const [vehicles, customers] = await Promise.all([vehicleOptions(req.db), customerOptions(req.db)]);
    res.render('jobs/new', { job, vehicles, customers, error });
  }

  app.get('/jobs/new', (req, res) =>
    renderNew(req, res, { vehicle_id: Number(req.query.vehicle_id) || null, customer_id: Number(req.query.customer_id) || null }, null)
  );

  app.post('/jobs', async (req, res) => {
    const party = await resolveParty(req.db, req.body);
    if (!party) return renderNew(req, res.status(400), req.body, 'Pick a vehicle or customer.');
    let odometer = parseIntOrNull(req.body.odometer);
    if (odometer === null && party.vehicle_id) odometer = (await getVehicle(req.db, party.vehicle_id)).odometer;
    const job = await req.db.tx(async (db) =>
      db.get(
        `INSERT INTO jobs (number, customer_id, vehicle_id, status, description, odometer, created_at)
         VALUES ($1, $2, $3, 'open', $4, $5, $6) RETURNING id`,
        [await nextNumber(db, 'job'), party.customer_id, party.vehicle_id, String(req.body.description || '').trim().slice(0, 5000), odometer, now(req.tz)]
      )
    );
    res.redirect(`/jobs/${job.id}`);
  });

  app.get('/jobs/:id', async (req, res, next) => {
    const job = await getJob(req.db, req.params.id);
    if (!job) return next();
    const [lines, staff] = await Promise.all([getLines(req.db, 'job', job.id), mechanics(store, req.user.workshop_id)]);
    res.render('jobs/show', { job, lines, totals: totals(lines), mechanics: staff, saved: req.query.saved === '1' });
  });

  app.post('/jobs/:id', async (req, res, next) => {
    const job = await getJob(req.db, req.params.id);
    if (!job) return next();
    const status = JOB_STATUSES[req.body.status] ? req.body.status : job.status;
    const mechanicId = await validMechanic(req, req.body.mechanic_id);
    await req.db.tx(async (db) => {
      await db.run(
        `UPDATE jobs SET status = $1, mechanic_id = $2, description = $3, tech_notes = $4, odometer = $5,
           completed_at = CASE WHEN $1 IN ('ready', 'invoiced') THEN COALESCE(completed_at, $6) ELSE NULL END
         WHERE id = $7`,
        [
          status,
          mechanicId,
          String(req.body.description || '').trim().slice(0, 5000),
          String(req.body.tech_notes || '').trim().slice(0, 10000),
          parseIntOrNull(req.body.odometer),
          now(req.tz),
          job.id,
        ]
      );
      await saveLines(db, 'job', job.id, parseLines(req.body));
    });
    res.redirect(`/jobs/${job.id}?saved=1`);
  });

  app.get('/jobs/:id/print', async (req, res, next) => {
    const job = await getJob(req.db, req.params.id);
    if (!job) return next();
    res.render('jobs/print', {
      job,
      lines: await getLines(req.db, 'job', job.id),
      customer: await getCustomer(req.db, job.customer_id),
      vehicle: job.vehicle_id ? await getVehicle(req.db, job.vehicle_id) : null,
    });
  });

  // Turn the job card into a tax invoice with the same lines.
  app.post('/jobs/:id/invoice', async (req, res, next) => {
    const result = await req.db.tx(async (db) => {
      // Lock the job so a double click makes one invoice, not two.
      const job = await db.get('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!job) return null;
      const existing = await db.get(`SELECT id FROM documents WHERE job_id = $1 AND type = 'invoice' AND status != 'void'`, [job.id]);
      if (existing) return { id: existing.id, created: false };
      const settings = await db.get('SELECT payment_days FROM settings');
      const today = res.locals.today;
      const doc = await db.get(
        `INSERT INTO documents (type, number, customer_id, vehicle_id, job_id, issue_date, due_date, status, odometer, notes, created_at)
         VALUES ('invoice', $1, $2, $3, $4, $5, $6, 'issued', $7, $8, $9) RETURNING id`,
        [
          await nextNumber(db, 'invoice'),
          job.customer_id,
          job.vehicle_id,
          job.id,
          today,
          addDays(today, settings.payment_days),
          job.odometer,
          job.description,
          now(req.tz),
        ]
      );
      await saveLines(db, 'document', doc.id, await getLines(db, 'job', job.id));
      await db.run(`UPDATE jobs SET status = 'invoiced', completed_at = COALESCE(completed_at, $1) WHERE id = $2`, [now(req.tz), job.id]);
      if (job.vehicle_id && job.odometer) {
        await db.run('UPDATE vehicles SET odometer = GREATEST(COALESCE(odometer, 0), $1) WHERE id = $2', [job.odometer, job.vehicle_id]);
      }
      return { id: doc.id, created: true };
    });
    if (!result) return next();
    if (result.created) await xero.queueInvoice(req.db, result.id);
    res.redirect(`/documents/${result.id}`);
  });

  app.post('/jobs/:id/delete', async (req, res) => {
    await req.db.run('DELETE FROM jobs WHERE id = $1', [req.params.id]);
    res.redirect('/jobs');
  });
};
