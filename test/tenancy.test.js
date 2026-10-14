// One workshop must never see or touch another workshop's data.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const util = require('../lib/util');
const { startApp, idFrom } = require('./helpers');

let t;
let a; // Alpha Auto, has data
let b; // Bravo Brakes, tries to reach it
const ids = {};

before(async () => {
  t = await startApp({ autoSync: false });
  a = await t.signup('Alpha Auto', 'alpha@example.com');
  b = await t.signup('Bravo Brakes', 'bravo@example.com');

  let res = await a.post('/customers', { name: 'Alice Secret', phone: '0400 111 222', v_rego: 'ALPHA1', v_make: 'Subaru' });
  ids.customer = idFrom(res);
  ids.vehicle = (await a.db.get('SELECT id FROM vehicles')).id;
  res = await a.post('/jobs', { vehicle_id: ids.vehicle, description: 'Secret job' });
  ids.job = idFrom(res);
  await a.post(`/jobs/${ids.job}`, {
    status: 'ready', description: 'Secret job',
    'lines[0][kind]': 'part', 'lines[0][description]': 'Secret part', 'lines[0][qty]': '1', 'lines[0][price]': '50', 'lines[0][gst]': '1',
  });
  res = await a.post(`/jobs/${ids.job}/invoice`);
  ids.invoice = idFrom(res);
  await a.post(`/documents/${ids.invoice}/payments`, { amount: '10', method: 'Cash' });
  ids.payment = (await a.db.get('SELECT id FROM payments')).id;
  await a.post('/bookings', { vehicle_id: ids.vehicle, date: util.today(), description: 'Secret booking' });
  ids.booking = (await a.db.get('SELECT id FROM bookings')).id;
  await a.post('/staff', { name: 'Alpha Mechanic', email: 'mech@alpha.example', role: 'staff', password: 'wheel-brace' });
  ids.alphaStaff = (await t.store.system.get(`SELECT id FROM users WHERE email = 'mech@alpha.example'`)).id;
});

after(() => t.stop());

test("pages for another workshop's records are 404", async () => {
  for (const path of [
    `/customers/${ids.customer}`,
    `/customers/${ids.customer}/edit`,
    `/vehicles/${ids.vehicle}`,
    `/jobs/${ids.job}`,
    `/jobs/${ids.job}/print`,
    `/documents/${ids.invoice}`,
    `/documents/${ids.invoice}/print`,
    `/bookings/${ids.booking}/edit`,
    `/staff/${ids.alphaStaff}/edit`,
  ]) {
    const r = await b.get(path);
    assert.equal(r.status, 404, path);
    assert.doesNotMatch(r.text, /Alice|Secret|ALPHA1/, path);
  }
});

test("lists, search, reports and exports don't include another workshop's data", async () => {
  for (const path of ['/', '/customers', '/customers?q=Alice', '/jobs?status=all', '/invoices?show=all', '/bookings', '/search?q=ALPHA1', '/search?q=1001', '/reports', '/reports/invoices.csv', '/staff']) {
    const r = await b.get(path);
    assert.ok([200, 302].includes(r.status), path);
    if (r.status === 302) assert.doesNotMatch(r.location, new RegExp(`/(${Object.values(ids).join('|')})$`), path);
    // (The search box echoes what was typed, so look for the stored details, not the query.)
    assert.doesNotMatch(r.text, /Alice Secret|Secret job|Secret part|Secret booking|0400 111 222|Subaru|Alpha Mechanic/, path);
  }
  // The owner of Alpha does see their own.
  assert.match((await a.get('/customers')).text, /Alice Secret/);
});

test("changes aimed at another workshop's records do nothing", async () => {
  const attempts = [
    [`/customers/${ids.customer}`, { name: 'Hacked' }],
    [`/customers/${ids.customer}/delete`, {}],
    [`/customers/${ids.customer}/vehicles`, { rego: 'HACK' }],
    [`/vehicles/${ids.vehicle}`, { rego: 'HACK' }],
    [`/vehicles/${ids.vehicle}/delete`, {}],
    [`/jobs/${ids.job}`, { description: 'Hacked' }],
    [`/jobs/${ids.job}/invoice`, {}],
    [`/jobs/${ids.job}/delete`, {}],
    [`/documents/${ids.invoice}`, { notes: 'Hacked' }],
    [`/documents/${ids.invoice}/payments`, { amount: '999' }],
    [`/documents/${ids.invoice}/payments/${ids.payment}/delete`, {}],
    [`/documents/${ids.invoice}/void`, {}],
    [`/bookings/${ids.booking}`, { description: 'Hacked', vehicle_id: ids.vehicle }],
    [`/bookings/${ids.booking}/start`, {}],
    [`/bookings/${ids.booking}/delete`, {}],
    [`/staff/${ids.alphaStaff}`, { name: 'Hacked', email: 'mech@alpha.example', role: 'owner', active: '1' }],
  ];
  for (const [path, fields] of attempts) await b.post(path, fields);

  // Using Alpha's ids in Bravo's own forms doesn't link to them either.
  let res = await b.post('/jobs', { vehicle_id: ids.vehicle, customer_id: ids.customer, description: 'x' });
  assert.equal(res.status, 400);
  res = await b.post('/bookings', { vehicle_id: ids.vehicle, date: util.today() });
  assert.equal(res.status, 400);
  res = await b.post('/documents', { type: 'invoice', customer_id: ids.customer });
  assert.equal(res.status, 400);

  // Bravo can't put Alpha's mechanic on its own job.
  const bc = idFrom(await b.post('/customers', { name: 'Bob', v_rego: 'BRAVO1' }));
  const bv = (await b.db.get('SELECT id FROM vehicles')).id;
  const bjob = idFrom(await b.post('/jobs', { vehicle_id: bv }));
  await b.post(`/jobs/${bjob}`, { status: 'open', mechanic_id: ids.alphaStaff });
  assert.equal((await b.db.get('SELECT mechanic_id FROM jobs WHERE id = $1', [bjob])).mechanic_id, null);
  assert.ok(bc);

  // Alpha's data is untouched.
  const c = await a.db.get('SELECT * FROM customers WHERE id = $1', [ids.customer]);
  assert.equal(c.name, 'Alice Secret');
  assert.equal((await a.db.get('SELECT rego FROM vehicles WHERE id = $1', [ids.vehicle])).rego, 'ALPHA1');
  const job = await a.db.get('SELECT * FROM jobs WHERE id = $1', [ids.job]);
  assert.equal(job.description, 'Secret job');
  const inv = await a.db.get('SELECT * FROM documents WHERE id = $1', [ids.invoice]);
  assert.equal(inv.status, 'issued');
  assert.equal(inv.notes, 'Secret job');
  assert.equal((await a.db.all('SELECT * FROM payments')).length, 1);
  assert.equal((await a.db.get('SELECT description FROM bookings WHERE id = $1', [ids.booking])).description, 'Secret booking');
  const staff = await t.store.system.get('SELECT * FROM users WHERE id = $1', [ids.alphaStaff]);
  assert.equal(staff.name, 'Alpha Mechanic');
  assert.equal(staff.role, 'staff');
});

test('the database itself refuses cross-workshop reads and writes', async () => {
  // Bravo's connection sees none of Alpha's rows, even with no WHERE clause.
  for (const table of ['customers', 'vehicles', 'jobs', 'documents', 'line_items', 'payments', 'bookings', 'settings']) {
    const rows = await b.db.all(`SELECT * FROM ${table} WHERE workshop_id = $1`, [a.workshopId]);
    assert.equal(rows.length, 0, table);
  }
  // A connection with no workshop sees no workshop data at all.
  assert.equal((await t.store.system.all('SELECT * FROM customers')).length, 0);
  // Writing a row tagged with another workshop is rejected.
  await assert.rejects(
    b.db.run(`INSERT INTO customers (workshop_id, name, created_at) VALUES ($1, 'Planted', 'x')`, [a.workshopId]),
    /row-level security/
  );
  // Updates and deletes simply don't reach other workshops' rows.
  assert.equal((await b.db.run(`UPDATE customers SET name = 'Hacked'`)).rowCount, 1); // only Bravo's own Bob
  assert.equal((await a.db.get('SELECT name FROM customers WHERE id = $1', [ids.customer])).name, 'Alice Secret');
});

test('each workshop has its own numbering and settings', async () => {
  const bjob = await b.db.get('SELECT number FROM jobs');
  assert.equal(bjob.number, 1001);
  assert.equal((await a.db.get('SELECT number FROM documents')).number, 1001);
  await b.post('/settings', { business_name: 'Bravo Brakes Pty Ltd', labour_rate: '99', payment_days: '14', next_invoice_no: '5000', next_quote_no: '1', next_job_no: '1', timezone: 'Australia/Perth' });
  assert.equal((await a.db.get('SELECT business_name FROM settings')).business_name, 'Alpha Auto');
  assert.equal((await b.db.get('SELECT timezone FROM settings')).timezone, 'Australia/Perth');
});

test('sign-up rejects a duplicate email and bad input', async () => {
  const c = t.client();
  let res = await c.post('/signup', { workshop: 'Dup', name: 'Dup', email: 'ALPHA@example.com', password: 'longenough' });
  assert.equal(res.status, 400);
  res = await c.post('/signup', { workshop: '', name: 'X', email: 'x@example.com', password: 'longenough' });
  assert.equal(res.status, 400);
  res = await c.post('/signup', { workshop: 'X', name: 'X', email: 'x@example.com', password: 'short' });
  assert.equal(res.status, 400);
});
