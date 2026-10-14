const { now, today, addDays, isoDate } = require('../lib/util');
const { nextNumber } = require('../lib/db');
const { vehicleOptions, customerOptions, resolveParty } = require('../lib/records');

function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00');
  const offset = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - offset);
  return isoDate(d);
}

function bookingFrom(body, statuses) {
  const g = (k) => String(body[k] ?? '').trim();
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(g('date')) ? g('date') : today(),
    time: g('time'),
    duration_hours: Math.max(parseFloat(g('duration_hours')) || 1, 0.25),
    description: g('description'),
    status: statuses[g('status')] ? g('status') : 'booked',
  };
}

module.exports = function (app, { db, BOOKING_STATUSES }) {
  const BOOKING_SELECT = `
    SELECT b.*, c.name AS customer_name, c.phone AS customer_phone, v.rego, v.make, v.model
    FROM bookings b JOIN customers c ON c.id = b.customer_id
    LEFT JOIN vehicles v ON v.id = b.vehicle_id`;

  app.get('/bookings', (req, res) => {
    const start = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '') ? req.query.week : today());
    const end = addDays(start, 6);
    const rows = db
      .prepare(`${BOOKING_SELECT} WHERE b.date BETWEEN ? AND ? ORDER BY b.date, b.time = '', b.time`)
      .all(start, end);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, i);
      days.push({ date, bookings: rows.filter((b) => b.date === date) });
    }
    res.render('bookings/index', { days, start, prev: addDays(start, -7), next: addDays(start, 7) });
  });

  function renderForm(res, booking, error) {
    res.render('bookings/form', {
      booking,
      vehicles: vehicleOptions(db),
      customers: customerOptions(db),
      error,
    });
  }

  app.get('/bookings/new', (req, res) => {
    renderForm(
      res,
      {
        date: req.query.date || today(),
        time: '',
        duration_hours: 1,
        vehicle_id: Number(req.query.vehicle_id) || null,
        customer_id: Number(req.query.customer_id) || null,
        status: 'booked',
      },
      null
    );
  });

  app.post('/bookings', (req, res) => {
    const booking = bookingFrom(req.body, BOOKING_STATUSES);
    const party = resolveParty(db, req.body);
    if (!party) return renderForm(res.status(400), { ...booking, ...req.body }, 'Pick a vehicle or customer.');
    db.prepare(
      `INSERT INTO bookings (customer_id, vehicle_id, date, time, duration_hours, description, status, created_at)
       VALUES (@customer_id, @vehicle_id, @date, @time, @duration_hours, @description, @status, @created_at)`
    ).run({ ...booking, ...party, created_at: now() });
    res.redirect(`/bookings?week=${booking.date}`);
  });

  app.get('/bookings/:id/edit', (req, res, next) => {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!booking) return next();
    renderForm(res, booking, null);
  });

  app.post('/bookings/:id', (req, res, next) => {
    const existing = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!existing) return next();
    const booking = bookingFrom(req.body, BOOKING_STATUSES);
    const party = resolveParty(db, req.body);
    if (!party) return renderForm(res.status(400), { ...existing, ...req.body }, 'Pick a vehicle or customer.');
    db.prepare(
      `UPDATE bookings SET customer_id = @customer_id, vehicle_id = @vehicle_id, date = @date, time = @time,
         duration_hours = @duration_hours, description = @description, status = @status
       WHERE id = @id`
    ).run({ ...booking, ...party, id: existing.id });
    res.redirect(`/bookings?week=${booking.date}`);
  });

  app.post('/bookings/:id/delete', (req, res) => {
    const b = db.prepare('SELECT date FROM bookings WHERE id = ?').get(req.params.id);
    db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);
    res.redirect(`/bookings${b ? `?week=${b.date}` : ''}`);
  });

  // Car has arrived: open a job card from the booking.
  app.post('/bookings/:id/start', (req, res, next) => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!b) return next();
    if (b.job_id) return res.redirect(`/jobs/${b.job_id}`);
    const jobId = db.transaction(() => {
      const odo = b.vehicle_id ? db.prepare('SELECT odometer FROM vehicles WHERE id = ?').get(b.vehicle_id) : null;
      const id = db
        .prepare(
          `INSERT INTO jobs (number, customer_id, vehicle_id, status, description, odometer, created_at)
           VALUES (?, ?, ?, 'in_progress', ?, ?, ?)`
        )
        .run(nextNumber(db, 'job'), b.customer_id, b.vehicle_id, b.description, odo ? odo.odometer : null, now())
        .lastInsertRowid;
      db.prepare(`UPDATE bookings SET status = 'arrived', job_id = ? WHERE id = ?`).run(id, b.id);
      return id;
    })();
    res.redirect(`/jobs/${jobId}`);
  });
};
