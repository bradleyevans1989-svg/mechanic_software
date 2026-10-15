const { addDays, parseIntOrNull, vehicleLabel, fmtDate } = require('../lib/util');

const METHODS = { phone: 'Phoned', sms: 'Texted', email: 'Emailed', letter: 'Posted' };

module.exports = function (app) {
  // Vehicles whose service or rego falls due soon, with the last reminder sent for each.
  app.get('/reminders', async (req, res) => {
    const today = res.locals.today;
    const ahead = [14, 30, 60, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const kind = ['service', 'rego'].includes(req.query.kind) ? req.query.kind : 'all';
    const until = addDays(today, ahead);
    const rows = await req.db.all(
      `SELECT v.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
         (SELECT MAX(at) FROM reminder_log r WHERE r.vehicle_id = v.id AND r.kind = 'service') AS service_reminded,
         (SELECT MAX(at) FROM reminder_log r WHERE r.vehicle_id = v.id AND r.kind = 'rego') AS rego_reminded
       FROM vehicles v JOIN customers c ON c.id = v.customer_id
       WHERE c.archived_at IS NULL AND (($2::text IN ('all', 'service') AND v.next_service_date IS NOT NULL AND v.next_service_date <= $1)
          OR ($2::text IN ('all', 'rego') AND v.rego_due IS NOT NULL AND v.rego_due <= $1))
       ORDER BY LEAST(COALESCE(v.next_service_date, '9999'), COALESCE(v.rego_due, '9999')), lower(c.name)`,
      [until, kind]
    );
    const items = [];
    for (const v of rows) {
      const push = (k, date, reminded) => {
        if (!date || date > until) return;
        if (kind !== 'all' && kind !== k) return;
        // A reminder sent in the three months leading up to this due date counts as done.
        const done = Boolean(reminded && new Date(reminded) >= new Date(addDays(date, -90)));
        items.push({ vehicle: v, kind: k, date, overdue: date < today, reminded, done });
      };
      push('service', v.next_service_date, v.service_reminded);
      push('rego', v.rego_due, v.rego_reminded);
    }
    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const settings = await req.db.get('SELECT business_name, phone FROM settings');
    // A ready-made message the staff member can paste into an email or text.
    const message = (it) =>
      `Hi ${it.vehicle.customer_name.split(' ')[0]}, your ${vehicleLabel(it.vehicle)} is due for ${
        it.kind === 'rego' ? 'rego' : 'a service'
      } on ${fmtDate(it.date)}. Give ${settings.business_name} a call on ${settings.phone || 'the workshop'} to book it in. Thanks!`;
    res.render('reminders', { items, ahead, kind, message, METHODS, done: req.query.done === '1' });
  });

  app.post('/reminders/:id', async (req, res, next) => {
    const vehicle = await req.db.get('SELECT id FROM vehicles WHERE id = $1', [parseIntOrNull(req.params.id)]);
    if (!vehicle) return next();
    const kind = req.body.kind === 'rego' ? 'rego' : 'service';
    await req.db.run('INSERT INTO reminder_log (vehicle_id, user_id, kind, method, note) VALUES ($1, $2, $3, $4, $5)', [
      vehicle.id,
      req.user.id,
      kind,
      METHODS[req.body.method] ? req.body.method : 'phone',
      String(req.body.note || '').trim().slice(0, 500),
    ]);
    res.redirect(`/reminders?${new URLSearchParams({ days: req.body.days || '30', kind: req.body.filter || 'all', done: '1' })}`);
  });
};
