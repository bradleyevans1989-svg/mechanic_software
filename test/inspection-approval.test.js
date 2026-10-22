// Inspections sent to the customer: priced items, approve or decline by link, approved work onto the job.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, idFrom } = require('./helpers');

let t;
let a;
let b;
let jobId;
let url;

before(async () => {
  t = await startApp({ autoSync: false });
  a = await t.signup('Check Motors', 'check@example.com');
  b = await t.signup('Nosy Garage', 'nosy@example.com');
  await a.post('/customers', { name: 'Ivy Inspect', phone: '0400 555 666', v_rego: 'INS001', v_make: 'Ford', v_model: 'Focus' });
  const v = await a.db.get(`SELECT id FROM vehicles WHERE rego = 'INS001'`);
  jobId = idFrom(await a.post('/jobs', { vehicle_id: v.id, description: 'Service' }));
  await a.post(`/jobs/${jobId}/checklist`, {});
});

after(async () => {
  if (t) await t.stop();
});

async function saveChecks(fields) {
  const body = { description: 'Service', status: 'in_progress', ...fields };
  const res = await a.post(`/jobs/${jobId}`, body);
  assert.equal(res.status, 302);
}

test('flagged items get prices and a customer link', async () => {
  const [pads, wipers, oil] = await a.db.all('SELECT * FROM job_checks WHERE job_id = $1 AND NOT heading ORDER BY sort LIMIT 3', [jobId]);
  await saveChecks({
    [`checks[c${pads.id}][result]`]: 'urgent', [`checks[c${pads.id}][note]`]: 'Front pads 2mm', [`checks[c${pads.id}][price]`]: '280',
    [`checks[c${wipers.id}][result]`]: 'attention', [`checks[c${wipers.id}][price]`]: '45.50',
    [`checks[c${oil.id}][result]`]: 'ok', [`checks[c${oil.id}][price]`]: '',
  });
  const saved = await a.db.get('SELECT * FROM job_checks WHERE id = $1', [pads.id]);
  assert.equal(saved.price_cents, 28000);
  assert.equal((await a.db.get('SELECT price_cents FROM job_checks WHERE id = $1', [oil.id])).price_cents, null);

  let page = await a.get(`/jobs/${jobId}`);
  assert.match(page.text, /Make the customer link/);
  assert.equal((await b.post(`/jobs/${jobId}/inspection/share`, {})).status, 404);
  await a.post(`/jobs/${jobId}/inspection/share`, {});
  page = await a.get(`/jobs/${jobId}`);
  url = page.text.match(/value="(http[^"]*\/inspection\/[a-f0-9]{32})"/)[1];
  assert.match(page.text, /Not opened yet/);
  assert.match(page.text, /href="sms:0400 555 666/);
});

test('the customer sees prices with GST and answers each item', async () => {
  const path = new URL(url).pathname;
  const anon = t.client();
  let pub = await anon.get(path);
  assert.equal(pub.status, 200);
  assert.match(pub.text, /Your vehicle inspection/);
  assert.match(pub.text, /Front pads 2mm/);
  assert.match(pub.text, /\$308\.00/, '280 + GST');
  assert.match(pub.text, /\$50\.05/, '45.50 + GST');
  assert.doesNotMatch(pub.text, /class="side"/);
  assert.equal((await anon.get('/inspection/00000000000000000000000000000000')).status, 404);
  assert.match((await a.get(`/jobs/${jobId}`)).text, /Opened /);

  const [pads, wipers] = await a.db.all(`SELECT * FROM job_checks WHERE job_id = $1 AND result IN ('urgent', 'attention') ORDER BY sort`, [jobId]);
  const ok = await a.db.get(`SELECT * FROM job_checks WHERE job_id = $1 AND result = 'ok'`, [jobId]);
  const res = await anon.post(path, {
    [`decisions[c${pads.id}]`]: 'approve',
    [`decisions[c${wipers.id}]`]: 'decline',
    [`decisions[c${ok.id}]`]: 'approve',
  });
  assert.equal(res.status, 302);
  pub = await anon.get(res.headers.get('location'));
  assert.match(pub.text, /we've got your answers/);
  assert.equal((await a.db.get('SELECT decision FROM job_checks WHERE id = $1', [pads.id])).decision, 'approved');
  assert.equal((await a.db.get('SELECT decision FROM job_checks WHERE id = $1', [wipers.id])).decision, 'declined');
  assert.equal((await a.db.get('SELECT decision FROM job_checks WHERE id = $1', [ok.id])).decision, '', 'only flagged items can be approved');
  const ev = await a.db.get(`SELECT * FROM job_events WHERE kind = 'approval' AND text LIKE 'Customer%'`);
  assert.match(ev.text, /approved .*\(\$308\.00 inc GST\); declined/);
});

test('approved work goes onto the job once, and the job keeps its own lines', async () => {
  await a.db.run(`INSERT INTO line_items (job_id, kind, description, qty, unit_cents, gst, sort) VALUES ($1, 'labour', 'Service labour', 1, 15000, true, 0)`, [jobId]);
  let page = await a.get(`/jobs/${jobId}`);
  assert.match(page.text, /Add 1 approved item to the job \(\$280\.00 ex GST\)/);
  await a.post(`/jobs/${jobId}/inspection/add-approved`, {});
  await a.post(`/jobs/${jobId}/inspection/add-approved`, {});
  const lines = await a.db.all('SELECT * FROM line_items WHERE job_id = $1 ORDER BY sort', [jobId]);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].unit_cents, 28000);
  assert.match(lines[1].description, /: Front pads 2mm$/);
  page = await a.get(`/jobs/${jobId}`);
  assert.match(page.text, /Approved, on job/);

  // Once on the job the customer can't take it back from the link.
  const pads = await a.db.get(`SELECT * FROM job_checks WHERE job_id = $1 AND result = 'urgent'`, [jobId]);
  await t.client().post(new URL(url).pathname, { [`decisions[c${pads.id}]`]: 'decline' });
  assert.equal((await a.db.get('SELECT decision FROM job_checks WHERE id = $1', [pads.id])).decision, 'approved');
});

test('an invoiced job locks the answers', async () => {
  await a.post(`/jobs/${jobId}/status`, { status: 'invoiced' });
  const path = new URL(url).pathname;
  const pub = await t.client().get(path);
  assert.match(pub.text, /has been invoiced/);
  assert.doesNotMatch(pub.text, /Send my answers/);
  const wipers = await a.db.get(`SELECT * FROM job_checks WHERE job_id = $1 AND result = 'attention'`, [jobId]);
  await t.client().post(path, { [`decisions[c${wipers.id}]`]: 'approve' });
  assert.equal((await a.db.get('SELECT decision FROM job_checks WHERE id = $1', [wipers.id])).decision, 'declined');
});
