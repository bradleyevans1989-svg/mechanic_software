const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const util = require('../lib/util');
const { startApp, idFrom } = require('./helpers');

let t;
let owner;
let db;
const as = (c) => (typeof c === 'string' ? t.client(c) : c);
const post = (path, fields, c = owner) => as(c).post(path, fields);
const get = (path, c = owner) => as(c).get(path);

before(async () => {
  t = await startApp({ autoSync: false });
  // Not logged in: sent to login.
  const first = await t.client().get('/');
  assert.equal(first.location, '/login');
  owner = await t.signup('Demo Motors', 'Owner@Example.com');
  db = owner.db;
});

after(() => t.stop());

test('GST totals are 10% of the taxable lines', () => {
  const t = util.totals([
    { qty: 1.5, unit_cents: 12000, gst: 1 },
    { qty: 1, unit_cents: 4545, gst: 1 },
    { qty: 1, unit_cents: 1000, gst: 0 },
  ]);
  assert.deepEqual(t, { subtotal: 23545, gst: 2255, total: 25800 });
});

test('parses dollar amounts and line rows', () => {
  assert.equal(util.parseDollars('$1,234.50'), 123450);
  assert.equal(util.parseDollars(''), 0);
  const lines = util.parseLines({
    lines: {
      0: { kind: 'labour', description: 'Service', qty: '2', price: '120', gst: '1' },
      1: { kind: 'part', description: '', qty: '1', price: '', gst: '1' },
      12: { kind: 'part', description: 'Oil filter', qty: '1', price: '18.50', gst: '0' },
    },
  });
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[1], { kind: 'part', description: 'Oil filter', qty: 1, unit_cents: 1850, gst: 0 });
});

test('full workflow: customer, booking, job, invoice, payment', async () => {
  let res = await post('/customers', {
    name: 'Jane Citizen',
    phone: '0400 000 000',
    v_rego: 'abc123',
    v_make: 'Toyota',
    v_model: 'Hilux',
    v_odometer: '85000',
  });
  assert.equal(res.status, 302);
  const customerId = Number(res.headers.get('location').split('/').pop());
  const vehicle = await db.get('SELECT * FROM vehicles WHERE customer_id = $1', [customerId]);
  assert.equal(vehicle.rego, 'ABC123');

  res = await post('/bookings', { vehicle_id: vehicle.id, date: util.today(), time: '08:30', description: 'Logbook service' });
  assert.equal(res.status, 302);
  const booking = await db.get('SELECT * FROM bookings');
  assert.equal(booking.customer_id, customerId);

  const diary = await get('/bookings');
  assert.match(diary.text, /ABC123/);

  res = await post(`/bookings/${booking.id}/start`, {});
  const jobId = Number(res.headers.get('location').split('/').pop());
  const job = await db.get('SELECT * FROM jobs WHERE id = $1', [jobId]);
  assert.equal(job.description, 'Logbook service');
  assert.equal(job.odometer, 85000);

  res = await post(`/jobs/${jobId}`, {
    status: 'ready',
    description: 'Logbook service',
    tech_notes: 'Front pads at 4mm',
    odometer: '85210',
    'lines[0][kind]': 'labour',
    'lines[0][description]': 'Labour',
    'lines[0][qty]': '1.5',
    'lines[0][price]': '120',
    'lines[0][gst]': '1',
    'lines[1][kind]': 'part',
    'lines[1][description]': 'Engine oil 5L',
    'lines[1][qty]': '1',
    'lines[1][price]': '45.45',
    'lines[1][gst]': '1',
  });
  assert.equal(res.status, 302);

  const jobPage = await get(`/jobs/${jobId}`);
  assert.match(jobPage.text, /Engine oil 5L/);
  assert.match(jobPage.text, /\$248\.00/); // 180 + 45.45 = 225.45, GST 22.545 rounds to 22.55

  res = await post(`/jobs/${jobId}/invoice`, {});
  const invoiceId = Number(res.headers.get('location').split('/').pop());
  const invoice = await db.get('SELECT * FROM documents WHERE id = $1', [invoiceId]);
  assert.equal(invoice.type, 'invoice');
  assert.equal(invoice.number, 1001);
  assert.equal((await db.get('SELECT status FROM jobs WHERE id = $1', [jobId])).status, 'invoiced');
  assert.equal((await db.get('SELECT odometer FROM vehicles WHERE id = $1', [vehicle.id])).odometer, 85210);

  // Invoicing twice returns the same invoice.
  res = await post(`/jobs/${jobId}/invoice`, {});
  assert.equal(res.headers.get('location'), `/documents/${invoiceId}`);

  const print = await get(`/documents/${invoiceId}/print`);
  assert.match(print.text, /TAX INVOICE/);
  assert.match(print.text, /INV-1001/);
  assert.match(print.text, /\$248\.00/);

  res = await post(`/documents/${invoiceId}/payments`, { amount: '248.00', method: 'EFTPOS', date: util.today() });
  const paid = await get(`/documents/${invoiceId}`);
  assert.match(paid.text, /pill-paid/);

  const vehiclePage = await get(`/vehicles/${vehicle.id}`);
  assert.match(vehiclePage.text, /Engine oil 5L/);

  const report = await get(`/reports`);
  assert.match(report.text, /\$22\.55/);

  const csv = (await get('/reports/invoices.csv')).text;
  assert.match(csv, /INV-1001,.*,Jane Citizen,ABC123 · Toyota Hilux,225\.45,22\.55,248\.00,248\.00,0\.00,paid/);

  const search = await get('/search?q=abc123');
  assert.equal(search.location, `/vehicles/${vehicle.id}`);

  // Deleting a customer archives them: the invoices stay, the customer leaves the list and can be restored.
  res = await post(`/customers/${customerId}/delete`, {});
  assert.equal(res.status, 302);
  assert.doesNotMatch((await get('/customers')).text, /Jane Citizen/);
  assert.match((await get('/customers?f=deleted')).text, /Jane Citizen/);
  assert.ok((await db.get('SELECT COUNT(*)::int AS n FROM documents WHERE customer_id = $1', [customerId])).n > 0);
  res = await post(`/customers/${customerId}/restore`, {});
  assert.match((await get('/customers')).text, /Jane Citizen/);
});

test('quote converts to invoice with the same lines', async () => {
  const c = await db.get(`INSERT INTO customers (name, created_at) VALUES ('Quote Person', $1) RETURNING id`, [util.now()]);
  let res = await post('/documents', { type: 'quote', customer_id: c.id });
  const quoteId = Number(res.headers.get('location').split('/').pop());
  await post(`/documents/${quoteId}`, {
    issue_date: util.today(),
    'lines[0][kind]': 'part',
    'lines[0][description]': 'Brake pads',
    'lines[0][qty]': '1',
    'lines[0][price]': '100',
    'lines[0][gst]': '1',
  });
  res = await post(`/documents/${quoteId}/invoice`, {});
  const invId = Number(res.headers.get('location').split('/').pop());
  const page = await get(`/documents/${invId}`);
  assert.match(page.text, /Brake pads/);
  assert.match(page.text, /\$110\.00/);
  assert.equal((await db.get('SELECT status FROM documents WHERE id = $1', [quoteId])).status, 'accepted');
});

test('every main page renders', async () => {
  for (const p of ['/', '/bookings', '/bookings/new', '/jobs', '/jobs/new', '/jobs?status=all', '/quotes', '/invoices', '/invoices?show=all', '/customers', '/customers/new', '/reports', '/settings', '/staff', '/staff/new', '/account', '/documents/new?type=quote']) {
    const r = await get(p);
    assert.equal(r.status, 200, `${p} returned ${r.status}: ${r.text.slice(0, 300)}`);
  }
});

test('staff logins: owner adds staff, staff cannot see owner pages, deactivation signs out', async () => {
  let res = await post('/staff', { name: 'Mick', email: 'mick@example.com', role: 'staff', password: 'short' });
  assert.equal(res.status, 400);
  res = await post('/staff', { name: 'Mick', email: 'mick@example.com', role: 'staff', password: 'wheel-brace' });
  assert.equal(res.status, 302);

  res = await post('/login', { email: 'mick@example.com', password: 'wrong-pass' }, '');
  assert.equal(res.status, 401);
  res = await post('/login', { email: 'MICK@example.com', password: 'wheel-brace' }, '');
  assert.equal(res.status, 302);
  const mick = res.headers.get('set-cookie').split(';')[0];

  assert.equal((await get('/', mick)).status, 200);
  assert.equal((await get('/settings', mick)).status, 403);
  assert.equal((await get('/reports', mick)).status, 403);
  assert.equal((await get('/staff', mick)).status, 403);
  assert.doesNotMatch((await get('/', mick)).text, /href="\/settings"/);

  // Mick can be put on a job.
  const job = await db.get('SELECT id FROM jobs LIMIT 1');
  const mickId = (await t.store.system.get(`SELECT id FROM users WHERE email = 'mick@example.com'`)).id;
  await post(`/jobs/${job.id}`, { status: 'in_progress', mechanic_id: mickId, description: 'x' }, mick);
  assert.match((await get('/jobs?status=all')).text, /Mick/);

  // The last owner can't demote themselves.
  const ownerId = (await t.store.system.get(`SELECT id FROM users WHERE role = 'owner'`)).id;
  res = await post(`/staff/${ownerId}`, { name: 'Brad', email: 'owner@example.com', role: 'staff', active: '1' });
  assert.equal(res.status, 400);

  res = await post(`/staff/${mickId}`, { name: 'Mick', email: 'mick@example.com', role: 'staff', active: '0' });
  assert.equal(res.status, 302);
  assert.equal((await get('/', mick)).location, '/login');
  res = await post('/login', { email: 'mick@example.com', password: 'wheel-brace' }, '');
  assert.equal(res.status, 401);

  // Not logged in at all.
  assert.equal((await get('/customers', '')).location, '/login');
});

test('password change keeps you signed in and checks the old password', async () => {
  let res = await post('/account', { name: 'Brad', current_password: 'nope', new_password: 'new-spanner-1' });
  assert.equal(res.status, 400);
  res = await post('/account', { name: 'Brad', current_password: 'spanner-123', new_password: 'new-spanner-1' });
  assert.equal(res.status, 302);
  assert.equal((await get('/', owner.cookie)).location, '/login'); // old cookie is dead
  owner.cookie = res.headers.get('set-cookie').split(';')[0];
  assert.equal((await get('/')).status, 200);
});
