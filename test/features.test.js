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

test('job card: checklist, time clock, activity log, promised time and service intervals', async () => {
  await owner.post('/customers', { name: 'Chuck List', phone: '0400 111 222', v_rego: 'CHK001', v_make: 'Ford', v_model: 'Ranger', v_odometer: '50000' });
  const vehicle = await owner.db.get(`SELECT * FROM vehicles WHERE rego = 'CHK001'`);
  await owner.db.run('UPDATE vehicles SET service_interval_months = 6, service_interval_km = 10000 WHERE id = $1', [vehicle.id]);

  let res = await owner.post('/jobs', { vehicle_id: vehicle.id, description: 'Logbook service and check brakes', due_date: '2026-10-20' });
  const jobId = idFrom(res);
  let job = await owner.db.get('SELECT * FROM jobs WHERE id = $1', [jobId]);
  assert.equal(job.is_service, true);
  assert.equal(job.due_date, '2026-10-20');

  // Checklist from the default template.
  res = await owner.post(`/jobs/${jobId}/checklist`);
  assert.equal(res.status, 302);
  await owner.post(`/jobs/${jobId}/checklist`); // no duplicates
  const checks = await owner.db.all('SELECT * FROM job_checks WHERE job_id = $1 ORDER BY sort', [jobId]);
  assert.equal(checks.length, 25);
  assert.equal(checks[0].heading, true);
  const pads = checks.find((c) => /Front brake pads/.test(c.item));
  const oil = checks.find((c) => /Engine oil/.test(c.item));

  // Saving the job saves results, priority and the promised time.
  const fields = {
    status: 'in_progress', mechanic_id: '', priority: 'urgent', odometer: '50500', due_date: '2026-10-21', due_time: '15:30', is_service: '1',
    description: 'Logbook service and check brakes', tech_notes: 'Pads at 2mm',
  };
  fields[`checks[c${pads.id}][result]`] = 'urgent';
  fields[`checks[c${pads.id}][note]`] = '2mm left';
  fields[`checks[c${oil.id}][result]`] = 'ok';
  res = await owner.post(`/jobs/${jobId}`, fields);
  assert.equal(res.status, 302);
  job = await owner.db.get('SELECT * FROM jobs WHERE id = $1', [jobId]);
  assert.equal(job.priority, 'urgent');
  assert.equal(job.due_time, '15:30');
  const page = await owner.get(`/jobs/${jobId}`);
  assert.match(page.text, /1 item need attention/);
  assert.match(page.text, /Status changed to In progress/);
  const report = await owner.get(`/jobs/${jobId}/inspection`);
  assert.match(report.text, /Needs your attention/);
  assert.match(report.text, /Front brake pads and rotors[\s\S]*2mm left[\s\S]*Urgent/);

  // The jobs list shows urgency and the promised time; the board view groups by status.
  const list = await owner.get('/jobs');
  assert.match(list.text, /Urgent/);
  assert.match(list.text, /21\/10\/2026 15:30/);
  const board = await owner.get('/jobs?view=board');
  assert.match(board.text, /class="tile urgent"/);

  // Time clock: clocking on to a second job closes the first.
  const res2 = await owner.post('/jobs', { vehicle_id: vehicle.id, description: 'Wipers' });
  const job2 = idFrom(res2);
  await owner.post(`/jobs/${jobId}/clock-on`);
  assert.match((await owner.get(`/jobs/${jobId}`)).text, /You're on the clock/);
  await owner.post(`/jobs/${job2}/clock-on`);
  let open = await owner.db.all('SELECT * FROM time_entries WHERE ended_at IS NULL');
  assert.equal(open.length, 1);
  assert.equal(open[0].job_id, job2);
  await owner.post(`/jobs/${job2}/clock-off`, { note: 'done' });
  open = await owner.db.all('SELECT * FROM time_entries WHERE ended_at IS NULL');
  assert.equal(open.length, 0);

  // Manual time, then billed as labour in quarter hours at the workshop rate.
  await owner.post(`/jobs/${jobId}/time`, { hours: '1.4', note: 'Brakes' });
  res = await owner.post(`/jobs/${jobId}/time/bill`);
  assert.equal(res.status, 302);
  let lines = await owner.db.all('SELECT * FROM line_items WHERE job_id = $1 ORDER BY sort', [jobId]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'labour');
  assert.equal(lines[0].qty, 1.5);
  assert.equal(lines[0].unit_cents, 12000);
  await owner.post(`/jobs/${jobId}/time/bill`); // nothing left to bill
  lines = await owner.db.all('SELECT * FROM line_items WHERE job_id = $1', [jobId]);
  assert.equal(lines.length, 1);

  // Invoicing a service sets the next service due from the intervals.
  res = await owner.post(`/jobs/${jobId}/invoice`);
  assert.equal(res.status, 302);
  const v = await owner.db.get('SELECT * FROM vehicles WHERE id = $1', [vehicle.id]);
  assert.equal(v.next_service_km, 60500);
  assert.equal(v.last_service_date, (await owner.get('/')).text.match(/\d{2}\/\d{2}\/\d{4}/) ? v.last_service_date : null);
  assert.match(v.next_service_date, /^\d{4}-\d{2}-\d{2}$/);
  const events = await owner.db.all('SELECT kind, text FROM job_events WHERE job_id = $1 ORDER BY id', [jobId]);
  assert.deepEqual(events.map((e) => e.kind), ['created', 'checklist', 'status', 'clock', 'clock', 'labour', 'invoice']);

  // Other workshops can't see or touch any of it.
  assert.equal((await other.get(`/jobs/${jobId}/inspection`)).status, 404);
  assert.equal((await other.post(`/jobs/${jobId}/clock-on`)).status, 404);
  assert.equal((await other.db.all('SELECT * FROM job_checks')).length, 0);
});

test('reports: aged debts, BAS quarters, by mechanic; customer statement', async () => {
  const ws = await t.signup('Report Co', 'report@example.com');
  await ws.post('/customers', { name: 'Slow Payer', v_rego: 'SLOW01' });
  const v = await ws.db.get(`SELECT * FROM vehicles WHERE rego = 'SLOW01'`);
  const me = await t.store.system.get('SELECT id FROM users WHERE email = $1', ['report@example.com']);
  const jobId = idFrom(await ws.post('/jobs', { vehicle_id: v.id, description: 'Brakes' }));
  await ws.post(`/jobs/${jobId}`, {
    status: 'ready', mechanic_id: String(me.id), description: 'Brakes',
    'lines[0][kind]': 'labour', 'lines[0][description]': 'Labour', 'lines[0][qty]': '2', 'lines[0][price]': '100', 'lines[0][gst]': '1',
    'lines[1][kind]': 'part', 'lines[1][description]': 'Pads', 'lines[1][qty]': '1', 'lines[1][price]': '80', 'lines[1][gst]': '1',
  });
  const invId = idFrom(await ws.post(`/jobs/${jobId}/invoice`));
  // Make it 45 days overdue and part paid.
  await ws.db.run(`UPDATE documents SET issue_date = '2026-08-01', due_date = '2026-08-30' WHERE id = $1`, [invId]);
  await ws.post(`/documents/${invId}/payments`, { amount: '100', date: '2026-09-01', method: 'cash' });

  const page = await ws.get('/reports?year=2026');
  assert.equal(page.status, 200);
  assert.match(page.text, /Who owes you <span class="muted">\$208\.00/);
  assert.match(page.text, /31–60 days<\/td><td class="num">1<\/td><td class="num">\$208\.00/);
  assert.match(page.text, /Jul – Sep<\/td><td class="num">1<\/td><td class="num">\$308\.00<\/td><td class="num">\$28\.00/);
  assert.match(page.text, /Report Co Owner<\/td><td class="num">1<\/td><td class="num">\$200\.00<\/td><td class="num">\$280\.00/);
  assert.match(page.text, /Slow Payer/);

  const customer = await ws.db.get('SELECT id FROM customers');
  const st = await ws.get(`/customers/${customer.id}/statement`);
  assert.match(st.text, /STATEMENT/);
  assert.match(st.text, /INV-1001[\s\S]*\$308\.00[\s\S]*\$100\.00[\s\S]*\$208\.00/);
  assert.match(st.text, /Total owing<\/th><td>\$208\.00/);
  assert.equal((await other.get(`/customers/${customer.id}/statement`)).status, 404);
});
