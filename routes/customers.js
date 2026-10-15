const { now, addDays, parseIntOrNull, csvCell, dollars } = require('../lib/util');
const { getCustomer, getVehicle, customerOptions } = require('../lib/records');
const { listDocs } = require('../lib/docs');

const clip = (s, n = 500) => String(s ?? '').trim().slice(0, n);

function customerFrom(body) {
  return {
    name: clip(body.name, 200),
    phone: clip(body.phone, 50),
    email: clip(body.email, 200),
    address: clip(body.address),
    notes: clip(body.notes, 5000),
    kind: body.kind === 'company' ? 'company' : 'individual',
    tags: tagList(body.tags).join(', '),
  };
}

// "fleet, VIP" -> ['fleet', 'VIP']; dedupes case-insensitively, keeps the first spelling.
function tagList(text) {
  const seen = new Set();
  const out = [];
  for (const t of String(text || '').split(/[,\n]/)) {
    const tag = t.trim().slice(0, 40);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out.slice(0, 20);
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
    service_interval_months: Math.min(Math.max(parseIntOrNull(body[prefix + 'service_interval_months']) ?? 0, 0), 120),
    service_interval_km: Math.min(Math.max(parseIntOrNull(body[prefix + 'service_interval_km']) ?? 0, 0), 500000),
    notes: g('notes', 5000),
  };
}

function hasVehicle(v) {
  return Boolean(v.rego || v.make || v.model || v.vin);
}

const VEHICLE_COLS = ['rego', 'make', 'model', 'year', 'vin', 'colour', 'odometer', 'rego_due', 'next_service_date', 'next_service_km', 'service_interval_months', 'service_interval_km', 'notes'];

async function insertVehicle(db, customerId, v, tz) {
  const at = now(tz);
  const row = await db.get(
    `INSERT INTO vehicles (customer_id, ${VEHICLE_COLS.join(', ')}, created_at)
     VALUES ($1, ${VEHICLE_COLS.map((_, i) => `$${i + 2}`).join(', ')}, $${VEHICLE_COLS.length + 2}) RETURNING id`,
    [customerId, ...VEHICLE_COLS.map((c) => v[c]), at]
  );
  await db.run('INSERT INTO vehicle_owners (vehicle_id, customer_id, from_at) VALUES ($1, $2, $3)', [row.id, customerId, at]);
  return row;
}

const CUSTOMER_SORTS = {
  name: { label: 'Name A to Z', fn: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) },
  newest: { label: 'Newest first', fn: (a, b) => String(b.created_at).localeCompare(String(a.created_at)) },
  owing: { label: 'Owing, highest first', fn: (a, b) => b.owing - a.owing },
  visit: { label: 'Last visit, latest first', fn: (a, b) => String(b.last_visit || '').localeCompare(String(a.last_visit || '')) },
};

const VEHICLE_SORTS = {
  rego: { label: 'Rego A to Z', fn: (a, b) => a.rego.localeCompare(b.rego) || a.customer_name.localeCompare(b.customer_name) },
  make: { label: 'Make and model', fn: (a, b) => (a.make + a.model).localeCompare(b.make + b.model, undefined, { sensitivity: 'base' }) },
  owner: { label: 'Owner A to Z', fn: (a, b) => a.customer_name.localeCompare(b.customer_name, undefined, { sensitivity: 'base' }) },
  newest: { label: 'Newest first', fn: (a, b) => String(b.created_at).localeCompare(String(a.created_at)) },
  rego_due: { label: 'Rego due, soonest first', fn: (a, b) => String(a.rego_due || '9').localeCompare(String(b.rego_due || '9')) },
  service: { label: 'Service due, soonest first', fn: (a, b) => String(a.next_service_date || '9').localeCompare(String(b.next_service_date || '9')) },
  visit: { label: 'Last visit, latest first', fn: (a, b) => String(b.last_visit || '').localeCompare(String(a.last_visit || '')) },
};

const compact = (s) => String(s || '').toLowerCase().replace(/[\s.-]+/g, '');
const matches = (q, ...fields) => fields.some((f) => compact(f).includes(q));

function listQuery(req, sorts, defaultSort) {
  const flags = [].concat(req.query.f || []).map(String);
  return {
    q: clip(req.query.q, 100),
    f: flags,
    tag: clip(req.query.tag, 40),
    sort: sorts[req.query.sort] ? String(req.query.sort) : defaultSort,
  };
}

// Owing balance and last invoice date per customer and per vehicle, in one pass over the invoices.
async function invoiceTotals(db, today) {
  const docs = await listDocs(db, today, `d.type = 'invoice' AND d.status != 'void'`, [], '');
  const byCustomer = new Map();
  const byVehicle = new Map();
  for (const d of docs) {
    const c = byCustomer.get(d.customer_id) || { owing: 0, last_visit: '' };
    c.owing += Math.max(d.balance, 0);
    if (d.issue_date > c.last_visit) c.last_visit = d.issue_date;
    byCustomer.set(d.customer_id, c);
    if (d.vehicle_id) {
      const v = byVehicle.get(d.vehicle_id) || { last_visit: '' };
      if (d.issue_date > v.last_visit) v.last_visit = d.issue_date;
      byVehicle.set(d.vehicle_id, v);
    }
  }
  return { byCustomer, byVehicle };
}

async function customerList(req, today) {
  const filters = listQuery(req, CUSTOMER_SORTS, 'name');
  const archived = filters.f.includes('deleted');
  const rows = await req.db.all(
    `SELECT c.*, string_agg(v.rego, ', ' ORDER BY v.rego) FILTER (WHERE v.rego != '') AS regos, COUNT(v.id)::int AS vehicle_count
     FROM customers c LEFT JOIN vehicles v ON v.customer_id = c.id
     WHERE (c.archived_at IS NULL) = $1 GROUP BY c.id`,
    [!archived]
  );
  const { byCustomer } = await invoiceTotals(req.db, today);
  const q = compact(filters.q);
  const tags = new Set();
  let customers = rows.map((c) => ({ ...c, owing: 0, last_visit: '', ...(byCustomer.get(c.id) || {}), tag_list: tagList(c.tags) }));
  for (const c of customers) for (const t of c.tag_list) tags.add(t);
  if (q) customers = customers.filter((c) => matches(q, c.name, c.phone, c.email, c.regos, c.address, c.tags));
  if (filters.f.includes('owing')) customers = customers.filter((c) => c.owing > 0);
  if (filters.f.includes('company') && !filters.f.includes('individual')) customers = customers.filter((c) => c.kind === 'company');
  if (filters.f.includes('individual') && !filters.f.includes('company')) customers = customers.filter((c) => c.kind !== 'company');
  if (filters.tag) customers = customers.filter((c) => c.tag_list.some((t) => t.toLowerCase() === filters.tag.toLowerCase()));
  customers.sort(CUSTOMER_SORTS[filters.sort].fn);
  return { customers, filters, tags: [...tags].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })) };
}

async function vehicleList(req, today) {
  const filters = listQuery(req, VEHICLE_SORTS, 'rego');
  const rows = await req.db.all(
    `SELECT v.*, c.name AS customer_name, c.phone AS customer_phone, c.archived_at AS customer_archived
     FROM vehicles v JOIN customers c ON c.id = v.customer_id`
  );
  const { byVehicle } = await invoiceTotals(req.db, today);
  const q = compact(filters.q);
  const soon = addDays(today, 30);
  let vehicles = rows.map((v) => ({ ...v, last_visit: '', ...(byVehicle.get(v.id) || {}) }));
  if (!filters.f.includes('deleted')) vehicles = vehicles.filter((v) => !v.customer_archived);
  if (q) vehicles = vehicles.filter((v) => matches(q, v.rego, v.make, v.model, v.vin, v.year, v.colour, v.customer_name, v.customer_phone));
  if (filters.f.includes('rego_due')) vehicles = vehicles.filter((v) => v.rego_due && v.rego_due <= soon);
  if (filters.f.includes('service_due')) vehicles = vehicles.filter((v) => (v.next_service_date && v.next_service_date <= soon) || (v.next_service_km && v.odometer && v.odometer >= v.next_service_km));
  if (filters.f.includes('no_visit')) vehicles = vehicles.filter((v) => !v.last_visit);
  vehicles.sort(VEHICLE_SORTS[filters.sort].fn);
  return { vehicles, filters, soon };
}

const sendCsv = (res, name, rows) => res.type('text/csv').attachment(name).send(rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n');

module.exports = function (app, { xero }) {
  app.get('/customers', async (req, res) => {
    const { customers, filters, tags } = await customerList(req, res.locals.today);
    res.render('customers/index', { customers, filters, tags, sorts: CUSTOMER_SORTS });
  });

  app.get('/customers.csv', async (req, res) => {
    const { customers } = await customerList(req, res.locals.today);
    const rows = [['Name', 'Type', 'Phone', 'Email', 'Address', 'Tags', 'Vehicles', 'Owing', 'Last visit', 'Notes']];
    for (const c of customers) rows.push([c.name, c.kind, c.phone, c.email, c.address, c.tags, c.regos || '', dollars(c.owing), c.last_visit, c.notes]);
    sendCsv(res, 'customers.csv', rows);
  });

  app.get('/vehicles', async (req, res) => {
    const { vehicles, filters, soon } = await vehicleList(req, res.locals.today);
    res.render('vehicles/index', { vehicles, filters, soon, sorts: VEHICLE_SORTS });
  });

  app.get('/vehicles.csv', async (req, res) => {
    const { vehicles } = await vehicleList(req, res.locals.today);
    const rows = [['Rego', 'Make', 'Model', 'Year', 'Colour', 'VIN', 'Odometer', 'Owner', 'Phone', 'Rego due', 'Next service', 'Next service km', 'Last service', 'Last visit']];
    for (const v of vehicles) rows.push([v.rego, v.make, v.model, v.year, v.colour, v.vin, v.odometer ?? '', v.customer_name, v.customer_phone, v.rego_due || '', v.next_service_date || '', v.next_service_km ?? '', v.last_service_date || '', v.last_visit]);
    sendCsv(res, 'vehicles.csv', rows);
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
        `INSERT INTO customers (name, phone, email, address, notes, kind, tags, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [customer.name, customer.phone, customer.email, customer.address, customer.notes, customer.kind, customer.tags, now(req.tz)]
      );
      if (hasVehicle(vehicle)) await insertVehicle(db, c.id, vehicle, req.tz);
      return c.id;
    });
    res.redirect(`/customers/${id}`);
  });

  app.get('/customers/:id', async (req, res, next) => {
    const customer = await getCustomer(req.db, req.params.id);
    if (!customer) return next();
    const [vehicles, previous, jobs, docs, bookings] = await Promise.all([
      req.db.all('SELECT * FROM vehicles WHERE customer_id = $1 ORDER BY rego', [customer.id]),
      req.db.all(
        `SELECT v.*, o.from_at, o.to_at, c.name AS owner_name FROM vehicle_owners o
         JOIN vehicles v ON v.id = o.vehicle_id JOIN customers c ON c.id = v.customer_id
         WHERE o.customer_id = $1 AND o.to_at IS NOT NULL AND v.customer_id != $1 ORDER BY o.to_at DESC`,
        [customer.id]
      ),
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
    res.render('customers/show', { customer, vehicles, previous, jobs, docs, owing, bookings });
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
      `UPDATE customers SET name = $1, phone = $2, email = $3, address = $4, notes = $5, kind = $6, tags = $7 WHERE id = $8`,
      [customer.name, customer.phone, customer.email, customer.address, customer.notes, customer.kind, customer.tags, existing.id]
    );
    await xero.queueContact(req.db, existing.id);
    res.redirect(`/customers/${existing.id}`);
  });

  // Deleting a customer archives them: invoices are tax records, so nothing is thrown away.
  // They drop out of lists and pickers, and can be restored from the deleted customers view.
  app.post('/customers/:id/delete', async (req, res, next) => {
    const customer = await getCustomer(req.db, req.params.id);
    if (!customer) return next();
    await req.db.run('UPDATE customers SET archived_at = $1 WHERE id = $2', [now(req.tz), customer.id]);
    res.redirect('/customers');
  });

  app.post('/customers/:id/restore', async (req, res, next) => {
    const customer = await getCustomer(req.db, req.params.id);
    if (!customer) return next();
    await req.db.run('UPDATE customers SET archived_at = NULL WHERE id = $1', [customer.id]);
    res.redirect(`/customers/${customer.id}`);
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
    const [customer, owners, customers, jobs, docs] = await Promise.all([
      getCustomer(req.db, vehicle.customer_id),
      req.db.all(
        `SELECT o.*, c.name AS customer_name FROM vehicle_owners o JOIN customers c ON c.id = o.customer_id
         WHERE o.vehicle_id = $1 ORDER BY o.from_at DESC, o.id DESC`,
        [vehicle.id]
      ),
      customerOptions(req.db),
      req.db.all('SELECT * FROM jobs WHERE vehicle_id = $1 ORDER BY created_at DESC', [vehicle.id]),
      listDocs(req.db, res.locals.today, 'd.vehicle_id = $1', [vehicle.id]),
    ]);
    // Service history: what was done on each invoice, newest first.
    const invoiced = docs.filter((d) => d.type === 'invoice' && d.state !== 'void');
    const lines = invoiced.length
      ? await req.db.all('SELECT * FROM line_items WHERE document_id = ANY($1) ORDER BY sort, id', [invoiced.map((d) => d.id)])
      : [];
    const history = invoiced.map((d) => ({ doc: d, lines: lines.filter((l) => l.document_id === d.id) }));
    const reminders = await req.db.all(
      `SELECT r.*, u.name AS user_name FROM reminder_log r LEFT JOIN users u ON u.id = r.user_id WHERE r.vehicle_id = $1 ORDER BY r.at DESC LIMIT 20`,
      [vehicle.id]
    );
    res.render('vehicles/show', { vehicle, customer, owners, customers, jobs, docs, history, reminders, moved: req.query.moved === '1' });
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

  // Move a vehicle to another customer (sold, or a fleet car reassigned). Past jobs and invoices
  // stay with the customer they were billed to; the ownership history keeps who had it when.
  app.post('/vehicles/:id/transfer', async (req, res, next) => {
    const vehicle = await getVehicle(req.db, req.params.id);
    if (!vehicle) return next();
    const newName = clip(req.body.new_name, 200);
    const note = clip(req.body.note, 500);
    const fail = (error) => res.status(400).render('message', { title: 'Vehicle not moved', message: error });
    let target = parseIntOrNull(req.body.customer_id);
    if (!newName && !target) return fail('Pick a customer, or enter a name for a new one.');
    const at = now(req.tz);
    await req.db.tx(async (db) => {
      if (newName) {
        const c = await db.get(
          `INSERT INTO customers (name, phone, email, created_at) VALUES ($1, $2, $3, $4) RETURNING id`,
          [newName, clip(req.body.new_phone, 50), clip(req.body.new_email, 200), at]
        );
        target = c.id;
      } else if (!(await getCustomer(db, target))) {
        target = null;
      }
      if (!target || target === vehicle.customer_id) return;
      await db.run('UPDATE vehicle_owners SET to_at = $1 WHERE vehicle_id = $2 AND to_at IS NULL', [at, vehicle.id]);
      await db.run('INSERT INTO vehicle_owners (vehicle_id, customer_id, from_at, note) VALUES ($1, $2, $3, $4)', [vehicle.id, target, at, note]);
      await db.run('UPDATE vehicles SET customer_id = $1 WHERE id = $2', [target, vehicle.id]);
    });
    if (!target) return fail('That customer was not found.');
    res.redirect(`/vehicles/${vehicle.id}${target === vehicle.customer_id ? '' : '?moved=1'}`);
  });

  app.post('/vehicles/:id/delete', async (req, res, next) => {
    const vehicle = await getVehicle(req.db, req.params.id);
    if (!vehicle) return next();
    await req.db.run('DELETE FROM vehicles WHERE id = $1', [vehicle.id]);
    res.redirect(`/customers/${vehicle.customer_id}`);
  });
};
