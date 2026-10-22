// The Today page: sidebar and top bar, takings chart, money split, tiles, activity and the notifications bell.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, idFrom } = require('./helpers');
const charts = require('../lib/charts');
const { ranges, sumInto, timeAgo } = require('../lib/dashboard');
const util = require('../lib/util');

let t;
let owner;
let other;

before(async () => {
  t = await startApp({ autoSync: false });
  owner = await t.signup('Dash Motors', 'dash@example.com');
  other = await t.signup('Quiet Shop', 'quiet@example.com');
});

after(() => t && t.stop());

test('chart helpers: round axis tops, smooth lines that stay in range, buckets that add up', () => {
  assert.equal(charts.niceMax(0), 1);
  assert.equal(charts.niceMax(730), 1000);
  assert.equal(charts.niceMax(180000), 200000);
  assert.equal(charts.niceMax(240000), 250000);
  assert.equal(charts.shortMoney(1234500), '$12.3k');
  assert.equal(charts.shortMoney(4500), '$45');

  // A flat run then a jump must not dip below the flat part (monotone curve).
  const d = charts.smoothPath([[0, 100], [10, 100], [20, 100], [30, 0]]);
  const ys = d.match(/-?\d+(\.\d+)?/g).map(Number).filter((_, i) => i % 2 === 1);
  assert.ok(Math.max(...ys) <= 100, `curve overshoots: ${d}`);

  const r = ranges('2026-10-22');
  assert.equal(r.daily.length, 30);
  assert.equal(r.daily[29].from, '2026-10-22');
  assert.equal(r.weekly.length, 12);
  assert.equal(r.weekly[11].from, '2026-10-19'); // the Monday of this week
  assert.equal(r.monthly.length, 12);
  assert.equal(r.monthly[0].from, '2025-11-01');
  assert.deepEqual(r.yearly.map((b) => b.short), ['2022', '2023', '2024', '2025', '2026']);
  const rows = [{ day: '2026-10-01', cents: 500 }, { day: '2026-10-22', cents: 250 }, { day: '2026-09-30', cents: 100 }];
  assert.deepEqual(sumInto(r.monthly, rows).slice(-2), [100, 750]);

  const donut = charts.donut([{ name: 'Labour', cls: 'accent', value: 3 }, { name: 'Parts', cls: 'ink', value: 1 }]);
  assert.match(donut, /aria-label="Labour 75%, Parts 25%"/);
  assert.equal((donut.match(/class="slice /g) || []).length, 2);
  assert.match(charts.donut([]), /class="ring"/);
  assert.match(charts.lineChart([{ short: '<x>', long: 'x' }], [{ name: 'A', cls: 'accent', values: [0] }]), /&lt;x&gt;/);

  const now = Date.parse('2026-10-22T10:00:00Z');
  assert.equal(timeAgo('2026-10-22T09:58:00Z', now), '2 mins ago');
  assert.equal(timeAgo('2026-10-22T07:00:00Z', now), '3 hrs ago');
  assert.equal(timeAgo('2026-10-20T10:00:00Z', now), '2 days ago');
});

test('today page: sidebar with labels, takings and split from real invoices, tiles, activity and jobs table', async () => {
  await owner.post('/customers', { name: 'Dash Driver', phone: '0400 000 111', v_rego: 'DASH01', v_make: 'Toyota', v_model: 'Hilux' });
  const vehicle = await owner.db.get(`SELECT id FROM vehicles WHERE rego = 'DASH01'`);

  // An invoice this month: $300 labour and $100 parts ex GST, half paid.
  const inv = idFrom(await owner.post('/documents', { type: 'invoice', vehicle_id: vehicle.id }));
  await owner.post(`/documents/${inv}`, {
    'lines[0][kind]': 'labour', 'lines[0][description]': 'Labour', 'lines[0][qty]': '2.5', 'lines[0][price]': '120', 'lines[0][gst]': '1',
    'lines[1][kind]': 'part', 'lines[1][description]': 'Pads', 'lines[1][qty]': '1', 'lines[1][price]': '100', 'lines[1][gst]': '1',
  });
  await owner.post(`/documents/${inv}/payments`, { amount: '220', method: 'card', date: util.today() });

  // A job on the floor with a note in its log.
  const job = idFrom(await owner.post('/jobs', { vehicle_id: vehicle.id, description: 'Brake noise' }));
  await owner.post(`/jobs/${job}/notes`, { text: 'Pads are down to the metal' });

  const html = (await owner.get('/')).text;
  // Sidebar: main menu with labels, the current page marked, quick actions kept.
  assert.match(html, /<aside class="side" id="side">/);
  assert.match(html, /<a href="\/" class="active" data-label="Today" aria-current="page">.*<span>Today<\/span><\/a>/);
  assert.match(html, /<span>Invoices<\/span>/);
  assert.match(html, /<span>Reports<\/span>/, 'owners see Reports');
  assert.match(html, /<p class="side-label">Quick actions<\/p>/);
  assert.match(html, /data-label="New booking"><svg[^]*?<span>New booking<\/span>/);
  assert.match(html, /data-side-toggle/);
  // Top bar: search, bell and who's signed in.
  assert.match(html, /<span class="who-name">Dash Motors Owner<small>Owner<\/small><\/span>/);

  // Takings: this month's total, and a chart per tab with Monthly showing first.
  assert.match(html, /<strong class="big">\$440\.00<\/strong>/);
  for (const key of ['daily', 'weekly', 'monthly', 'yearly']) assert.match(html, new RegExp(`class="chart chart-${key}"><svg class="line-chart"`));
  assert.match(html, /id="range-monthly" class="range-radio" checked/);
  assert.match(html, /Invoiced: \$440\.00\nReceived: \$220\.00<\/title>/, 'hover tip on this month carries both series');

  // Money split: 75% labour, 25% parts.
  assert.match(html, /aria-label="Labour 75%, Parts 25%, Other 0%"/);
  assert.match(html, /<strong>75<sup>%<\/sup><\/strong><span class="key accent">Labour<\/span>/);

  // Tiles: received this month, jobs in progress, pace, outstanding.
  assert.match(html, /Received this month[^]*?<strong>\$220<\/strong>/);
  assert.match(html, /Outstanding invoices[^]*?<strong>\$220<\/strong><small>1 unpaid · 0 overdue<\/small>/);
  assert.match(html, /No timed jobs finished in the last 30 days/);

  // Activity log and the jobs table.
  assert.match(html, /<strong>Note added<\/strong>[^]*?Pads are down to the metal/);
  assert.match(html, /<strong>Job opened<\/strong>/);
  assert.match(html, /<table class="table dark-head">[^]*?Brake noise/);
});

test('job time vs estimate counts finished jobs against their estimated labour', async () => {
  await owner.post('/customers', { name: 'Pace Setter', v_rego: 'PACE01' });
  const vehicle = await owner.db.get(`SELECT id FROM vehicles WHERE rego = 'PACE01'`);
  const job = idFrom(await owner.post('/jobs', { vehicle_id: vehicle.id, description: 'Service' }));
  // Two hours of labour on the card, an hour and a half on the clock.
  await owner.db.run(`INSERT INTO line_items (job_id, kind, description, qty, unit_cents) VALUES ($1, 'labour', 'Labour', 2, 12000)`, [job]);
  await owner.db.run(`INSERT INTO time_entries (job_id, started_at, ended_at) VALUES ($1, now() - interval '3 hours', now() - interval '90 minutes')`, [job]);
  await owner.db.run(`UPDATE jobs SET status = 'ready', completed_at = $2 WHERE id = $1`, [job, `${util.today()} 12:00:00`]);
  const html = (await owner.get('/')).text;
  assert.match(html, /Job time vs estimate<\/span>\s*<strong class="gtile-big">75%<\/strong>/);
  assert.match(html, /On or under the estimate, 1 job in 30 days/);
});

test('the bell counts open to-dos and overdue invoices, and only for this workshop', async () => {
  await owner.post('/team', { text: 'Ring the supplier', kind: 'todo' });
  await owner.post('/customers', { name: 'Late Payer', v_rego: 'LATE01' });
  const vehicle = await owner.db.get(`SELECT id FROM vehicles WHERE rego = 'LATE01'`);
  const inv = idFrom(await owner.post('/documents', { type: 'invoice', vehicle_id: vehicle.id }));
  await owner.post(`/documents/${inv}`, { 'lines[0][kind]': 'labour', 'lines[0][description]': 'Work', 'lines[0][qty]': '1', 'lines[0][price]': '50', 'lines[0][gst]': '1' });
  await owner.db.run(`UPDATE documents SET due_date = $2 WHERE id = $1`, [inv, util.addDays(util.today(), -3)]);

  const html = (await owner.get('/jobs')).text;
  assert.match(html, /<b class="count">2<\/b>/);
  assert.match(html, /<strong>1<\/strong> open to-do for the team/);
  assert.match(html, /<strong>1<\/strong> overdue invoice</);

  const quiet = (await other.get('/jobs')).text;
  assert.doesNotMatch(quiet, /class="count"/);
  assert.match(quiet, /<strong>0<\/strong> overdue invoices/);
});

test('staff see the menu without the owner pages', async () => {
  await owner.post('/staff', { name: 'Mick', email: 'mick-dash@example.com', password: 'spanner-123', role: 'staff' });
  const mick = t.client();
  const res = await mick.post('/login', { email: 'mick-dash@example.com', password: 'spanner-123' });
  mick.cookie = res.headers.get('set-cookie').split(';')[0];
  const html = (await mick.get('/')).text;
  assert.match(html, /<span>Team<\/span>/);
  assert.doesNotMatch(html, /<span>Reports<\/span>/);
  assert.doesNotMatch(html, /<span>Settings<\/span>/);
  assert.match(html, /<small>Staff<\/small>/);
  assert.match(html, /All invoices/);
});
