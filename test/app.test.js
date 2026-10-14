const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createApp } = require('../app');
const util = require('../lib/util');

let server;
let base;
let db;

before(async () => {
  delete process.env.APP_PASSWORD;
  db = open(':memory:');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

function post(path, fields) {
  return fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

async function get(path) {
  const res = await fetch(base + path);
  return { status: res.status, text: await res.text() };
}

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
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE customer_id = ?').get(customerId);
  assert.equal(vehicle.rego, 'ABC123');

  res = await post('/bookings', { vehicle_id: vehicle.id, date: util.today(), time: '08:30', description: 'Logbook service' });
  assert.equal(res.status, 302);
  const booking = db.prepare('SELECT * FROM bookings').get();
  assert.equal(booking.customer_id, customerId);

  const diary = await get('/bookings');
  assert.match(diary.text, /ABC123/);

  res = await post(`/bookings/${booking.id}/start`, {});
  const jobId = Number(res.headers.get('location').split('/').pop());
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
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
  const invoice = db.prepare('SELECT * FROM documents WHERE id = ?').get(invoiceId);
  assert.equal(invoice.type, 'invoice');
  assert.equal(invoice.number, 1001);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status, 'invoiced');
  assert.equal(db.prepare('SELECT odometer FROM vehicles WHERE id = ?').get(vehicle.id).odometer, 85210);

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

  const csv = await fetch(`${base}/reports/invoices.csv`).then((r) => r.text());
  assert.match(csv, /INV-1001,.*,Jane Citizen,ABC123 · Toyota Hilux,225\.45,22\.55,248\.00,248\.00,0\.00,paid/);

  const search = await fetch(`${base}/search?q=abc123`, { redirect: 'manual' });
  assert.equal(search.headers.get('location'), `/vehicles/${vehicle.id}`);

  // A customer with invoices can't be deleted.
  res = await post(`/customers/${customerId}/delete`, {});
  assert.equal(res.status, 400);
});

test('quote converts to invoice with the same lines', async () => {
  const c = db.prepare(`INSERT INTO customers (name, created_at) VALUES ('Quote Person', ?)`).run(util.now());
  let res = await post('/documents', { type: 'quote', customer_id: c.lastInsertRowid });
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
  assert.equal(db.prepare('SELECT status FROM documents WHERE id = ?').get(quoteId).status, 'accepted');
});

test('every main page renders', async () => {
  for (const p of ['/', '/bookings', '/bookings/new', '/jobs', '/jobs/new', '/jobs?status=all', '/quotes', '/invoices', '/invoices?show=all', '/customers', '/customers/new', '/reports', '/settings', '/documents/new?type=quote']) {
    const r = await get(p);
    assert.equal(r.status, 200, `${p} returned ${r.status}: ${r.text.slice(0, 300)}`);
  }
});

test('password protects the app when APP_PASSWORD is set', async () => {
  process.env.APP_PASSWORD = 'spanner';
  try {
    let res = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(res.headers.get('location'), '/login');
    res = await post('/login', { password: 'wrong' });
    assert.equal(res.status, 401);
    res = await post('/login', { password: 'spanner' });
    assert.equal(res.status, 302);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    res = await fetch(base + '/', { headers: { cookie }, redirect: 'manual' });
    assert.equal(res.status, 200);
  } finally {
    delete process.env.APP_PASSWORD;
  }
});
