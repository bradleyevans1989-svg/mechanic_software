const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, idFrom } = require('./helpers');
const { TYPE_KEYS, typeFor } = require('../lib/verticals');
const { seedDemo, emailFor } = require('../scripts/seed');

let t;

before(async () => {
  t = await startApp({ autoSync: false });
});

after(() => t && t.stop());

// Signs up with a workshop type picked, as the sign-up form does.
async function signupAs(type, email) {
  const c = t.client();
  const res = await c.post('/signup', { workshop: `${type} shop`, name: 'Owner', email, password: 'spanner-123', workshop_type: type });
  assert.equal(res.status, 302);
  c.cookie = res.headers.get('set-cookie').split(';')[0];
  const user = await t.store.system.get('SELECT * FROM users WHERE email = $1', [email]);
  c.db = t.store.tenant(user.workshop_id);
  return c;
}

test('public pages sell the app to each kind of workshop', async () => {
  const c = t.client();
  const index = await c.get('/workshops');
  assert.equal(index.status, 200);
  for (const key of TYPE_KEYS) {
    const type = typeFor(key);
    assert.match(index.text, new RegExp(`/workshops/${type.slug}`));
    const page = await c.get(`/workshops/${type.slug}`);
    assert.equal(page.status, 200, type.slug);
    assert.match(page.text, new RegExp(`/signup\\?type=${key}`));
  }
  assert.equal((await c.get('/workshops/spaceships')).status, 404);
  assert.match((await c.get('/signup?type=truck')).text, /<option value="truck" selected>/);
  assert.match((await c.get('/login')).text, /href="\/workshops"/);
});

test('a marine workshop gets boats, engine hours, HINs and its own starter set', async () => {
  const owner = await signupAs('marine', 'skipper@marine.example');
  assert.equal((await owner.db.get('SELECT workshop_type FROM settings')).workshop_type, 'marine');
  assert.ok(await owner.db.get(`SELECT id FROM price_items WHERE code = 'SVC100'`), 'outboard service in the price list');
  const procs = (await owner.db.all('SELECT title FROM procedures')).map((p) => p.title);
  assert.ok(procs.includes('Boat check-in'));
  assert.ok(!procs.includes('Vehicle check-in'), 'the car check-in is replaced');

  await owner.post('/customers', { name: 'Chris Hall', v_rego: 'BX123Q', v_make: 'Quintrex', v_model: '510', v_odometer: '342', v_vin: 'AU-QTX51043F919' });
  const boat = await owner.db.get(`SELECT * FROM vehicles WHERE rego = 'BX123Q'`);
  const page = (await owner.get(`/vehicles/${boat.id}`)).text;
  assert.match(page, /HIN \(hull ID\)/);
  assert.match(page, /342 hrs/);
  assert.match((await owner.get(`/vehicles/${boat.id}/edit`)).text, /Engine hours \(hrs\)/);
  assert.match((await owner.get('/vehicles')).text, /<h1>Boats/);

  const job = idFrom(await owner.post('/jobs', { vehicle_id: boat.id, description: '100 hour service' }));
  await owner.post(`/jobs/${job}/checklist`);
  const items = (await owner.db.all('SELECT item FROM job_checks WHERE job_id = $1', [job])).map((c) => c.item);
  assert.ok(items.includes('Water pump impeller and tell-tale flow'));

  for (const p of ['/', '/customers', '/vehicles', '/jobs', `/jobs/${job}`, `/jobs/${job}/print`, '/reminders', '/settings', '/price-list', '/procedures']) {
    const r = await owner.get(p);
    assert.equal(r.status, 200, `${p} returned ${r.status}`);
  }
});

test('changing type in settings changes the words and a stock checklist, but keeps a custom one', async () => {
  const owner = await t.signup('Plain Motors', 'plain@motors.example');
  assert.equal((await owner.db.get('SELECT COUNT(*) AS n FROM price_items')).n, 0, 'no type picked, no starter set');
  let settings = await owner.get('/settings');
  assert.match(settings.text, /name="workshop_type" value="mechanical" checked/);

  const base = { business_name: 'Plain Motors', labour_rate: '120', payment_days: '7', quote_days: '7', next_invoice_no: '1001', next_quote_no: '1001', next_job_no: '1001' };
  await owner.post('/settings', { ...base, workshop_type: 'farm', checklist: typeFor('mechanical').checklist.replace(/\n/g, '\r\n') });
  const s = await owner.db.get('SELECT workshop_type, checklist FROM settings');
  assert.equal(s.workshop_type, 'farm');
  assert.equal(s.checklist, '', 'a stock checklist follows the type');
  settings = await owner.get('/settings');
  assert.match(settings.text, /Three-point linkage and drawbar/);
  assert.match((await owner.get('/customers/new')).text, /Engine hours \(hrs\)/);

  await owner.post('/settings/starter');
  await owner.post('/settings/starter'); // idempotent
  assert.equal((await owner.db.get('SELECT COUNT(*) AS n FROM price_items')).n, typeFor('farm').items.length);
  assert.ok(await owner.db.get(`SELECT id FROM procedures WHERE title = 'Field service visit'`));

  await owner.post('/settings', { ...base, workshop_type: 'truck', checklist: '# Ours\nOur own check' });
  await owner.post('/settings', { ...base, workshop_type: 'motorcycle', checklist: '# Ours\nOur own check' });
  assert.equal((await owner.db.get('SELECT checklist FROM settings')).checklist, '# Ours\nOur own check');
  await owner.post('/settings', { ...base, workshop_type: 'nonsense', checklist: '' });
  assert.equal((await owner.db.get('SELECT workshop_type FROM settings')).workshop_type, 'mechanical');
});

test('demo workshops: one login per type, safe to run twice', async () => {
  assert.equal(await seedDemo(t.store), true);
  assert.equal(await seedDemo(t.store), false);
  for (const key of TYPE_KEYS) {
    const user = await t.store.system.get('SELECT workshop_id FROM users WHERE email = $1', [emailFor(key)]);
    assert.ok(user, key);
    const db = t.store.tenant(user.workshop_id);
    assert.equal((await db.get('SELECT workshop_type FROM settings')).workshop_type, key);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM vehicles')).n, 3);
    // The car workshop also gets a year of history for the Today charts.
    const invoices = (await db.get(`SELECT COUNT(*) AS n FROM documents WHERE type = 'invoice'`)).n;
    if (key === 'mechanical') assert.ok(invoices > 1);
    else assert.equal(invoices, 1);
  }
  const login = await t.client().post('/login', { email: emailFor('farm'), password: 'demo-password' });
  const farm = t.client(login.headers.get('set-cookie').split(';')[0]);
  const today = await farm.get('/');
  assert.equal(today.status, 200);
  assert.match(today.text, /Machine&#39;s here: start job|Machines with a service/);
});
