const { now, parseIntOrNull } = require('../lib/util');
const { getCustomer, getVehicle } = require('../lib/records');
const { listDocs } = require('../lib/docs');

function customerFrom(body) {
  const g = (k) => String(body[k] ?? '').trim();
  return { name: g('name'), phone: g('phone'), email: g('email'), address: g('address'), notes: g('notes') };
}

function vehicleFrom(body, prefix = '') {
  const g = (k) => String(body[prefix + k] ?? '').trim();
  return {
    rego: g('rego').toUpperCase(),
    make: g('make'),
    model: g('model'),
    year: g('year'),
    vin: g('vin').toUpperCase(),
    colour: g('colour'),
    odometer: parseIntOrNull(body[prefix + 'odometer']),
    rego_due: g('rego_due') || null,
    next_service_date: g('next_service_date') || null,
    next_service_km: parseIntOrNull(body[prefix + 'next_service_km']),
    notes: g('notes'),
  };
}

function hasVehicle(v) {
  return Boolean(v.rego || v.make || v.model || v.vin);
}

module.exports = function (app, { db }) {
  const insertVehicle = db.prepare(
    `INSERT INTO vehicles (customer_id, rego, make, model, year, vin, colour, odometer, rego_due,
       next_service_date, next_service_km, notes, created_at)
     VALUES (@customer_id, @rego, @make, @model, @year, @vin, @colour, @odometer, @rego_due,
       @next_service_date, @next_service_km, @notes, @created_at)`
  );

  app.get('/customers', (req, res) => {
    const q = String(req.query.q || '').trim();
    const like = `%${q}%`;
    const customers = db
      .prepare(
        `SELECT c.*, GROUP_CONCAT(v.rego, ', ') AS regos FROM customers c
         LEFT JOIN vehicles v ON v.customer_id = c.id
         WHERE ? = '' OR c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR v.rego LIKE ?
         GROUP BY c.id ORDER BY c.name COLLATE NOCASE LIMIT 500`
      )
      .all(q, like, like, like, like);
    res.render('customers/index', { customers, q });
  });

  app.get('/customers/new', (req, res) => {
    res.render('customers/form', { customer: {}, withVehicle: true, error: null });
  });

  app.post('/customers', (req, res) => {
    const customer = customerFrom(req.body);
    const vehicle = vehicleFrom(req.body, 'v_');
    if (!customer.name) {
      return res.status(400).render('customers/form', { customer, withVehicle: true, error: 'Name is required.' });
    }
    const id = db.transaction(() => {
      const cid = db
        .prepare(
          `INSERT INTO customers (name, phone, email, address, notes, created_at)
           VALUES (@name, @phone, @email, @address, @notes, @created_at)`
        )
        .run({ ...customer, created_at: now() }).lastInsertRowid;
      if (hasVehicle(vehicle)) insertVehicle.run({ ...vehicle, customer_id: cid, created_at: now() });
      return cid;
    })();
    res.redirect(`/customers/${id}`);
  });

  app.get('/customers/:id', (req, res, next) => {
    const customer = getCustomer(db, req.params.id);
    if (!customer) return next();
    const vehicles = db.prepare('SELECT * FROM vehicles WHERE customer_id = ? ORDER BY rego').all(customer.id);
    const jobs = db
      .prepare(
        `SELECT j.*, v.rego FROM jobs j LEFT JOIN vehicles v ON v.id = j.vehicle_id
         WHERE j.customer_id = ? ORDER BY j.created_at DESC`
      )
      .all(customer.id);
    const docs = listDocs(db, 'd.customer_id = ?', [customer.id]);
    const owing = docs
      .filter((d) => d.type === 'invoice' && d.state !== 'void')
      .reduce((sum, d) => sum + Math.max(d.balance, 0), 0);
    const bookings = db
      .prepare(
        `SELECT b.*, v.rego FROM bookings b LEFT JOIN vehicles v ON v.id = b.vehicle_id
         WHERE b.customer_id = ? ORDER BY b.date DESC, b.time DESC LIMIT 20`
      )
      .all(customer.id);
    res.render('customers/show', { customer, vehicles, jobs, docs, owing, bookings });
  });

  app.get('/customers/:id/edit', (req, res, next) => {
    const customer = getCustomer(db, req.params.id);
    if (!customer) return next();
    res.render('customers/form', { customer, withVehicle: false, error: null });
  });

  app.post('/customers/:id', (req, res, next) => {
    const existing = getCustomer(db, req.params.id);
    if (!existing) return next();
    const customer = customerFrom(req.body);
    if (!customer.name) {
      return res
        .status(400)
        .render('customers/form', { customer: { ...customer, id: existing.id }, withVehicle: false, error: 'Name is required.' });
    }
    db.prepare(
      `UPDATE customers SET name = @name, phone = @phone, email = @email, address = @address, notes = @notes
       WHERE id = @id`
    ).run({ ...customer, id: existing.id });
    res.redirect(`/customers/${existing.id}`);
  });

  app.post('/customers/:id/delete', (req, res) => {
    // Invoices are tax records, so a customer who has any is kept.
    const invoices = db
      .prepare(`SELECT COUNT(*) AS n FROM documents WHERE customer_id = ? AND type = 'invoice'`)
      .get(req.params.id).n;
    if (invoices > 0) {
      return res.status(400).render('message', {
        title: 'Customer kept',
        message: 'This customer has invoices, so they can’t be deleted. Edit their details instead.',
      });
    }
    db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
    res.redirect('/customers');
  });

  app.get('/customers/:id/vehicles/new', (req, res, next) => {
    const customer = getCustomer(db, req.params.id);
    if (!customer) return next();
    res.render('vehicles/form', { vehicle: { customer_id: customer.id }, customer, error: null });
  });

  app.post('/customers/:id/vehicles', (req, res, next) => {
    const customer = getCustomer(db, req.params.id);
    if (!customer) return next();
    const vehicle = vehicleFrom(req.body);
    if (!hasVehicle(vehicle)) {
      return res
        .status(400)
        .render('vehicles/form', { vehicle, customer, error: 'Enter at least a rego, make or model.' });
    }
    const id = insertVehicle.run({ ...vehicle, customer_id: customer.id, created_at: now() }).lastInsertRowid;
    res.redirect(`/vehicles/${id}`);
  });

  app.get('/vehicles/:id', (req, res, next) => {
    const vehicle = getVehicle(db, req.params.id);
    if (!vehicle) return next();
    const customer = getCustomer(db, vehicle.customer_id);
    const jobs = db.prepare('SELECT * FROM jobs WHERE vehicle_id = ? ORDER BY created_at DESC').all(vehicle.id);
    const docs = listDocs(db, 'd.vehicle_id = ?', [vehicle.id]);
    // Service history: what was done on each invoice, newest first.
    const lines = db.prepare('SELECT * FROM line_items WHERE document_id = ? ORDER BY sort, id');
    const history = docs
      .filter((d) => d.type === 'invoice' && d.state !== 'void')
      .map((d) => ({ doc: d, lines: lines.all(d.id) }));
    res.render('vehicles/show', { vehicle, customer, jobs, docs, history });
  });

  app.get('/vehicles/:id/edit', (req, res, next) => {
    const vehicle = getVehicle(db, req.params.id);
    if (!vehicle) return next();
    res.render('vehicles/form', { vehicle, customer: getCustomer(db, vehicle.customer_id), error: null });
  });

  app.post('/vehicles/:id', (req, res, next) => {
    const existing = getVehicle(db, req.params.id);
    if (!existing) return next();
    const vehicle = vehicleFrom(req.body);
    db.prepare(
      `UPDATE vehicles SET rego = @rego, make = @make, model = @model, year = @year, vin = @vin, colour = @colour,
         odometer = @odometer, rego_due = @rego_due, next_service_date = @next_service_date,
         next_service_km = @next_service_km, notes = @notes
       WHERE id = @id`
    ).run({ ...vehicle, id: existing.id });
    res.redirect(`/vehicles/${existing.id}`);
  });

  app.post('/vehicles/:id/delete', (req, res, next) => {
    const vehicle = getVehicle(db, req.params.id);
    if (!vehicle) return next();
    db.prepare('DELETE FROM vehicles WHERE id = ?').run(vehicle.id);
    res.redirect(`/customers/${vehicle.customer_id}`);
  });
};
