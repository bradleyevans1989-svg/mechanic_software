// Loan cars: the fleet, booking without double-ups, handover and return, and who had a car on a day.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, idFrom } = require('./helpers');
const { addDays, today } = require('../lib/util');

let t;
let a;
let b;
let carId;
let jobId;
let customerId;
const d0 = today('Australia/Sydney');

before(async () => {
  t = await startApp({ autoSync: false });
  a = await t.signup('Loaner Motors', 'loaner@example.com');
  b = await t.signup('Other Motors', 'othermotors@example.com');
  customerId = idFrom(await a.post('/customers', { name: 'Larry Loan', phone: '0400 100 200', v_rego: 'LRY001' }));
  const v = await a.db.get(`SELECT id FROM vehicles WHERE rego = 'LRY001'`);
  jobId = idFrom(await a.post('/jobs', { vehicle_id: v.id, description: 'Clutch' }));
});

after(async () => {
  if (t) await t.stop();
});

test('loan cars are added and kept to their workshop', async () => {
  let res = await a.post('/loan-cars', { rego: 'loan1', make: 'Toyota', model: 'Corolla', odometer: '50000' });
  assert.equal(res.status, 302);
  const car = await a.db.get('SELECT * FROM loan_cars');
  carId = car.id;
  assert.equal(car.rego, 'LOAN1');
  assert.equal((await a.post('/loan-cars', { rego: '' })).status, 400);
  assert.equal((await b.get(`/loan-cars/${carId}/edit`)).status, 404);
  assert.doesNotMatch((await b.get('/loan-cars')).text, /LOAN1/);
  assert.match((await a.get('/loan-cars')).text, /LOAN1/);
});

test('a loan is booked from a job, and overlapping bookings are refused', async () => {
  const form = await a.get(`/loans/new?job_id=${jobId}`);
  assert.match(form.text, /For job/);
  let res = await a.post('/loans', { job_id: jobId, loan_car_id: carId, start_date: d0, due_date: addDays(d0, 2) });
  assert.equal(res.status, 302);
  const loan = await a.db.get('SELECT * FROM loans');
  assert.equal(loan.customer_id, customerId);
  assert.equal(loan.status, 'booked');
  assert.match((await a.get(`/jobs/${jobId}`)).text, /LOAN1/);

  const other = idFrom(await a.post('/customers', { name: 'Olive Other' }));
  res = await a.post('/loans', { customer_id: other, loan_car_id: carId, start_date: addDays(d0, 1), due_date: addDays(d0, 3) });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /booked for Larry Loan/);
  res = await a.post('/loans', { customer_id: other, loan_car_id: carId, start_date: addDays(d0, 3), due_date: addDays(d0, 4) });
  assert.equal(res.status, 302, 'the days after are free');
  // Another workshop can't book this car, or lend to this customer.
  res = await b.post('/loans', { customer_id: customerId, loan_car_id: carId, start_date: d0, due_date: d0 });
  assert.equal(res.status, 400);
});

test('handover needs a licence and agreed terms; return records the odometer and fuel', async () => {
  const loan = await a.db.get('SELECT * FROM loans WHERE customer_id = $1', [customerId]);
  let res = await a.post(`/loans/${loan.id}/out`, { licence_no: '', terms: '1' });
  assert.match(res.headers.get('location'), /error=Enter/);
  res = await a.post(`/loans/${loan.id}/out`, { licence_no: '12345678', odometer: '50010', fuel: 'F' });
  assert.match(res.headers.get('location'), /error=The%20customer%20needs/);
  res = await a.post(`/loans/${loan.id}/out`, { licence_no: '12345678', licence_expiry: addDays(d0, -1), terms: '1' });
  assert.match(res.headers.get('location'), /expired/);
  res = await a.post(`/loans/${loan.id}/out`, { licence_no: '12345678', licence_expiry: addDays(d0, 900), odometer: '50010', fuel: '3/4', notes: 'Scratch rear bumper', terms: '1' });
  let row = await a.db.get('SELECT * FROM loans WHERE id = $1', [loan.id]);
  assert.equal(row.status, 'out');
  assert.equal(row.out_fuel, '3/4');
  assert.ok(row.terms_agreed_at);

  const print = await a.get(`/loans/${loan.id}/print`);
  assert.match(print.text, /LOAN CAR AGREEMENT/);
  assert.match(print.text, /12345678/);
  assert.match(print.text, /traffic, toll, speeding and parking fines/);

  res = await a.post(`/loans/${loan.id}/back`, { odometer: '40000' });
  assert.match(res.headers.get('location'), /lower/);
  await a.post(`/loans/${loan.id}/back`, { odometer: '50123', fuel: '1/2', notes: 'Fine' });
  row = await a.db.get('SELECT * FROM loans WHERE id = $1', [loan.id]);
  assert.equal(row.status, 'returned');
  assert.equal((await a.db.get('SELECT odometer FROM loan_cars WHERE id = $1', [carId])).odometer, 50123);
  const page = await a.get(`/loans/${loan.id}`);
  assert.match(page.text, /113 km driven/);
  assert.match(page.text, /went out 3\/4/);
  const events = await a.db.all(`SELECT text FROM job_events WHERE job_id = $1 AND kind = 'loan' ORDER BY id`, [jobId]);
  assert.deepEqual(events.map((e) => e.text.split(' ').slice(0, 3).join(' ')), ['Loan car LOAN1', 'Loan car handed', 'Loan car returned']);
});

test('a car that is still out blocks new bookings until it comes back', async () => {
  const cust = idFrom(await a.post('/customers', { name: 'Sid Slow' }));
  await a.post('/loans', { customer_id: cust, loan_car_id: carId, start_date: addDays(d0, 10), due_date: addDays(d0, 10) });
  const loan = await a.db.get('SELECT * FROM loans WHERE customer_id = $1', [cust]);
  await a.post(`/loans/${loan.id}/out`, { licence_no: 'X1', terms: '1' });
  const res = await a.post('/loans', { customer_id: customerId, loan_car_id: carId, start_date: addDays(d0, 20), due_date: addDays(d0, 21) });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /out with Sid Slow/);
});

test('looking up who had a car on a day', async () => {
  const page = await a.get(`/loan-cars?on=${d0}`);
  assert.match(page.text, /LOAN1<\/strong>: <a href="\/customers\/\d+">Larry Loan<\/a>, licence 12345678/);
  const none = await a.get(`/loan-cars?on=${addDays(d0, -30)}`);
  assert.match(none.text, /None of the loan cars were out/);
});
