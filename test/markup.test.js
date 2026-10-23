// Cost and markup on job card and invoice lines, and who gets to see them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, idFrom } = require('./helpers');

let t;
let owner;

before(async () => {
  t = await startApp({ autoSync: false });
  owner = await t.signup('Markup Motors', 'markup@example.com');
});

after(() => t && t.stop());

test('a line keeps its cost and markup through the job card, the invoice and the totals', async () => {
  const settingsPage = (await owner.get('/settings')).text;
  assert.match(settingsPage, /name="markup_pct" inputmode="decimal" value="30"/);

  const customer = idFrom(await owner.post('/customers', { name: 'Cost Customer', v_rego: 'mk1' }));
  const vehicle = await owner.db.get('SELECT id FROM vehicles WHERE customer_id = $1', [customer]);
  const job = idFrom(await owner.post('/jobs', { vehicle_id: vehicle.id, description: 'Brakes' }));
  await owner.post(`/jobs/${job}`, {
    status: 'in_progress',
    description: 'Brakes',
    'lines[0][kind]': 'part', 'lines[0][description]': 'Brake pads', 'lines[0][qty]': '1',
    'lines[0][cost]': '80', 'lines[0][markup]': '50', 'lines[0][price]': '120.00', 'lines[0][gst]': '1',
    'lines[1][kind]': 'labour', 'lines[1][description]': 'Labour', 'lines[1][qty]': '1',
    'lines[1][cost]': '', 'lines[1][markup]': '', 'lines[1][price]': '150', 'lines[1][gst]': '1',
  });
  const [pads, labour] = await owner.db.all('SELECT * FROM line_items WHERE job_id = $1 ORDER BY sort', [job]);
  assert.equal(pads.cost_cents, 8000);
  assert.equal(pads.markup_pct, 50);
  assert.equal(pads.unit_cents, 12000);
  assert.equal(labour.cost_cents, 0);
  assert.equal(labour.markup_pct, null);

  const page = (await owner.get(`/jobs/${job}`)).text;
  assert.match(page, /Cost ex GST/);
  assert.match(page, /name="lines\[0\]\[cost\]" value="80.00"/);
  assert.match(page, /name="lines\[0\]\[markup\]" value="50"/);
  assert.match(page, /data-default-markup="30"/);
  assert.match(page, /data-total="profit">\$190\.00/); // $270 sold less $80 cost

  const inv = idFrom(await owner.post(`/jobs/${job}/invoice`, {}));
  const copied = await owner.db.get(`SELECT * FROM line_items WHERE document_id = $1 AND description = 'Brake pads'`, [inv]);
  assert.equal(copied.cost_cents, 8000);
  assert.equal(copied.markup_pct, 50);
  assert.match((await owner.get(`/documents/${inv}`)).text, /data-total="cost">\$80\.00/);

  // What the customer sees never shows the cost.
  const print = (await owner.get(`/documents/${inv}/print`)).text;
  assert.doesNotMatch(print, /Cost ex GST|Markup %|Profit ex GST/);
});

test('the default markup is set in Settings', async () => {
  const s = await owner.db.get('SELECT * FROM settings');
  await owner.post('/settings', {
    business_name: s.business_name, labour_rate: '150', payment_days: '14', next_invoice_no: String(s.next_invoice_no),
    next_quote_no: String(s.next_quote_no), next_job_no: String(s.next_job_no), timezone: s.timezone, quote_days: '7', markup_pct: '42.5',
  });
  assert.equal((await owner.db.get('SELECT markup_pct FROM settings')).markup_pct, 42.5);
});

test('the price list picker brings the cost along', async () => {
  await owner.post('/price-list', { kind: 'part', code: 'OF1', description: 'Oil filter Z1', price: '25', cost: '12.50', gst: '1' });
  const items = JSON.parse((await owner.get('/price-list.json?q=OF1')).text);
  assert.equal(items[0].cost_cents, 1250);
});
