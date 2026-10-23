// The KPI report: periods, the numbers behind each tile, and who can see it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, idFrom } = require('./helpers');
const kpi = require('../lib/kpi');
const { addMonths } = require('../lib/util');

let t;
let owner;

before(async () => {
  t = await startApp({ autoSync: false });
  owner = await t.signup('Number Motors', 'numbers@example.com');
});

after(() => t && t.stop());

test('periods follow the calendar and the Australian financial year', () => {
  const p = kpi.periods('2026-10-22');
  assert.deepEqual(p.month, { label: 'This month', from: '2026-10-01', to: '2026-11-01' });
  assert.deepEqual([p['last-month'].from, p['last-month'].to], ['2026-09-01', '2026-10-01']);
  assert.deepEqual([p.quarter.from, p.quarter.to], ['2026-10-01', '2027-01-01']);
  assert.deepEqual([p['90d'].from, p['90d'].to], ['2026-07-25', '2026-10-23']);
  assert.deepEqual([p.fy.from, p.fy.to], ['2026-07-01', '2027-07-01']);
  assert.deepEqual([p['last-fy'].from, p['last-fy'].to], ['2025-07-01', '2026-07-01']);
  assert.deepEqual([kpi.periods('2027-03-02').fy.from], ['2026-07-01']);

  assert.deepEqual(kpi.previous('2026-10-01', '2026-11-01'), { from: '2026-09-01', to: '2026-10-01' });
  assert.deepEqual(kpi.previous('2026-07-01', '2027-07-01'), { from: '2025-07-01', to: '2026-07-01' });
  assert.deepEqual(kpi.previous('2026-10-10', '2026-10-20'), { from: '2026-09-30', to: '2026-10-10' });
});

test('kpi report: sales, average invoice, labour rate, efficiency, close rate and the mechanic table', async () => {
  await owner.post('/customers', { name: 'Kay Pee', phone: '0400 123 456', v_rego: 'KPI001', v_make: 'Mazda', v_model: '3' });
  const vehicle = await owner.db.get(`SELECT id, customer_id FROM vehicles WHERE rego = 'KPI001'`);
  const me = await owner.db.get(`SELECT id FROM users WHERE email = 'numbers@example.com'`);

  // A job worked for 2 hours, invoiced with 2.5 hours of labour and $100 of parts.
  const job = idFrom(await owner.post('/jobs', { vehicle_id: vehicle.id, description: 'Service', mechanic_id: me.id }));
  await owner.db.run(`UPDATE jobs SET mechanic_id = $1 WHERE id = $2`, [me.id, job]);
  await owner.db.run(
    `INSERT INTO time_entries (workshop_id, job_id, user_id, started_at, ended_at) VALUES ($1, $2, $3, now() - interval '2 hours', now())`,
    [owner.workshopId, job, me.id]
  );
  const inv = idFrom(await owner.post(`/jobs/${job}/invoice`));
  await owner.post(`/documents/${inv}`, {
    'lines[0][kind]': 'labour', 'lines[0][description]': 'Labour', 'lines[0][qty]': '2.5', 'lines[0][price]': '120', 'lines[0][gst]': '1',
    'lines[1][kind]': 'part', 'lines[1][description]': 'Filter', 'lines[1][qty]': '1', 'lines[1][price]': '100', 'lines[1][gst]': '1',
  });
  const { issue_date: day } = await owner.db.get('SELECT issue_date FROM documents WHERE id = $1', [inv]);

  // A cash invoice with $100 of labour (1 hour) and nothing clocked.
  const cash = idFrom(await owner.post('/documents', { type: 'invoice', vehicle_id: vehicle.id }));
  await owner.post(`/documents/${cash}`, {
    'lines[0][kind]': 'labour', 'lines[0][description]': 'Diagnosis', 'lines[0][qty]': '1', 'lines[0][price]': '100', 'lines[0][gst]': '1',
  });

  // Last month: one $200 invoice, so this month is up.
  const old = idFrom(await owner.post('/documents', { type: 'invoice', vehicle_id: vehicle.id }));
  await owner.post(`/documents/${old}`, {
    'lines[0][kind]': 'labour', 'lines[0][description]': 'Old job', 'lines[0][qty]': '2', 'lines[0][price]': '100', 'lines[0][gst]': '1',
  });
  const lastMonth = addMonths(`${day.slice(0, 7)}-01`, -1);
  await owner.db.run('UPDATE documents SET issue_date = $1, due_date = $1 WHERE id = $2', [lastMonth, old]);

  // Three estimates: one accepted, one declined, one still a draft (left out).
  for (const status of ['accepted', 'declined', 'draft']) {
    const q = idFrom(await owner.post('/documents', { type: 'quote', vehicle_id: vehicle.id }));
    await owner.db.run('UPDATE documents SET status = $1 WHERE id = $2', [status, q]);
  }

  const now = await kpi.compute(owner.db, 'Australia/Sydney', `${day.slice(0, 7)}-01`, addMonths(`${day.slice(0, 7)}-01`, 1), day);
  assert.equal(now.sales, 50000); // $300 + $100 + $100
  assert.equal(now.invoices, 2);
  assert.equal(now.cars, 1);
  assert.equal(now.averageInvoice, 25000);
  assert.equal(now.labour, 40000);
  assert.equal(now.hoursSold, 3.5);
  assert.equal(Math.round(now.labourRate), 11429);
  assert.ok(Math.abs(now.hoursClocked - 2) < 0.01, `clocked ${now.hoursClocked}`);
  assert.ok(Math.abs(now.efficiency - 1.25) < 0.01, `efficiency ${now.efficiency}`); // 2.5 sold on the clocked job / 2 clocked
  assert.equal(now.quotes, 2);
  assert.equal(now.closeRate, 0.5);
  assert.equal(now.returningShare, 1, 'invoiced last month too');
  assert.equal(now.mechanics.length, 1);
  assert.equal(now.mechanics[0].sold, 2.5);

  const html = (await owner.get('/reports/kpi')).text;
  assert.match(html, /<h1>KPIs <span class="muted">This month<\/span><\/h1>/);
  assert.match(html, /Sales ex GST<\/h2>\s*<div class="kpi-value">\$500\.00 <span class="kpi-change up">▲ 150%<\/span>/);
  assert.match(html, /Average invoice<\/h2>\s*<div class="kpi-value">\$250\.00/);
  assert.match(html, /Estimate close rate<\/h2>\s*<div class="kpi-value">50%/);
  assert.match(html, /Technician efficiency<\/h2>\s*<div class="kpi-value">125%/);
  assert.match(html, /<td>Number Motors Owner<\/td><td class="num">1<\/td><td class="num">\$400\.00<\/td>/);

  // Last month on its own, and a chosen range.
  assert.match((await owner.get('/reports/kpi?period=last-month')).text, /Sales ex GST<\/h2>\s*<div class="kpi-value">\$200\.00/);
  const custom = (await owner.get(`/reports/kpi?from=${lastMonth}&to=${day}`)).text;
  assert.match(custom, /Chosen dates/);
  assert.match(custom, /Sales ex GST<\/h2>\s*<div class="kpi-value">\$700\.00/);
  assert.match((await owner.get('/reports')).text, /href="\/reports\/kpi"/);
});

test('kpi report is for owners only', async () => {
  await owner.post('/staff', { name: 'Kev', email: 'kev@numbers.example', role: 'staff', password: 'wheel-brace' });
  const staff = t.client();
  const res = await staff.post('/login', { email: 'kev@numbers.example', password: 'wheel-brace' });
  staff.cookie = res.headers.get('set-cookie').split(';')[0];
  assert.equal((await staff.get('/reports/kpi')).status, 403);
});
