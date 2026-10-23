// Online booking: the public page, requests landing for approval, and turning them into diary bookings.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { slugFrom } = require('../routes/online-booking');

let t;
let a;
let b;
let slug;

before(async () => {
  t = await startApp({ autoSync: false });
  a = await t.signup("Bob's Brakes & Tyres", 'bob@example.com');
  b = await t.signup('Other Garage', 'og@example.com');
});

after(async () => {
  if (t) await t.stop();
});

const field = (html, name) => (html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`)) || [])[1];

test('page addresses come from the business name', () => {
  assert.equal(slugFrom("Bob's Brakes & Tyres"), 'bob-s-brakes-and-tyres');
  assert.equal(slugFrom('  !!  '), 'workshop');
});

test('the booking page is off until the owner turns it on', async () => {
  const page = await a.get('/settings/booking');
  assert.equal(page.status, 200);
  slug = field(page.text, 'slug');
  assert.equal(slug, 'bob-s-brakes-and-tyres');
  const anon = t.client();
  assert.equal((await anon.get(`/book/${slug}`)).status, 404);
  assert.equal((await anon.get('/book/nope')).status, 404);

  const res = await a.post('/settings/booking', {
    online_booking: '1', slug, booking_intro: 'Book a time with Bob.', booking_services: 'Logbook service\nBrakes',
    days: ['1', '2', '3', '4', '5', '6', '0'], booking_notice_days: '1', booking_max_per_day: '1',
  });
  assert.equal(res.status, 302);
  const pub = await anon.get(`/book/${slug}`);
  assert.equal(pub.status, 200);
  assert.match(pub.text, /Book a time with Bob\./);
  assert.match(pub.text, /<option >Brakes<\/option>|<option>Brakes<\/option>|Brakes<\/option>/);
  assert.doesNotMatch(pub.text, /class="side"/, 'no staff menu on the public page');
});

test('a customer requests a day, and a full day disappears', async () => {
  const anon = t.client();
  let pub = await anon.get(`/book/${slug}`);
  const firstDay = pub.text.match(/name="date"[\s\S]*?<option value="(\d{4}-\d{2}-\d{2})"/)[1];

  // Missing details are sent back with what was typed kept.
  let res = await anon.post(`/book/${slug}`, { name: 'Pat Request', phone: '12', rego: 'pat 01', date: firstDay });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /phone number/);
  res = await anon.post(`/book/${slug}`, { name: 'Pat Request', phone: '0411 222 333', rego: 'pat 01', date: '2001-01-01' });
  assert.equal(res.status, 400);

  res = await anon.post(`/book/${slug}`, {
    name: 'Pat Request', phone: '0411 222 333', email: 'pat@example.com', rego: 'pat 01', car: 'Subaru Forester',
    service: 'Brakes', date: firstDay, drop_off: 'early', notes: 'Squeals when stopping',
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), new RegExp(`^/book/${slug}/thanks`));
  assert.match((await anon.get(res.headers.get('location'))).text, /we've got your request/);

  const r = await a.db.get('SELECT * FROM booking_requests');
  assert.equal(r.rego, 'PAT01');
  assert.equal(r.status, 'pending');
  assert.equal((await b.db.all('SELECT * FROM booking_requests')).length, 0, 'only this workshop sees it');

  // Max one a day: the requested day is no longer offered.
  pub = await anon.get(`/book/${slug}`);
  assert.doesNotMatch(pub.text, new RegExp(`value="${firstDay}"`));

  // Bots that fill the hidden field are quietly dropped.
  await anon.post(`/book/${slug}`, { name: 'Bot', phone: '0400000000', rego: 'BOT1', date: firstDay, website: 'http://spam' });
  assert.equal((await a.db.all('SELECT * FROM booking_requests')).length, 1);
});

test('the workshop sees the request and accepting it books a new customer in', async () => {
  const diary = await a.get('/bookings');
  assert.match(diary.text, /1 online booking request waiting/);
  const page = await a.get('/bookings/requests');
  assert.match(page.text, /Pat Request/);
  assert.match(page.text, /New customer/);
  assert.match(page.text, /Squeals when stopping/);

  const r = await a.db.get('SELECT * FROM booking_requests');
  assert.equal((await b.post(`/bookings/requests/${r.id}/accept`, {})).status, 404, 'other workshops cannot accept it');
  const res = await a.post(`/bookings/requests/${r.id}/accept`, { time: '08:15' });
  assert.equal(res.status, 302);
  const booking = await a.db.get('SELECT * FROM bookings');
  assert.equal(booking.date, r.date);
  assert.equal(booking.time, '08:15');
  assert.match(booking.description, /^Online booking: Brakes · First thing/);
  const c = await a.db.get('SELECT * FROM customers WHERE id = $1', [booking.customer_id]);
  assert.equal(c.name, 'Pat Request');
  assert.equal(c.email, 'pat@example.com');
  const v = await a.db.get('SELECT * FROM vehicles WHERE id = $1', [booking.vehicle_id]);
  assert.equal(v.rego, 'PAT01');
  assert.equal(v.make, 'Subaru');
  assert.equal(v.model, 'Forester');
  assert.equal((await a.db.get('SELECT status, booking_id FROM booking_requests')).booking_id, booking.id);
  assert.equal((await a.post(`/bookings/requests/${r.id}/accept`, {})).status, 404, 'only once');
});

test('a returning customer is matched by rego, and requests can be declined', async () => {
  await a.db.run(`UPDATE settings SET booking_max_per_day = 0`);
  const anon = t.client();
  const pub = await anon.get(`/book/${slug}`);
  const day = pub.text.match(/name="date"[\s\S]*?<option value="(\d{4}-\d{2}-\d{2})"/)[1];
  await anon.post(`/book/${slug}`, { name: 'Pat R', phone: '0499 999 999', rego: 'PAT01', service: 'Logbook service', date: day });
  await anon.post(`/book/${slug}`, { name: 'Nobody', phone: '0400 000 001', car: 'Holden Commodore', date: day });
  const page = await a.get('/bookings/requests');
  assert.match(page.text, /Matches <a href="\/vehicles\/\d+">PAT01/);

  const [returning, other] = await a.db.all(`SELECT * FROM booking_requests WHERE status = 'pending' ORDER BY id`);
  await a.post(`/bookings/requests/${returning.id}/accept`, {});
  assert.equal((await a.db.all('SELECT * FROM customers')).length, 1, 'no duplicate customer');
  assert.equal((await a.db.all('SELECT * FROM vehicles')).length, 1, 'no duplicate car');
  await a.post(`/bookings/requests/${other.id}/decline`, {});
  assert.equal((await a.db.get('SELECT status FROM booking_requests WHERE id = $1', [other.id])).status, 'declined');
});

test('addresses can be changed but not taken from another workshop', async () => {
  await b.get('/settings/booking');
  let res = await b.post('/settings/booking', { slug, days: ['1'] });
  assert.match(res.headers.get('location'), /error=That%20address%20is%20taken/);
  res = await b.post('/settings/booking', { slug: 'BAD slug!', days: ['1'] });
  assert.match(res.headers.get('location'), /error=/);
  res = await b.post('/settings/booking', { slug: 'other-garage-cairns', days: ['1'], online_booking: '1' });
  assert.equal(res.headers.get('location'), '/settings/booking?saved=1');
  assert.equal((await t.client().get('/book/other-garage-cairns')).status, 200);
});
