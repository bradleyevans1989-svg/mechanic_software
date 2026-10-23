// Live board: jobs on the floor against their estimates.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, idFrom } = require('./helpers');
const { paceOf, curve } = require('../routes/liveboard');

let t;
let owner;
let other;

before(async () => {
  t = await startApp({ autoSync: false });
  owner = await t.signup('Watch Motors', 'watch@example.com');
  other = await t.signup('Elsewhere', 'elsewhere@example.com');
});

after(() => t && t.stop());

test('pace: on track, nearing, over, or no estimate', () => {
  assert.equal(paceOf(30, 120), 'ok');
  assert.equal(paceOf(100, 120), 'nearing');
  assert.equal(paceOf(120, 120), 'nearing');
  assert.equal(paceOf(121, 120), 'over');
  assert.equal(paceOf(50, null), 'none');
});

test('curve: minutes logged over time, overlapping techs add up', () => {
  const at = (m) => new Date(Date.UTC(2026, 9, 22, 8, m)).toISOString();
  const now = Date.UTC(2026, 9, 22, 9, 0);
  const c = curve([
    { started_at: at(0), ended_at: at(30) },
    { started_at: at(20), ended_at: null },
  ], now);
  assert.equal(c.spanMinutes, 60);
  assert.deepEqual(c.points, [[0, 0], [20, 20], [30, 40], [60, 70]]);
  assert.deepEqual(curve([], now).points, []);
});

test('board shows jobs being worked on, their estimate, techs, and stays in its workshop', async () => {
  const c = await owner.db.get(`INSERT INTO customers (name, created_at) VALUES ('Pat Driver', '2026-10-22 08:00') RETURNING id`);
  const v = await owner.db.get(`INSERT INTO vehicles (customer_id, rego, make, model, created_at) VALUES ($1, 'BW123', 'Toyota', 'Hilux', '2026-10-22 08:00') RETURNING id`, [c.id]);

  let page = await owner.get('/live-board');
  assert.equal(page.status, 200);
  assert.match(page.text, /All quiet in the bays/);

  // Booked in only: not on the board yet.
  const jobId = idFrom(await owner.post('/jobs', { vehicle_id: v.id, description: 'Timing belt' }));
  assert.doesNotMatch((await owner.get('/live-board')).text, /BW123/);

  // An estimate with 2 hours of labour linked to the job sets the target.
  const q = await owner.db.get(
    `INSERT INTO documents (type, number, customer_id, vehicle_id, job_id, issue_date, status, created_at)
     VALUES ('quote', 7, $1, $2, $3, '2026-10-22', 'accepted', '2026-10-22 08:00') RETURNING id`,
    [c.id, v.id, jobId]
  );
  await owner.db.run(`INSERT INTO line_items (document_id, kind, description, qty, unit_cents) VALUES ($1, 'labour', 'Labour', 2, 12000)`, [q.id]);
  // 1h45m already logged, and the owner clocks on now: nearly at the estimate.
  const me = await t.store.system.get('SELECT id FROM users WHERE email = $1', ['watch@example.com']);
  await owner.db.run(`INSERT INTO time_entries (job_id, user_id, started_at, ended_at) VALUES ($1, $2, now() - interval '3 hours', now() - interval '75 minutes')`, [jobId, me.id]);
  await owner.post(`/jobs/${jobId}/clock-on`);

  page = await owner.get('/live-board');
  assert.match(page.text, /BW123/);
  assert.match(page.text, /class="bay pace-nearing"/);
  assert.match(page.text, /of 2h 00m estimated/);
  assert.match(page.text, /Estimate from estimate EST-7/);
  assert.match(page.text, /data-running="1"/);
  assert.match(page.text, /Watch Motors Owner <b>1h 45m<\/b>/);
  assert.match(page.text, /on since/);
  assert.match(page.text, /<polyline class="logged"/);

  // The polled fragment is just the board, and the workshop screen has no app header.
  const part = await owner.get('/live-board?part=board');
  assert.match(part.text, /BW123/);
  assert.doesNotMatch(part.text, /<html/);
  const tv = await owner.get('/live-board?tv=1');
  assert.match(tv.text, /class="bw-tv"/);
  assert.doesNotMatch(tv.text, /class="topbar"/);

  // Another workshop sees nothing of it.
  assert.doesNotMatch((await other.get('/live-board')).text, /BW123/);
  // And it needs a login.
  assert.equal((await t.client().get('/live-board')).status, 302);
});
