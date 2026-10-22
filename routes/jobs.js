const { now, addDays, parseLines, parseIntOrNull, totals, minutesBetween, billableHours, parseDollars } = require('../lib/util');
const { nextNumber, getLines, saveLines } = require('../lib/db');
const {
  getCustomer, getVehicle, vehicleOptions, customerOptions, resolveParty, mechanics, logEvent, CHECK_RESULTS, checklistItems,
} = require('../lib/records');

const { PO_STATUSES } = require('./parts');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITIES = { normal: 'Normal', urgent: 'Urgent' };

const JOB_SELECT = `
  SELECT j.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
    v.rego, v.make, v.model, v.year, m.name AS mechanic_name,
    (SELECT id FROM documents WHERE job_id = j.id AND type = 'invoice' AND status != 'void' LIMIT 1) AS invoice_id,
    (SELECT COUNT(*) FROM job_checks k WHERE k.job_id = j.id AND NOT k.heading AND k.result IN ('attention', 'urgent')) AS flagged,
    (SELECT COUNT(*) FROM time_entries t WHERE t.job_id = j.id AND t.ended_at IS NULL) AS clocked_on
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

  // Jobs the workshop is working on, soonest promised first.
  app.get('/jobs', async (req, res) => {
    const filter = req.query.status || 'active';
    let where = `j.status NOT IN ('invoiced', 'cancelled')`;
    const params = [];
    if (filter === 'all') where = 'true';
    else if (filter === 'mine') {
      where = `j.status NOT IN ('invoiced', 'cancelled') AND j.mechanic_id = $1`;
      params.push(req.user.id);
    } else if (JOB_STATUSES[filter]) {
      where = 'j.status = $1';
      params.push(filter);
    }
    const order =
      filter === 'all' || filter === 'invoiced' || filter === 'cancelled'
        ? 'j.created_at DESC'
        : `j.priority = 'urgent' DESC, j.due_date NULLS LAST, j.due_time, j.created_at`;
    const jobs = await req.db.all(`${JOB_SELECT} WHERE ${where} ORDER BY ${order} LIMIT 500`, params);
    const view = req.query.view === 'board' ? 'board' : 'list';
    res.render('jobs/index', { jobs, filter, view, PRIORITIES });
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
    const description = String(req.body.description || '').trim().slice(0, 5000);
    const job = await req.db.tx(async (db) => {
      const j = await db.get(
        `INSERT INTO jobs (number, customer_id, vehicle_id, status, description, odometer, created_at, due_date, is_service)
         VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8) RETURNING id`,
        [
          await nextNumber(db, 'job'),
          party.customer_id,
          party.vehicle_id,
          description,
          odometer,
          now(req.tz),
          DATE_RE.test(req.body.due_date || '') ? req.body.due_date : null,
          /service/i.test(description),
        ]
      );
      await logEvent(db, j.id, req.user.id, 'created', 'Job opened');
      return j;
    });
    res.redirect(`/jobs/${job.id}`);
  });

  async function jobExtras(req, job) {
    const [lines, staff, checks, time, events, orders, suppliers] = await Promise.all([
      getLines(req.db, 'job', job.id),
      mechanics(store, req.user.workshop_id),
      req.db.all('SELECT * FROM job_checks WHERE job_id = $1 ORDER BY sort, id', [job.id]),
      req.db.all(
        `SELECT t.*, u.name AS user_name FROM time_entries t LEFT JOIN users u ON u.id = t.user_id
         WHERE t.job_id = $1 ORDER BY t.started_at, t.id`,
        [job.id]
      ),
      req.db.all(
        `SELECT e.*, u.name AS user_name FROM job_events e LEFT JOIN users u ON u.id = e.user_id
         WHERE e.job_id = $1 ORDER BY e.at DESC, e.id DESC LIMIT 200`,
        [job.id]
      ),
      req.db.all(
        `SELECT o.*, s.name AS supplier_name,
           (SELECT COALESCE(SUM(ROUND(l.qty * l.cost_cents)), 0) FROM purchase_order_lines l WHERE l.order_id = o.id) AS cost_cents
         FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.job_id = $1 ORDER BY o.id`,
        [job.id]
      ),
      req.db.all('SELECT id, name FROM suppliers WHERE active ORDER BY lower(name)'),
    ]);
    for (const t of time) t.minutes = minutesBetween(t.started_at, t.ended_at);
    const unbilled = time.filter((t) => t.ended_at && !t.billed).reduce((s, t) => s + t.minutes, 0);
    return {
      lines,
      totals: totals(lines),
      mechanics: staff,
      checks,
      time,
      events,
      orders,
      suppliers,
      PO_STATUSES,
      myOpenEntry: time.find((t) => !t.ended_at && t.user_id === req.user.id) || null,
      totalMinutes: time.reduce((s, t) => s + t.minutes, 0),
      unbilledMinutes: unbilled,
      unbilledHours: billableHours(unbilled),
    };
  }

  app.get('/jobs/:id', async (req, res, next) => {
    const job = await getJob(req.db, req.params.id);
    if (!job) return next();
    res.render('jobs/show', {
      job,
      ...(await jobExtras(req, job)),
      approval: await require('./inspection-approval').jobApproval(store, req, job.id),
      CHECK_RESULTS,
      PRIORITIES,
      saved: req.query.saved === '1',
      texted: req.query.texted === '1',
    });
  });

  app.post('/jobs/:id', async (req, res, next) => {
    const job = await getJob(req.db, req.params.id);
    if (!job) return next();
    const status = JOB_STATUSES[req.body.status] ? req.body.status : job.status;
    const mechanicId = await validMechanic(req, req.body.mechanic_id);
    const g = (k) => String(req.body[k] ?? '').trim();
    await req.db.tx(async (db) => {
      await db.run(
        `UPDATE jobs SET status = $1, mechanic_id = $2, description = $3, tech_notes = $4, odometer = $5,
           completed_at = CASE WHEN $1 IN ('ready', 'invoiced') THEN COALESCE(completed_at, $6) ELSE NULL END,
           due_date = $8, due_time = $9, priority = $10, is_service = $11
         WHERE id = $7`,
        [
          status,
          mechanicId,
          g('description').slice(0, 5000),
          g('tech_notes').slice(0, 10000),
          parseIntOrNull(req.body.odometer),
          now(req.tz),
          job.id,
          DATE_RE.test(g('due_date')) ? g('due_date') : null,
          /^\d{2}:\d{2}$/.test(g('due_time')) ? g('due_time') : '',
          PRIORITIES[g('priority')] ? g('priority') : 'normal',
          req.body.is_service === '1',
        ]
      );
      await saveLines(db, 'job', job.id, parseLines(req.body));
      // Checklist results come in as checks[c<id>][result] and checks[c<id>][note].
      // (The "c" keeps the body parser from turning numeric keys into a compacted array.)
      const checks = req.body.checks && typeof req.body.checks === 'object' ? req.body.checks : {};
      for (const [key, c] of Object.entries(checks)) {
        if (!/^c\d{1,9}$/.test(key) || !c || typeof c !== 'object') continue;
        const id = key.slice(1);
        const price = String(c.price ?? '').trim() === '' ? null : Math.max(parseDollars(c.price), 0);
        await db.run('UPDATE job_checks SET result = $1, note = $2, price_cents = $3 WHERE id = $4 AND job_id = $5', [
          CHECK_RESULTS[c.result] ? c.result : '',
          String(c.note || '').trim().slice(0, 500),
          price,
          Number(id),
          job.id,
        ]);
      }
      if (status !== job.status) await logEvent(db, job.id, req.user.id, 'status', `Status changed to ${JOB_STATUSES[status]}`);
      if (mechanicId !== job.mechanic_id) {
        const m = mechanicId ? await store.system.get('SELECT name FROM users WHERE id = $1', [mechanicId]) : null;
        await logEvent(db, job.id, req.user.id, 'mechanic', m ? `Assigned to ${m.name}` : 'Mechanic unassigned');
      }
    });
    res.redirect(`/jobs/${job.id}?saved=1`);
  });

  // Quick internal note from the activity panel.
  app.post('/jobs/:id/notes', async (req, res, next) => {
    const job = await req.db.get('SELECT id FROM jobs WHERE id = $1', [req.params.id]);
    if (!job) return next();
    const text = String(req.body.text || '').trim().slice(0, 2000);
    if (text) await logEvent(req.db, job.id, req.user.id, 'note', text);
    res.redirect(`/jobs/${job.id}#activity`);
  });

  // Inspection checklist from the workshop's template.
  app.post('/jobs/:id/checklist', async (req, res, next) => {
    const job = await req.db.get('SELECT id FROM jobs WHERE id = $1', [req.params.id]);
    if (!job) return next();
    const settings = await req.db.get('SELECT checklist FROM settings');
    await req.db.tx(async (db) => {
      const existing = await db.get('SELECT COUNT(*) AS n FROM job_checks WHERE job_id = $1', [job.id]);
      if (existing.n) return;
      for (const [i, c] of checklistItems(settings.checklist).entries()) {
        await db.run('INSERT INTO job_checks (job_id, item, heading, sort) VALUES ($1, $2, $3, $4)', [job.id, c.item, c.heading, i]);
      }
      await logEvent(db, job.id, req.user.id, 'checklist', 'Inspection checklist added');
    });
    res.redirect(`/jobs/${job.id}#inspection`);
  });

  app.post('/jobs/:id/checklist/remove', async (req, res, next) => {
    const job = await req.db.get('SELECT id FROM jobs WHERE id = $1', [req.params.id]);
    if (!job) return next();
    await req.db.run('DELETE FROM job_checks WHERE job_id = $1', [job.id]);
    res.redirect(`/jobs/${job.id}`);
  });

  // Customer-facing inspection report.
  app.get('/jobs/:id/inspection', async (req, res, next) => {
    const job = await getJob(req.db, req.params.id);
    if (!job) return next();
    const checks = await req.db.all('SELECT * FROM job_checks WHERE job_id = $1 ORDER BY sort, id', [job.id]);
    res.render('jobs/inspection', {
      job,
      checks,
      CHECK_RESULTS,
      customer: await getCustomer(req.db, job.customer_id),
      vehicle: job.vehicle_id ? await getVehicle(req.db, job.vehicle_id) : null,
    });
  });

  // Clock on: closes anything this person was already clocked on to.
  app.post('/jobs/:id/clock-on', async (req, res, next) => {
    const job = await req.db.get('SELECT id, number FROM jobs WHERE id = $1', [req.params.id]);
    if (!job) return next();
    await req.db.tx(async (db) => {
      const open = await db.all('SELECT id, job_id FROM time_entries WHERE user_id = $1 AND ended_at IS NULL', [req.user.id]);
      for (const o of open) {
        await db.run('UPDATE time_entries SET ended_at = now() WHERE id = $1', [o.id]);
        await logEvent(db, o.job_id, req.user.id, 'clock', `${req.user.name} clocked off`);
      }
      await db.run('INSERT INTO time_entries (job_id, user_id) VALUES ($1, $2)', [job.id, req.user.id]);
      await logEvent(db, job.id, req.user.id, 'clock', `${req.user.name} clocked on`);
    });
    res.redirect(`/jobs/${job.id}#time`);
  });

  app.post('/jobs/:id/clock-off', async (req, res, next) => {
    const job = await req.db.get('SELECT id FROM jobs WHERE id = $1', [req.params.id]);
    if (!job) return next();
    const note = String(req.body.note || '').trim().slice(0, 500);
    await req.db.tx(async (db) => {
      const r = await db.run('UPDATE time_entries SET ended_at = now(), note = $3 WHERE job_id = $1 AND user_id = $2 AND ended_at IS NULL', [job.id, req.user.id, note]);
      if (r.rowCount) await logEvent(db, job.id, req.user.id, 'clock', `${req.user.name} clocked off${note ? ': ' + note : ''}`);
    });
    res.redirect(`/jobs/${job.id}#time`);
  });

  // A manual entry for time that wasn't clocked.
  app.post('/jobs/:id/time', async (req, res, next) => {
    const job = await req.db.get('SELECT id FROM jobs WHERE id = $1', [req.params.id]);
    if (!job) return next();
    const minutes = Math.round((parseFloat(req.body.hours) || 0) * 60);
    const userId = (await validMechanic(req, req.body.user_id)) || req.user.id;
    if (minutes > 0 && minutes <= 24 * 60) {
      await req.db.run(
        `INSERT INTO time_entries (job_id, user_id, started_at, ended_at, note)
         VALUES ($1, $2, now() - make_interval(mins => $3), now(), $4)`,
        [job.id, userId, minutes, String(req.body.note || '').trim().slice(0, 500)]
      );
    }
    res.redirect(`/jobs/${job.id}#time`);
  });

  app.post('/jobs/:id/time/:pid/delete', async (req, res) => {
    await req.db.run('DELETE FROM time_entries WHERE id = $1 AND job_id = $2', [req.params.pid, req.params.id]);
    res.redirect(`/jobs/${req.params.id}#time`);
  });

  // Turns the unbilled clocked time into a labour line at the workshop rate.
  app.post('/jobs/:id/time/bill', async (req, res, next) => {
    const job = await req.db.get('SELECT id FROM jobs WHERE id = $1', [req.params.id]);
    if (!job) return next();
    await req.db.tx(async (db) => {
      const entries = await db.all('SELECT * FROM time_entries WHERE job_id = $1 AND ended_at IS NOT NULL AND NOT billed', [job.id]);
      const minutes = entries.reduce((s, t) => s + minutesBetween(t.started_at, t.ended_at), 0);
      const hours = billableHours(minutes);
      if (!hours) return;
      const settings = await db.get('SELECT labour_rate_cents FROM settings');
      const lines = await getLines(db, 'job', job.id);
      lines.push({ kind: 'labour', description: 'Labour', qty: hours, unit_cents: settings.labour_rate_cents, gst: 1 });
      await saveLines(db, 'job', job.id, lines);
      await db.run('UPDATE time_entries SET billed = true WHERE job_id = $1 AND ended_at IS NOT NULL AND NOT billed', [job.id]);
      await logEvent(db, job.id, req.user.id, 'labour', `${hours} hrs of clocked time added as labour`);
    });
    res.redirect(`/jobs/${job.id}?saved=1`);
  });

  app.get('/jobs/:id/print', async (req, res, next) => {
    const job = await getJob(req.db, req.params.id);
    if (!job) return next();
    res.render('jobs/print', {
      job,
      lines: await getLines(req.db, 'job', job.id),
      checks: await req.db.all('SELECT * FROM job_checks WHERE job_id = $1 ORDER BY sort, id', [job.id]),
      CHECK_RESULTS,
      customer: await getCustomer(req.db, job.customer_id),
      vehicle: job.vehicle_id ? await getVehicle(req.db, job.vehicle_id) : null,
    });
  });

  // Turn the job card into a tax invoice with the same lines.
  // Turn a job into an invoice: copies the lines, marks the job invoiced, clocks everyone off.
  async function invoiceJob(req, res, jobId) {
    const result = await req.db.tx(async (db) => {
      // Lock the job so a double click makes one invoice, not two.
      const job = await db.get('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
      if (!job) return null;
      const existing = await db.get(`SELECT id FROM documents WHERE job_id = $1 AND type = 'invoice' AND status != 'void'`, [job.id]);
      if (existing) return { id: existing.id, created: false };
      const settings = await db.get('SELECT payment_days FROM settings');
      const today = res.locals.today;
      const doc = await db.get(
        `INSERT INTO documents (type, number, customer_id, vehicle_id, job_id, issue_date, due_date, status, odometer, notes, created_at)
         VALUES ('invoice', $1, $2, $3, $4, $5, $6, 'issued', $7, $8, $9) RETURNING id, number`,
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
      // Anyone still on the clock comes off it.
      await db.run('UPDATE time_entries SET ended_at = now() WHERE job_id = $1 AND ended_at IS NULL', [job.id]);
      if (job.vehicle_id) {
        if (job.odometer) await db.run('UPDATE vehicles SET odometer = GREATEST(COALESCE(odometer, 0), $1) WHERE id = $2', [job.odometer, job.vehicle_id]);
        // A service resets when the next one is due, if the vehicle has intervals set.
        if (job.is_service) {
          await db.run(
            `UPDATE vehicles SET
               next_service_date = CASE WHEN service_interval_months > 0 THEN to_char(($2::date + make_interval(months => service_interval_months)), 'YYYY-MM-DD') ELSE next_service_date END,
               next_service_km = CASE WHEN service_interval_km > 0 AND $3::integer IS NOT NULL THEN $3::integer + service_interval_km ELSE next_service_km END,
               last_service_date = $2
             WHERE id = $1`,
            [job.vehicle_id, today, job.odometer]
          );
        }
      }
      await logEvent(db, job.id, req.user.id, 'invoice', `Invoice INV-${doc.number} created`);
      return { id: doc.id, created: true };
    });
    if (result && result.created) await xero.queueInvoice(req.db, result.id);
    return result;
  }

  app.post('/jobs/:id/invoice', async (req, res, next) => {
    const result = await invoiceJob(req, res, req.params.id);
    if (!result) return next();
    res.redirect(`/documents/${result.id}`);
  });

  // Quick status change from the jobs list; "invoice" makes the invoice instead.
  app.post('/jobs/:id/status', async (req, res, next) => {
    const job = await getJob(req.db, req.params.id);
    if (!job) return next();
    const back = /^\/jobs(\?[\w=&%-]*)?$/.test(String(req.body.back || '')) ? req.body.back : '/jobs';
    if (req.body.status === 'invoice') {
      const result = await invoiceJob(req, res, job.id);
      return res.redirect(`/documents/${result.id}`);
    }
    const status = JOB_STATUSES[req.body.status] ? req.body.status : job.status;
    if (status !== job.status) {
      await req.db.tx(async (db) => {
        await db.run(
          `UPDATE jobs SET status = $1, completed_at = CASE WHEN $1 IN ('ready', 'invoiced') THEN COALESCE(completed_at, $2) ELSE NULL END WHERE id = $3`,
          [status, now(req.tz), job.id]
        );
        await logEvent(db, job.id, req.user.id, 'status', `Status changed to ${JOB_STATUSES[status]}`);
      });
    }
    res.redirect(back);
  });

  app.post('/jobs/:id/delete', async (req, res) => {
    await req.db.run('DELETE FROM jobs WHERE id = $1', [req.params.id]);
    res.redirect('/jobs');
  });
};

module.exports.PRIORITIES = PRIORITIES;
