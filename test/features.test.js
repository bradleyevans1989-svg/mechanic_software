// Depth features: price list, job card extras, reports, reminders.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, idFrom } = require('./helpers');

let t;
let owner;
let other;

before(async () => {
  t = await startApp({ autoSync: false });
  owner = await t.signup('Deep Motors', 'deep@example.com');
  other = await t.signup('Other Shop', 'other@example.com');
});

after(() => t && t.stop());

test('price list: add, search, starter items, picker json, edit and hide', async () => {
  let res = await owner.post('/price-list', { kind: 'part', code: 'oilf', description: 'Oil filter', price: '25.50', cost: '12', gst: '1' });
  assert.equal(res.status, 302);
  res = await owner.post('/price-list', { kind: 'part', description: '' });
  assert.equal(res.status, 400);

  await owner.post('/price-list/starter');
  await owner.post('/price-list/starter'); // idempotent
  const count = (await owner.db.get('SELECT COUNT(*) AS n FROM price_items')).n;
  assert.equal(count, 18); // 17 starters plus ours; the starter OILF was skipped

  const page = await owner.get('/price-list?q=oil');
  assert.match(page.text, /OILF/);
  assert.match(page.text, /Engine oil/);

  const json = JSON.parse((await owner.get('/price-list.json?q=oil')).text);
  assert.ok(json.some((i) => i.code === 'OILF' && i.unit_cents === 2550 && i.gst === true));
  // Labour items with no price fall back to the hourly rate.
  const lab = JSON.parse((await owner.get('/price-list.json?q=diagnostic')).text)[0];
  assert.equal(lab.unit_cents, 12000);

  const item = await owner.db.get(`SELECT * FROM price_items WHERE code = 'OILF'`);
  res = await owner.post(`/price-list/${item.id}`, { kind: 'part', code: 'OILF', description: 'Oil filter (premium)', price: '30', gst: '1', active: '0' });
  assert.equal(res.status, 302);
  assert.ok(!JSON.parse((await owner.get('/price-list.json?q=premium')).text).length, 'hidden items stay out of the picker');
  assert.match((await owner.get('/price-list')).text, /Oil filter \(premium\)/);

  // Another workshop sees none of it.
  assert.equal(JSON.parse((await other.get('/price-list.json')).text).length, 0);
  assert.equal((await other.get(`/price-list/${item.id}/edit`)).status, 404);

  // The line editor carries the picker.
  const job = await owner.post('/customers', { name: 'Pick Er', v_rego: 'PICK01' });
  const vehicle = await owner.db.get('SELECT id FROM vehicles WHERE rego = $1', ['PICK01']);
  const j = await owner.post('/jobs', { vehicle_id: vehicle.id, description: 'Service' });
  assert.match((await owner.get(`/jobs/${idFrom(j)}`)).text, /Add from price list/);
  void job;
});
