// Technician logins: their own jobs on My jobs, and nothing with prices or the business's settings.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, idFrom } = require('./helpers');

let t;
let owner;
let tech;
let techId;
let jobId;
let otherJobId;

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

before(async () => {
  t = await startApp({ autoSync: false });
  owner = await t.signup('Floor Motors', 'floor@example.com');
  let res = await owner.post('/staff', { name: 'Jess Carter', email: 'jess@example.com', role: 'tech', password: 'spanner-123' });
  assert.equal(res.status, 302);
  techId = (await t.store.system.get(`SELECT id, role FROM users WHERE email = 'jess@example.com'`)).id;

  tech = t.client();
  res = await tech.post('/login', { email: 'jess@example.com', password: 'spanner-123' });
  tech.cookie = res.headers.get('set-cookie').split(';')[0];

  res = await owner.post('/customers', { name: 'Sam Taylor', phone: '0412 345 678', v_rego: 'TECH01', v_make: 'Toyota', v_model: 'Hilux' });
  const vehicle = await owner.db.get(`SELECT id FROM vehicles WHERE rego = 'TECH01'`);
  jobId = idFrom(await owner.post('/jobs', { vehicle_id: vehicle.id, description: 'Front brakes' }));
  otherJobId = idFrom(await owner.post('/jobs', { vehicle_id: vehicle.id, description: 'Wipers' }));
  await owner.post(`/jobs/${jobId}`, { status: 'open', mechanic_id: techId, description: 'Front brakes', priority: 'normal', 'lines[a][kind]': 'part', 'lines[a][description]': 'Brake pads', 'lines[a][qty]': '1', 'lines[a][price]': '987.65' });
});

after(() => t && t.stop());

test('a technician lands on My jobs and sees only their jobs, without prices or phone numbers', async () => {
  const home = await tech.get('/');
  assert.equal(home.status, 302);
  assert.equal(home.location, '/my-jobs');

  const page = await tech.get('/my-jobs');
  assert.equal(page.status, 200);
  assert.match(page.text, /TECH01/);
  assert.match(page.text, /Front brakes/);
  assert.match(page.text, /Other jobs in the workshop/);
  assert.doesNotMatch(page.text, /href="\/invoices/);
  assert.doesNotMatch(page.text, /Technician<\/small>[\s\S]*Quick actions/);

  // The full job card bounces to the floor view, which has no prices or phone number.
  const card = await tech.get(`/jobs/${jobId}`);
  assert.equal(card.location, `/my-jobs/${jobId}`);
  const show = await tech.get(`/my-jobs/${jobId}`);
  assert.equal(show.status, 200);
  assert.doesNotMatch(show.text, /987/);
  assert.doesNotMatch(show.text, /0412 345 678/);
});

test('owner-only and office areas are closed to technicians', async () => {
  for (const path of ['/invoices', '/estimates', '/customers', '/reports', '/settings', '/integrations', '/staff', '/price-list', '/parts', '/timesheets', '/jobs', '/search?q=sam', '/bookings']) {
    const res = await tech.get(path);
    assert.equal(res.status, 403, path);
  }
  // No editing the job card's lines, invoicing or deleting.
  assert.equal((await tech.post(`/jobs/${jobId}`, { status: 'ready', description: 'x' })).status, 403);
  assert.equal((await tech.post(`/jobs/${jobId}/invoice`)).status, 403);
  assert.equal((await tech.post(`/jobs/${jobId}/delete`)).status, 403);
  assert.ok(await owner.db.get('SELECT id FROM jobs WHERE id = $1', [jobId]));
  // The owner still gets everything.
  assert.equal((await owner.get('/invoices')).status, 200);
  assert.equal((await owner.get('/my-jobs')).status, 200);
});

test('technicians clock on, tick tasks, fill notes and change status within the floor ones', async () => {
  await owner.post(`/jobs/${jobId}/tasks`, { text: 'Replace pads' });
  const task = await owner.db.get('SELECT id FROM job_tasks WHERE job_id = $1', [jobId]);

  let res = await tech.post(`/jobs/${jobId}/clock-on`);
  assert.equal(res.headers.get('location'), `/my-jobs/${jobId}#time`);
  res = await tech.post(`/jobs/${jobId}/tasks/${task.id}/toggle`);
  assert.equal(res.headers.get('location'), `/my-jobs/${jobId}#tasks`);
  const done = await owner.db.get('SELECT done_at, done_by FROM job_tasks WHERE id = $1', [task.id]);
  assert.ok(done.done_at);
  assert.equal(done.done_by, techId);

  // Techs can't take tasks off the list.
  await tech.post(`/jobs/${jobId}/tasks/${task.id}/delete`);
  assert.ok(await owner.db.get('SELECT id FROM job_tasks WHERE id = $1', [task.id]));

  await tech.post(`/jobs/${jobId}/progress`, { status: 'ready', tech_notes: 'Pads were down to 2mm' });
  let job = await owner.db.get('SELECT status, tech_notes FROM jobs WHERE id = $1', [jobId]);
  assert.equal(job.status, 'ready');
  assert.equal(job.tech_notes, 'Pads were down to 2mm');
  // Invoiced isn't a floor status.
  await tech.post(`/jobs/${jobId}/progress`, { status: 'invoiced' });
  job = await owner.db.get('SELECT status, tech_notes FROM jobs WHERE id = $1', [jobId]);
  assert.equal(job.status, 'ready');
  assert.equal(job.tech_notes, 'Pads were down to 2mm');

  await tech.post(`/jobs/${jobId}/notes`, { text: 'Rear pads next service' });
  const events = await owner.db.all('SELECT kind, text FROM job_events WHERE job_id = $1', [jobId]);
  assert.ok(events.some((e) => e.kind === 'note' && e.text === 'Rear pads next service'));
  assert.ok(events.some((e) => e.kind === 'task'));

  const owners = await owner.get(`/jobs/${jobId}`);
  assert.match(owners.text, /Replace pads/);
  assert.match(owners.text, /987/);
});

test('technicians add photos, and can delete only their own', async () => {
  await tech.post(`/jobs/${jobId}/photos`, { photo_data: PNG, caption: 'Worn pads' });
  await owner.post(`/jobs/${jobId}/photos`, { photo_data: PNG, caption: 'Office photo' });
  const photos = await owner.db.all('SELECT id, user_id FROM job_photos WHERE job_id = $1 ORDER BY id', [jobId]);
  assert.equal(photos.length, 2);
  const img = await tech.get(`/jobs/${jobId}/photos/${photos[0].id}`);
  assert.equal(img.status, 200);
  assert.equal(img.res.headers.get('content-type'), 'image/png');

  await tech.post(`/jobs/${jobId}/photos/${photos[1].id}/delete`);
  assert.equal((await owner.db.all('SELECT id FROM job_photos WHERE job_id = $1', [jobId])).length, 2);
  await tech.post(`/jobs/${jobId}/photos/${photos[0].id}/delete`);
  assert.equal((await owner.db.all('SELECT id FROM job_photos WHERE job_id = $1', [jobId])).length, 1);

  // Junk isn't stored.
  await tech.post(`/jobs/${jobId}/photos`, { photo_data: 'data:text/html;base64,PGgxPg==' });
  assert.equal((await owner.db.all('SELECT id FROM job_photos WHERE job_id = $1', [jobId])).length, 1);
});

test('technicians can pick up an unassigned job but not closed ones', async () => {
  await tech.post(`/jobs/${otherJobId}/take`);
  assert.equal((await owner.db.get('SELECT mechanic_id FROM jobs WHERE id = $1', [otherJobId])).mechanic_id, techId);

  await owner.post(`/jobs/${otherJobId}/status`, { status: 'cancelled' });
  assert.equal((await tech.get(`/my-jobs/${otherJobId}`)).status, 404);
  await tech.post(`/jobs/${otherJobId}/tasks`, { text: 'Sneaky' });
  assert.equal((await owner.db.all('SELECT id FROM job_tasks WHERE job_id = $1', [otherJobId])).length, 0);
});
