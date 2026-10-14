const { now, parseIntOrNull } = require('../lib/util');
const { getCustomer, getVehicle } = require('../lib/records');
const { listDocs } = require('../lib/docs');

const clip = (s, n = 500) => String(s ?? '').trim().slice(0, n);

function customerFrom(body) {
  return {
    name: clip(body.name, 200),
    phone: clip(body.phone, 50),
    email: clip(body.email, 200),
    address: clip(body.address),
    notes: clip(body.notes, 5000),
  };
}

function vehicleFrom(body, prefix = '') {
  const g = (k, n) => clip(body[prefix + k], n);
  const date = (k) => (/^\d{4}-\d{2}-\d{2}$/.test(g(k)) ? g(k) : null);
  return {
    rego: g('rego', 20).toUpperCase(),
    make: g('make', 60),
    model: g('model', 60),
    year: g('year', 10),
    vin: g('vin', 40).toUpperCase(),
    colour: g('colour', 40),
    odometer: parseIntOrNull(body[prefix + 'odometer']),
    rego_due: date('rego_due'),
    next_service_date: date('next_service_date'),
    next_service_km: parseIntOrNull(body[prefix + 'next_service_km']),
    notes: g('notes', 5000),
  };
}

function hasVehicle(v) {
  return Boolean(v.rego || v.make || v.model || v.vin);
}

const VEHICLE_COLS = ['rego', 'make', 'model', 'year', 'vin', 'colour', 'odometer', 'rego_due', 'next_service_date', 'next_service_km', 'notes'];

function insertVehicle(db, customerId, v, tz) {
  return db.get(
    `INSERT INTO vehicles (customer_id, ${VEHICLE_COLS.join(', ')}, created_at)
     VALUES ($1, ${VEHICLE_COLS.map((_, i) => `$${i + 2}`).join(', ')}, $${VEHICLE_COLS.length + 2}) RETURNING id`,
    [customerId, ...VEHICLE_COLS.map((c) => v[c]), now(tz)]
  );
}

module.exports = function (app, { xero }) {
  app.get('/customers', async (req, res) => {
    const q = clip(req.query.q, 100);
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const customers = await req.db.all(
      `SELECT c.*, string_agg(v.rego, ', ') AS regos FROM customers c
       LEFT JOIN vehicles v ON v.customer_id = c.id
       WHERE $1 = '' OR c.name ILIKE $2 OR c.phone ILIKE $2 OR c.email ILIKE $2 OR v.rego ILIKE $2
       GROUP BY c.id ORDER BY lower(c.name) LIMIT 500`,
      [q, like]
    );
    res.render('customers/index', { customers, q });
  });

  app.get('/customers/new', (req, res) => {
    res.render('customers/form', { customer: {}, withVehicle: true, error: null });
  });

  app.post('/customers', async (req, res) => {
    const customer = customerFrom(req.body);
    const vehicle = vehicleFrom(req.body, 'v_');
    if (!customer.name) {
      return res.status(400).render('customers/form', { customer, withVehicle: true, error: 'Name is required.' });
    }
    const id = await req.db.tx(async (db) => {
      const c = await db.get(
        `INSERT INTO customers (name, phone, email, address, notes, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [customer.name, customer.phone, customer.email, customer.address, customer.notes, now(req.tz)]
      );
      if (hasVehicle(vehicle)) await insertVehicle(db, c.id, vehicle, req.tz);
      return c.id;
    });
    res.redirect(`/customers/${id}`);
  });

  app.get('/customers/:id', async (req, res, next) => {
    const customer = await getCustomer(req.db, req.params.id);
    if (!customer) return next();
    const [vehicles, jobs, docs, bookings] = await Promise.all([
      req.db.all('SELECT * FROM vehicles WHERE customer_id = $1 ORDER BY rego', [customer.id]),
      req.db.all(
        `SELECT j.*, v.rego FROM jobs j LEFT JOIN vehicles v ON v.id = j.vehicle_id
         WHERE j.customer_id = $1 ORDER BY j.created_at DESC`,
        [customer.id]
      ),
      listDocs(req.db, res.locals.today, 'd.customer_id = $1', [customer.id]),
      req.db.all(
        `SELECT b.*, v.rego FROM bookings b LEFT JOIN vehicles v ON v.id = b.vehicle_id
         WHERE b.customer_id = $1 ORDER BY b.date DESC, b.time DESC LIMIT 20`,
        [customer.id]
      ),
    ]);
    const owing = docs
      .filter((d) => d.type === 'invoice' && d.state !== 'void')
      .reduce((sum, d) => sum + Math.max(d.balance, 0), 0);
    res.render('customers/show', { customer, vehicles, jobs, docs, owing, bookings });
  });

  // Printable statement of unpaid invoices (or everything in a period).
  app.get('/customers/:id/statement', async (req, res, next) => {
    const customer = await getCustomer(req.db, req.params.id);
    if (!customer) return next();
    const all = req.query.show === 'all';
    const docs = (await listDocs(req.db, res.locals.today, `d.customer_id = $1 AND d.type = 'invoice' AND d.status != 'void'`, [customer.id], 'ORDER BY d.issue_date, d.number'))
      .filter((d) => all || d.balance > 0);
    res.render('customers/statement', { customer, docs, all, owing: docs.reduce((s, d) => s + Math.max(d.balance, 0), 0) });
  });

  app.get('/customers/:id/edit', async (req, res, next) => {
    const customer = await getCustomer(req.db, req.params.id);
    if (!customer) return next();
    res.render('customers/form', { customer, withVehicle: false, error: null });
  });

  app.post('/customers/:id', async (req, res, next) => {
    const existing = await getCustomer(req.db, req.params.id);
    if (!existing) return next();
    const customer = customerFrom(req.body);
    if (!customer.name) {
      return res
        .status(400)
        .render('customers/form', { customer: { ...customer, id: existing.id }, withVehicle: false, error: 'Name is required.' });
    }
    await req.db.run(
      `UPDATE customers SET name = $1, phone = $2, email = $3, address = $4, notes = $5 WHERE id = $6`,
      [customer.name, customer.phone, customer.email, customer.address, customer.notes, existing.id]
    );
    await xero.queueContact(req.db, existing.id);
    res.redirect(`/customers/${existing.id}`);
  });

  app.post('/customers/:id/delete', async (req, res, next) => {
    const customer = await getCustomer(req.db, req.params.id);
    if (!customer) return next();
    // Invoices are tax records, so a customer who has any is kept.
    const invoices = await req.db.get(`SELECT COUNT(*) AS n FROM documents WHERE customer_id = $1 AND type = 'invoice'`, [customer.id]);
    if (invoices.n > 0) {
      return res.status(400).render('message', {
        title: 'Customer kept',
        message: 'This customer has invoices, so they can’t be deleted. Edit their details instead.',
      });
    }
    await req.db.run('DELETE FROM customers WHERE id = $1', [customer.id]);
    res.redirect('/customers');
  });

  app.get('/customers/:id/vehicles/new', async (req, res, next) => {
    const customer = await getCustomer(req.db, req.params.id);
    if (!customer) return next();
    res.render('vehicles/form', { vehicle: { customer_id: customer.id }, customer, error: null });
  });

  app.post('/customers/:id/vehicles', async (req, res, next) => {
    const customer = await getCustomer(req.db, req.params.id);
    if (!customer) return next();
    const vehicle = vehicleFrom(req.body);
    if (!hasVehicle(vehicle)) {
      return res.status(400).render('vehicles/form', { vehicle, customer, error: 'Enter at least a rego, make or model.' });
    }
    const v = await insertVehicle(req.db, customer.id, vehicle, req.tz);
    res.redirect(`/vehicles/${v.id}`);
  });

  app.get('/vehicles/:id', async (req, res, next) => {
    const vehicle = await getVehicle(req.db, req.params.id);
    if (!vehicle) return next();
    const [customer, jobs, docs] = await Promise.all([
      getCustomer(req.db, vehicle.customer_id),
      req.db.all('SELECT * FROM jobs WHERE vehicle_id = $1 ORDER BY created_at DESC', [vehicle.id]),
      listDocs(req.db, res.locals.today, 'd.vehicle_id = $1', [vehicle.id]),
    ]);
    // Service history: what was done on each invoice, newest first.
    const invoiced = docs.filter((d) => d.type === 'invoice' && d.state !== 'void');
    const lines = invoiced.length
      ? await req.db.all('SELECT * FROM line_items WHERE document_id = ANY($1) ORDER BY sort, id', [invoiced.map((d) => d.id)])
      : [];
    const history = invoiced.map((d) => ({ doc: d, lines: lines.filter((l) => l.document_id === d.id) }));
    res.render('vehicles/show', { vehicle, customer, jobs, docs, history });
  });

  app.get('/vehicles/:id/edit', async (req, res, next) => {
    const vehicle = await getVehicle(req.db, req.params.id);
    if (!vehicle) return next();
    res.render('vehicles/form', { vehicle, customer: await getCustomer(req.db, vehicle.customer_id), error: null });
  });

  app.post('/vehicles/:id', async (req, res, next) => {
    const existing = await getVehicle(req.db, req.params.id);
    if (!existing) return next();
    const v = vehicleFrom(req.body);
    await req.db.run(
      `UPDATE vehicles SET ${VEHICLE_COLS.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${VEHICLE_COLS.length + 1}`,
      [...VEHICLE_COLS.map((c) => v[c]), existing.id]
    );
    res.redirect(`/vehicles/${existing.id}`);
  });

  app.post('/vehicles/:id/delete', async (req, res, next) => {
    const vehicle = await getVehicle(req.db, req.params.id);
    if (!vehicle) return next();
    await req.db.run('DELETE FROM vehicles WHERE id = $1', [vehicle.id]);
    res.redirect(`/customers/${vehicle.customer_id}`);
  });
};
