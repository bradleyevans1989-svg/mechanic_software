// Text messages: sending through the provider, replies coming back, and day-before booking reminders.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { startApp, idFrom } = require('./helpers');
const sms = require('../lib/sms');
const { addDays, today } = require('../lib/util');
const { inboundSecret } = require('../routes/messages');

let t;
let a;
let b;
let fake;
const sent = [];
let failNext = false;

before(async () => {
  const f = express();
  f.use(express.json());
  f.post('/v3/sms/send', (req, res) => {
    if (failNext) {
      failNext = false;
      return res.json({ data: { messages: [{ status: 'INVALID_RECIPIENT' }] } });
    }
    sent.push({ auth: req.headers.authorization, ...req.body.messages[0] });
    res.json({ response_code: 'SUCCESS', data: { messages: [{ status: 'SUCCESS', message_id: `m${sent.length}` }] } });
  });
  const url = await new Promise((r) => {
    fake = f.listen(0, () => r(`http://localhost:${fake.address().port}`));
  });
  Object.assign(process.env, { SMS_PROVIDER: 'clicksend', CLICKSEND_USERNAME: 'bay', CLICKSEND_API_KEY: 'key', CLICKSEND_API_URL: url });
  t = await startApp({ autoSync: false });
  a = await t.signup('Texty Motors', 'texty@example.com');
  b = await t.signup('Other Garage', 'other@example.com');
});

after(async () => {
  for (const k of ['SMS_PROVIDER', 'CLICKSEND_USERNAME', 'CLICKSEND_API_KEY', 'CLICKSEND_API_URL']) delete process.env[k];
  if (t) await t.stop();
  if (fake) fake.close();
});

test('phone numbers become +61 and sender names are trimmed', () => {
  assert.equal(sms.normalise('0412 345 678'), '+61412345678');
  assert.equal(sms.normalise('+61 412 345 678'), '+61412345678');
  assert.equal(sms.normalise('61412345678'), '+61412345678');
  assert.equal(sms.normalise('07 5555 0100'), '+61755550100');
  assert.equal(sms.normalise('12'), '');
  assert.equal(sms.senderId("Bob's Auto Repairs Pty"), 'Bobs Auto R');
});

test('a text goes to the customer, shows in their thread, and failures are kept', async () => {
  const cid = idFrom(await a.post('/customers', { name: 'Tina Text', phone: '0412 345 678', v_rego: 'TXT001' }));
  let res = await a.post(`/customers/${cid}/messages`, { body: 'Hi Tina, your car is ready.' });
  assert.equal(res.status, 302);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '+61412345678');
  assert.equal(sent[0].body, 'Hi Tina, your car is ready.');
  assert.equal(sent[0].from, 'Texty Motor');
  assert.equal(sent[0].auth, `Basic ${Buffer.from('bay:key').toString('base64')}`);

  const page = await a.get(`/customers/${cid}/messages`);
  assert.match(page.text, /Hi Tina, your car is ready\./);
  assert.match(page.text, /Texty Motors Owner/);

  failNext = true;
  res = await a.post(`/customers/${cid}/messages`, { body: 'Second try' });
  assert.match(res.headers.get('location'), /error=Text%20failed/);
  const failed = await a.db.get(`SELECT * FROM sms_messages WHERE body = 'Second try'`);
  assert.equal(failed.status, 'failed');
  assert.match((await a.get(`/customers/${cid}/messages`)).text, /Not sent: Text failed/);

  // Other workshops can't text this workshop's customers.
  assert.equal((await b.post(`/customers/${cid}/messages`, { body: 'Sneaky' })).status, 404);
  assert.equal((await b.get('/messages')).text.includes('Tina'), false);
});

test('replies come back to the workshop that texted, and count as unread', async () => {
  const cid = (await a.db.get(`SELECT id FROM customers WHERE name = 'Tina Text'`)).id;
  const anon = t.client();
  assert.equal((await anon.post('/sms/inbound/wrong-secret', { from: '+61412345678', body: 'hi' })).status, 404);
  const res = await anon.post(`/sms/inbound/${inboundSecret()}`, { from: '+61412345678', body: 'Great, see you at 4' });
  assert.equal(res.status, 200);
  const reply = await a.db.get(`SELECT * FROM sms_messages WHERE direction = 'in'`);
  assert.equal(reply.customer_id, cid);
  assert.equal(reply.body, 'Great, see you at 4');
  assert.equal((await b.db.all(`SELECT * FROM sms_messages`)).length, 0);

  let home = await a.get('/messages');
  assert.match(home.text, /1 new/);
  assert.match(home.text, /<strong>1<\/strong> new text from customers/);
  await a.get(`/customers/${cid}/messages`);
  home = await a.get('/messages');
  assert.doesNotMatch(home.text, /1 new/);

  // A number nobody texted is dropped.
  await anon.post(`/sms/inbound/${inboundSecret()}`, { from: '+61499999999', body: 'who is this' });
  assert.equal((await a.db.all(`SELECT * FROM sms_messages WHERE body = 'who is this'`)).length, 0);
});

test('reminders and invoices can be texted from their pages', async () => {
  await a.post('/customers', { name: 'Rhys Remind', phone: '0400 111 222', v_rego: 'REM001' });
  const v = await a.db.get(`SELECT * FROM vehicles WHERE rego = 'REM001'`);
  await a.db.run('UPDATE vehicles SET next_service_date = $1 WHERE id = $2', [addDays(today(), 5), v.id]);
  const page = await a.get('/reminders');
  assert.match(page.text, /Text now/);
  const body = page.text.match(/name="body" value="([^"]*REM001[^"]*)"/)[1];
  const res = await a.post(`/customers/${v.customer_id}/messages`, {
    kind: 'reminder', body, reminder_vehicle_id: v.id, reminder_kind: 'service', back: '/reminders?kind=all&days=30',
  });
  assert.equal(res.headers.get('location'), '/reminders?kind=all&days=30&texted=1');
  assert.match(sent.at(-1).body, /due for a service/);
  const log = await a.db.get('SELECT * FROM reminder_log WHERE vehicle_id = $1', [v.id]);
  assert.equal(log.method, 'sms');

  const docId = idFrom(await a.post('/documents', { type: 'invoice', vehicle_id: v.id }));
  const docPage = await a.get(`/documents/${docId}`);
  assert.match(docPage.text, /Text it/);
  const r2 = await a.post(`/customers/${v.customer_id}/messages`, { kind: 'document', document_id: docId, body: 'Your invoice', back: `/documents/${docId}#send` });
  assert.equal(r2.headers.get('location'), `/documents/${docId}?sent=1#send`);
  const doc = await a.db.get('SELECT * FROM documents WHERE id = $1', [docId]);
  assert.equal(doc.sent_via, 'sms');
  // Going back only to a page on this site.
  const r3 = await a.post(`/customers/${v.customer_id}/messages`, { body: 'x', back: 'https://evil.example.com/' });
  assert.equal(r3.headers.get('location'), `/customers/${v.customer_id}/messages?texted=1`);
});

test('day-before booking reminders go once, only when turned on', async () => {
  const cid = idFrom(await a.post('/customers', { name: 'Bella Booked', phone: '0433 222 111', v_rego: 'BKD001', v_make: 'Mazda', v_model: '3' }));
  const v = await a.db.get(`SELECT id FROM vehicles WHERE rego = 'BKD001'`);
  const tomorrow = addDays(today('Australia/Sydney'), 1);
  await a.post('/bookings', { vehicle_id: v.id, date: tomorrow, time: '08:30', description: 'Service' });
  await a.post('/bookings', { vehicle_id: v.id, date: addDays(tomorrow, 3), description: 'Later one' });

  // Workshops can only be texted from 8am their time; pin the clock with a timezone where it's daytime.
  const tz = ['Australia/Sydney', 'Australia/Perth', 'Pacific/Auckland', 'Europe/London', 'America/New_York'].find(
    (z) => require('../lib/util').clock(z).time >= '08:00' && require('../lib/util').clock(z).time < '23:00'
  );
  await a.db.run('UPDATE settings SET timezone = $1', [tz]);
  await a.db.run('UPDATE bookings SET date = $1 WHERE description = $2', [addDays(today(tz), 1), 'Service']);

  const before = sent.length;
  assert.equal(await sms.sendBookingReminders(t.store), 0, 'off by default');
  let res = await a.post('/settings/messages', { sms_booking_reminders: '1', sms_sender: 'Texty', sms_booking_template: '', sms_ready_template: '' });
  assert.equal(res.status, 302);
  assert.equal(await sms.sendBookingReminders(t.store), 1);
  assert.equal(await sms.sendBookingReminders(t.store), 0, 'only once');
  assert.equal(sent.length, before + 1);
  assert.match(sent.at(-1).body, /^Hi Bella, a reminder that your Mazda 3 \(BKD001\) is booked in at Texty Motors on tomorrow, .* at 08:30\./);
  assert.equal(sent.at(-1).from, 'Texty');
  const m = await a.db.get(`SELECT * FROM sms_messages WHERE kind = 'booking'`);
  assert.equal(m.customer_id, cid);
  assert.equal(m.user_id, null);
});

test('a ready job offers the "car is ready" text', async () => {
  const v = await a.db.get(`SELECT id FROM vehicles WHERE rego = 'TXT001'`);
  const jobId = idFrom(await a.post('/jobs', { vehicle_id: v.id, description: 'Brakes' }));
  await a.post(`/jobs/${jobId}/status`, { status: 'ready' });
  const page = await a.get(`/jobs/${jobId}`);
  assert.equal((await a.db.get('SELECT status FROM jobs WHERE id = $1', [jobId])).status, 'ready');
  assert.match(page.text, /Text: car's ready/);
  assert.match(page.text, /Hi Tina, your TXT001 is ready to pick up from Texty Motors/);
  const res = await a.post(`/customers/${(await a.db.get(`SELECT customer_id FROM vehicles WHERE id = $1`, [v.id])).customer_id}/messages`, {
    kind: 'ready', job_id: jobId, body: 'ready!', back: `/jobs/${jobId}`,
  });
  assert.equal(res.headers.get('location'), `/jobs/${jobId}?texted=1`);
  assert.equal((await a.db.get(`SELECT job_id FROM sms_messages WHERE body = 'ready!'`)).job_id, jobId);
});
