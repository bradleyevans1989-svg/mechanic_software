const { now, parseIntOrNull, minutesBetween } = require('../lib/util');
const { logEvent, CHECK_RESULTS } = require('../lib/records');
const { clockState, nextShift } = require('./clocking');

// The statuses a technician can move a job between from the floor.
const FLOOR_STATUSES = ['in_progress', 'waiting_parts', 'ready'];
const MAX_PHOTO = 5 * 1024 * 1024;

const isTech = (req) => req.user.role === 'tech';

// Where a job lives for this person: technicians get the floor view, everyone else the full job card.
const jobPage = (req, id) => (isTech(req) ? `/my-jobs/${id}` : `/jobs/${id}`);

// A job this person may work on. Technicians only see jobs still in the workshop.
async function workableJob(req, id) {
  const job = await req.db.get('SELECT * FROM jobs WHERE id = $1', [id]);
  if (!job) return null;
  if (isTech(req) && (job.status === 'invoiced' || job.status === 'cancelled')) return null;
  return job;
}

module.exports = function (app, { store, JOB_STATUSES }) {
  // Everything assigned to me that's still in the workshop, today's first, plus what else is on the floor.
  app.get('/my-jobs', async (req, res) => {
    const t = res.locals.today;
    const [jobs, clock, shift] = await Promise.all([
      req.db.all(
        `SELECT j.id, j.number, j.status, j.description, j.priority, j.due_date, j.due_time, j.mechanic_id,
           v.rego, v.make, v.model, v.year, c.name AS customer_name, m.name AS mechanic_name,
           (SELECT COUNT(*) FROM job_tasks k WHERE k.job_id = j.id) AS tasks,
           (SELECT COUNT(*) FROM job_tasks k WHERE k.job_id = j.id AND k.done_at IS NOT NULL) AS tasks_done,
           EXISTS (SELECT 1 FROM time_entries e WHERE e.job_id = j.id AND e.user_id = $1 AND e.ended_at IS NULL) AS on_clock
         FROM jobs j JOIN customers c ON c.id = j.customer_id
         LEFT JOIN vehicles v ON v.id = j.vehicle_id
         LEFT JOIN users m ON m.id = j.mechanic_id
         WHERE j.status NOT IN ('invoiced', 'cancelled')
         ORDER BY j.priority = 'urgent' DESC, j.due_date NULLS LAST, j.due_time, j.created_at`,
        [req.user.id]
      ),
      clockState(req.db, req.user.id),
      nextShift(req.db, req.user.id, t, res.locals.timeNow),
    ]);
    const mine = jobs.filter((j) => j.mechanic_id === req.user.id);
    res.render('myjobs/index', {
      todayJobs: mine.filter((j) => !j.due_date || j.due_date <= t),
      upcoming: mine.filter((j) => j.due_date && j.due_date > t),
      others: jobs.filter((j) => j.mechanic_id !== req.user.id).sort((a, b) => (a.mechanic_id ? 1 : 0) - (b.mechanic_id ? 1 : 0)),
      onJob: jobs.find((j) => j.on_clock) || null,
      ...clock,
      shift,
    });
  });

  app.get('/my-jobs/:id', async (req, res, next) => {
    const job = await workableJob(req, req.params.id);
    if (!job) return next();
    const [detail, tasks, checks, photos, events, time, procedures] = await Promise.all([
      req.db.get(
        `SELECT c.name AS customer_name, v.rego, v.make, v.model, v.year, v.vin, v.odometer AS vehicle_odometer, m.name AS mechanic_name
         FROM jobs j JOIN customers c ON c.id = j.customer_id LEFT JOIN vehicles v ON v.id = j.vehicle_id
         LEFT JOIN users m ON m.id = j.mechanic_id WHERE j.id = $1`,
        [job.id]
      ),
      req.db.all(
        `SELECT t.*, p.title AS procedure_title, u.name AS done_by_name FROM job_tasks t
         LEFT JOIN procedures p ON p.id = t.procedure_id LEFT JOIN users u ON u.id = t.done_by
         WHERE t.job_id = $1 ORDER BY t.sort, t.id`,
        [job.id]
      ),
      req.db.all('SELECT * FROM job_checks WHERE job_id = $1 ORDER BY sort, id', [job.id]),
      req.db.all(
        `SELECT p.id, p.caption, p.created_at, p.user_id, u.name AS user_name FROM job_photos p
         LEFT JOIN users u ON u.id = p.user_id WHERE p.job_id = $1 ORDER BY p.created_at, p.id`,
        [job.id]
      ),
      req.db.all(
        `SELECT e.*, u.name AS user_name FROM job_events e LEFT JOIN users u ON u.id = e.user_id
         WHERE e.job_id = $1 AND e.kind IN ('note', 'status', 'mechanic', 'task', 'photo', 'clock') ORDER BY e.at DESC, e.id DESC LIMIT 30`,
        [job.id]
      ),
      req.db.all('SELECT * FROM time_entries WHERE job_id = $1 AND user_id = $2', [job.id, req.user.id]),
      req.db.all('SELECT id, title FROM procedures ORDER BY lower(title)'),
    ]);
    res.render('myjobs/show', {
      job: { ...job, ...detail },
      tasks,
      checks,
      photos,
      events,
      procedures,
      CHECK_RESULTS,
      FLOOR_STATUSES,
      myOpenEntry: time.find((e) => !e.ended_at) || null,
      myMinutes: time.reduce((s, e) => s + minutesBetween(e.started_at, e.ended_at), 0),
      saved: req.query.saved === '1',
    });
  });

  // What a technician can change from the floor: status (within reason), their notes and the inspection.
  app.post('/jobs/:id/progress', async (req, res, next) => {
    const job = await workableJob(req, req.params.id);
    if (!job) return next();
    const asked = String(req.body.status || '');
    const status = FLOOR_STATUSES.includes(asked) || asked === job.status ? asked : job.status;
    await req.db.tx(async (db) => {
      await db.run(
        `UPDATE jobs SET status = $1, tech_notes = $2,
           completed_at = CASE WHEN $1 IN ('ready', 'invoiced') THEN COALESCE(completed_at, $3) ELSE NULL END
         WHERE id = $4`,
        [status, String(req.body.tech_notes ?? job.tech_notes).trim().slice(0, 10000), now(req.tz), job.id]
      );
      const checks = req.body.checks && typeof req.body.checks === 'object' ? req.body.checks : {};
      for (const [key, c] of Object.entries(checks)) {
        if (!/^c\d{1,9}$/.test(key) || !c || typeof c !== 'object') continue;
        await db.run('UPDATE job_checks SET result = $1, note = $2 WHERE id = $3 AND job_id = $4', [
          CHECK_RESULTS[c.result] ? c.result : '',
          String(c.note || '').trim().slice(0, 500),
          Number(key.slice(1)),
          job.id,
        ]);
      }
      if (status !== job.status) await logEvent(db, job.id, req.user.id, 'status', `Status changed to ${JOB_STATUSES[status]}`);
    });
    res.redirect(`${jobPage(req, job.id)}?saved=1`);
  });

  // Pick up a job nobody has been given yet.
  app.post('/jobs/:id/take', async (req, res, next) => {
    const job = await workableJob(req, req.params.id);
    if (!job) return next();
    if (!job.mechanic_id) {
      await req.db.tx(async (db) => {
        await db.run('UPDATE jobs SET mechanic_id = $1 WHERE id = $2 AND mechanic_id IS NULL', [req.user.id, job.id]);
        await logEvent(db, job.id, req.user.id, 'mechanic', `Assigned to ${req.user.name}`);
      });
    }
    res.redirect(jobPage(req, job.id));
  });

  // Tasks: a to-do list on the job, each optionally pointing at a procedure.
  app.post('/jobs/:id/tasks', async (req, res, next) => {
    const job = await workableJob(req, req.params.id);
    if (!job) return next();
    const text = String(req.body.text || '').trim().slice(0, 300);
    const procId = parseIntOrNull(req.body.procedure_id);
    const proc = procId ? await req.db.get('SELECT id FROM procedures WHERE id = $1', [procId]) : null;
    if (text) {
      await req.db.run(
        `INSERT INTO job_tasks (job_id, text, procedure_id, sort)
         VALUES ($1, $2, $3, (SELECT COALESCE(MAX(sort), 0) + 1 FROM job_tasks WHERE job_id = $1))`,
        [job.id, text, proc ? proc.id : null]
      );
    }
    res.redirect(`${jobPage(req, job.id)}#tasks`);
  });

  app.post('/jobs/:id/tasks/:pid/toggle', async (req, res, next) => {
    const job = await workableJob(req, req.params.id);
    if (!job) return next();
    await req.db.tx(async (db) => {
      const task = await db.get(
        `UPDATE job_tasks SET done_at = CASE WHEN done_at IS NULL THEN now() END, done_by = CASE WHEN done_at IS NULL THEN $3::integer END
         WHERE id = $1 AND job_id = $2 RETURNING text, done_at`,
        [req.params.pid, job.id, req.user.id]
      );
      if (task) await logEvent(db, job.id, req.user.id, 'task', `${task.done_at ? 'Done' : 'Not done'}: ${task.text}`);
    });
    res.redirect(`${jobPage(req, job.id)}#tasks`);
  });

  app.post('/jobs/:id/tasks/:pid/delete', async (req, res, next) => {
    const job = await workableJob(req, req.params.id);
    if (!job) return next();
    // Technicians tick tasks off; the office decides what's on the list.
    if (!isTech(req)) await req.db.run('DELETE FROM job_tasks WHERE id = $1 AND job_id = $2', [req.params.pid, job.id]);
    res.redirect(`${jobPage(req, job.id)}#tasks`);
  });

  // Photos: shrunk in the browser to a JPEG and sent as a data URL (app.js lets these bodies be bigger),
  // kept in the database like the logo.
  app.post('/jobs/:id/photos', async (req, res, next) => {
    const job = await workableJob(req, req.params.id);
    if (!job) return next();
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.photo_data || ''));
    const data = m ? Buffer.from(m[2], 'base64') : null;
    if (data && data.length && data.length <= MAX_PHOTO) {
      const caption = String(req.body.caption || '').trim().slice(0, 200);
      await req.db.tx(async (db) => {
        await db.run('INSERT INTO job_photos (job_id, user_id, data, content_type, caption) VALUES ($1, $2, $3, $4, $5)', [
          job.id,
          req.user.id,
          data,
          `image/${m[1]}`,
          caption,
        ]);
        await logEvent(db, job.id, req.user.id, 'photo', caption ? `Photo: ${caption}` : 'Photo added');
      });
    }
    res.redirect(`${jobPage(req, job.id)}#photos`);
  });

  app.get('/jobs/:id/photos/:pid', async (req, res, next) => {
    const job = await workableJob(req, req.params.id);
    if (!job) return next();
    const photo = await req.db.get('SELECT data, content_type FROM job_photos WHERE id = $1 AND job_id = $2', [req.params.pid, job.id]);
    if (!photo) return next();
    res.set('Cache-Control', 'private, max-age=86400');
    res.type(photo.content_type).send(photo.data);
  });

  app.post('/jobs/:id/photos/:pid/delete', async (req, res, next) => {
    const job = await workableJob(req, req.params.id);
    if (!job) return next();
    // Technicians can only take back their own photos.
    const own = isTech(req) ? ' AND user_id = $3' : '';
    await req.db.run(`DELETE FROM job_photos WHERE id = $1 AND job_id = $2${own}`, isTech(req) ? [req.params.pid, job.id, req.user.id] : [req.params.pid, job.id]);
    res.redirect(`${jobPage(req, job.id)}#photos`);
  });
};

module.exports.jobPage = jobPage;
module.exports.FLOOR_STATUSES = FLOOR_STATUSES;
