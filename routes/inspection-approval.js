const crypto = require('crypto');
const { getCustomer, getVehicle, logEvent, CHECK_RESULTS } = require('../lib/records');
const { money, roundCents } = require('../lib/util');
const { appUrl } = require('./share');

const FLAGGED = ['attention', 'urgent'];
const withGst = (cents) => roundCents(cents * 1.1);

// The link a customer gets for a job's inspection; made once and reused.
async function inspectionToken(store, workshopId, jobId, create = true) {
  const sys = store.system;
  const row = await sys.get('SELECT * FROM inspection_links WHERE workshop_id = $1 AND job_id = $2', [workshopId, jobId]);
  if (row || !create) return row || null;
  await sys.run('INSERT INTO inspection_links (token, workshop_id, job_id) VALUES ($1, $2, $3) ON CONFLICT (workshop_id, job_id) DO NOTHING', [
    crypto.randomBytes(16).toString('hex'),
    workshopId,
    jobId,
  ]);
  return sys.get('SELECT * FROM inspection_links WHERE workshop_id = $1 AND job_id = $2', [workshopId, jobId]);
}

module.exports = {
  inspectionToken,

  // What the job card shows about the customer link: its address, and when it was opened and answered.
  async jobApproval(store, req, jobId) {
    const link = await inspectionToken(store, req.user.workshop_id, jobId, false);
    return link ? { ...link, url: `${appUrl(req)}/inspection/${link.token}` } : null;
  },

  // The customer's side: no login, the token is the key.
  public(app, { store }) {
    async function load(req) {
      const token = String(req.params.token || '');
      if (!/^[a-f0-9]{32}$/.test(token)) return null;
      const link = await store.system.get('SELECT * FROM inspection_links WHERE token = $1', [token]);
      if (!link) return null;
      const db = store.tenant(link.workshop_id);
      const job = await db.get(
        `SELECT j.*, m.name AS mechanic_name FROM jobs j LEFT JOIN users m ON m.id = j.mechanic_id WHERE j.id = $1`,
        [link.job_id]
      );
      if (!job || job.status === 'cancelled') return null;
      const settings = await db.get('SELECT * FROM settings');
      const checks = await db.all('SELECT * FROM job_checks WHERE job_id = $1 ORDER BY sort, id', [job.id]);
      return { link, db, job, settings, checks };
    }

    const gone = (res) => res.status(404).render('message', { title: 'Link not found', message: 'This inspection link is no longer valid. Please contact the workshop.' });

    app.get('/inspection/:token', async (req, res) => {
      const found = await load(req);
      if (!found) return gone(res);
      const { link, db, job, settings, checks } = found;
      if (!link.viewed_at) await store.system.run('UPDATE inspection_links SET viewed_at = now() WHERE token = $1', [link.token]);
      res.locals.settings = settings;
      res.render('inspection-approval/public', {
        token: link.token,
        job,
        checks,
        flagged: checks.filter((c) => !c.heading && FLAGGED.includes(c.result)),
        customer: await getCustomer(db, job.customer_id),
        vehicle: job.vehicle_id ? await getVehicle(db, job.vehicle_id) : null,
        hasLogo: Boolean(await db.get('SELECT 1 AS x FROM logos')),
        locked: job.status === 'invoiced',
        thanks: req.query.thanks === '1',
        CHECK_RESULTS,
        withGst,
      });
    });

    app.get('/inspection/:token/logo', async (req, res) => {
      const found = await load(req);
      if (!found) return res.status(404).end();
      await require('./templates').serveSharedLogo(found.db, res);
    });

    // The customer's answers: decisions[c<id>] = approve or decline for each flagged item.
    app.post('/inspection/:token', async (req, res) => {
      const found = await load(req);
      if (!found) return gone(res);
      const { link, db, job, checks } = found;
      if (job.status === 'invoiced') return res.redirect(`/inspection/${link.token}`);
      const decisions = req.body.decisions && typeof req.body.decisions === 'object' ? req.body.decisions : {};
      const approved = [];
      const declined = [];
      await db.tx(async (tx) => {
        for (const c of checks) {
          if (c.heading || !FLAGGED.includes(c.result) || c.added_to_job) continue;
          const d = decisions[`c${c.id}`];
          const decision = d === 'approve' ? 'approved' : d === 'decline' ? 'declined' : '';
          if (!decision || decision === c.decision) continue;
          await tx.run('UPDATE job_checks SET decision = $1, decided_at = now() WHERE id = $2', [decision, c.id]);
          (decision === 'approved' ? approved : declined).push(c);
        }
        if (approved.length || declined.length) {
          const total = approved.reduce((s, c) => s + withGst(c.price_cents || 0), 0);
          const parts = [];
          if (approved.length) parts.push(`approved ${approved.map((c) => c.item).join(', ')}${total ? ` (${money(total)} inc GST)` : ''}`);
          if (declined.length) parts.push(`declined ${declined.map((c) => c.item).join(', ')}`);
          await logEvent(tx, job.id, null, 'approval', `Customer ${parts.join('; ')} online`);
        }
      });
      await store.system.run('UPDATE inspection_links SET responded_at = now() WHERE token = $1', [link.token]);
      res.redirect(`/inspection/${link.token}?thanks=1`);
    });
  },

  // The workshop's side: make the link, and put approved work on the job.
  pages(app, { store }) {
    app.post('/jobs/:id/inspection/share', async (req, res, next) => {
      const job = await req.db.get('SELECT id FROM jobs WHERE id = $1', [req.params.id]);
      if (!job) return next();
      await inspectionToken(store, req.user.workshop_id, job.id);
      await logEvent(req.db, job.id, req.user.id, 'approval', 'Inspection link made for the customer');
      res.redirect(`/jobs/${job.id}#approval`);
    });

    // Approved items become labour lines on the job, at the quoted price.
    app.post('/jobs/:id/inspection/add-approved', async (req, res, next) => {
      const job = await req.db.get('SELECT id, status FROM jobs WHERE id = $1', [req.params.id]);
      if (!job) return next();
      await req.db.tx(async (db) => {
        const items = await db.all(
          `SELECT * FROM job_checks WHERE job_id = $1 AND decision = 'approved' AND NOT added_to_job ORDER BY sort, id FOR UPDATE`,
          [job.id]
        );
        if (!items.length) return;
        let sort = (await db.get('SELECT COALESCE(MAX(sort), -1) AS n FROM line_items WHERE job_id = $1', [job.id])).n;
        for (const c of items) {
          await db.run(
            `INSERT INTO line_items (job_id, kind, description, qty, unit_cents, gst, sort) VALUES ($1, 'labour', $2, 1, $3, true, $4)`,
            [job.id, [c.item, c.note].filter(Boolean).join(': ').slice(0, 500), c.price_cents || 0, ++sort]
          );
          await db.run('UPDATE job_checks SET added_to_job = true WHERE id = $1', [c.id]);
        }
        await logEvent(db, job.id, req.user.id, 'approval', `Added ${items.length} approved item${items.length === 1 ? '' : 's'} to the job`);
      });
      res.redirect(`/jobs/${job.id}#approval`);
    });
  },
};
