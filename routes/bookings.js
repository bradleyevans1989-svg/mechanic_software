const { now, addDays, mondayOf } = require('../lib/util');
const { nextNumber } = require('../lib/db');
const { vehicleOptions, customerOptions, resolveParty, logEvent } = require('../lib/records');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bookingFrom(body, statuses, today) {
  const g = (k) => String(body[k] ?? '').trim();
  return {
    date: DATE_RE.test(g('date')) ? g('date') : today,
    time: /^\d{2}:\d{2}$/.test(g('time')) ? g('time') : '',
    duration_hours: Math.min(Math.max(parseFloat(g('duration_hours')) || 1, 0.25), 24),
    description: g('description').slice(0, 2000),
    status: statuses[g('status')] ? g('status') : 'booked',
  };
}

const BOOKING_SELECT = `
  SELECT b.*, c.name AS customer_name, c.phone AS customer_phone, v.rego, v.make, v.model
  FROM bookings b JOIN customers c ON c.id = b.customer_id
  LEFT JOIN vehicles v ON v.id = b.vehicle_id`;

module.exports = function (app, { BOOKING_STATUSES }) {
  app.get('/bookings', async (req, res) => {
    const start = mondayOf(DATE_RE.test(req.query.week || '') ? req.query.week : res.locals.today);
    const end = addDays(start, 6);
    const rows = await req.db.all(`${BOOKING_SELECT} WHERE b.date BETWEEN $1 AND $2 ORDER BY b.date, b.time = '', b.time`, [start, end]);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, i);
      days.push({ date, bookings: rows.filter((b) => b.date === date) });
    }
    const requests = (await req.db.get(`SELECT COUNT(*)::int AS n FROM booking_requests WHERE status = 'pending'`)).n;
    res.render('bookings/index', { days, start, prev: addDays(start, -7), next: addDays(start, 7), requests });
  });

  async function renderForm(req, res, booking, error) {
    const [vehicles, customers] = await Promise.all([vehicleOptions(req.db), customerOptions(req.db)]);
    res.render('bookings/form', { booking, vehicles, customers, error });
  }

  app.get('/bookings/new', (req, res) =>
    renderForm(
      req,
      res,
      {
        date: DATE_RE.test(req.query.date || '') ? req.query.date : res.locals.today,
        time: '',
        duration_hours: 1,
        vehicle_id: Number(req.query.vehicle_id) || null,
        customer_id: Number(req.query.customer_id) || null,
        status: 'booked',
      },
      null
    )
  );

  app.post('/bookings', async (req, res) => {
    const booking = bookingFrom(req.body, BOOKING_STATUSES, res.locals.today);
    const party = await resolveParty(req.db, req.body);
    if (!party) return renderForm(req, res.status(400), { ...booking, ...req.body }, 'Pick a vehicle or customer.');
    await req.db.run(
      `INSERT INTO bookings (customer_id, vehicle_id, date, time, duration_hours, description, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [party.customer_id, party.vehicle_id, booking.date, booking.time, booking.duration_hours, booking.description, booking.status, now(req.tz)]
    );
    res.redirect(`/bookings?week=${booking.date}`);
  });

  app.get('/bookings/:id/edit', async (req, res, next) => {
    const booking = await req.db.get('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
    if (!booking) return next();
    renderForm(req, res, booking, null);
  });

  app.post('/bookings/:id', async (req, res, next) => {
    const existing = await req.db.get('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
    if (!existing) return next();
    const booking = bookingFrom(req.body, BOOKING_STATUSES, res.locals.today);
    const party = await resolveParty(req.db, req.body);
    if (!party) return renderForm(req, res.status(400), { ...existing, ...req.body }, 'Pick a vehicle or customer.');
    await req.db.run(
      `UPDATE bookings SET customer_id = $1, vehicle_id = $2, date = $3, time = $4, duration_hours = $5,
         description = $6, status = $7 WHERE id = $8`,
      [party.customer_id, party.vehicle_id, booking.date, booking.time, booking.duration_hours, booking.description, booking.status, existing.id]
    );
    res.redirect(`/bookings?week=${booking.date}`);
  });

  app.post('/bookings/:id/delete', async (req, res) => {
    const b = await req.db.get('DELETE FROM bookings WHERE id = $1 RETURNING date', [req.params.id]);
    res.redirect(`/bookings${b ? `?week=${b.date}` : ''}`);
  });

  // Car has arrived: open a job card from the booking.
  app.post('/bookings/:id/start', async (req, res, next) => {
    const jobId = await req.db.tx(async (db) => {
      const b = await db.get('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!b) return null;
      if (b.job_id) return b.job_id;
      const v = b.vehicle_id ? await db.get('SELECT odometer FROM vehicles WHERE id = $1', [b.vehicle_id]) : null;
      const job = await db.get(
        `INSERT INTO jobs (number, customer_id, vehicle_id, status, description, odometer, created_at, due_date, is_service)
         VALUES ($1, $2, $3, 'in_progress', $4, $5, $6, $7, $8) RETURNING id`,
        [await nextNumber(db, 'job'), b.customer_id, b.vehicle_id, b.description, v ? v.odometer : null, now(req.tz), b.date, /service/i.test(b.description)]
      );
      await db.run(`UPDATE bookings SET status = 'arrived', job_id = $1 WHERE id = $2`, [job.id, b.id]);
      await logEvent(db, job.id, req.user.id, 'created', `Job opened from the booking for ${b.date}`);
      return job.id;
    });
    if (!jobId) return next();
    res.redirect(`/jobs/${jobId}`);
  });
};
