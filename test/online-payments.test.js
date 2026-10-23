// Customers paying invoices online: Stripe Checkout with the workshop's own key, and test mode.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { startApp, idFrom } = require('./helpers');

let t;
let a;
let b;
let fake;
let invoiceId;
let token;
const sessions = {};
const created = [];

before(async () => {
  const f = express();
  f.use(express.urlencoded({ extended: false }));
  f.post('/v1/checkout/sessions', (req, res) => {
    const id = `cs_test_${created.length + 1}`;
    created.push({ auth: req.headers.authorization, ...req.body });
    sessions[id] = { id, url: `https://checkout.stripe.test/${id}`, status: 'open', payment_status: 'unpaid', amount_total: Number(req.body['line_items[0][price_data][unit_amount]']) };
    res.json(sessions[id]);
  });
  f.get('/v1/checkout/sessions/:id', (req, res) => {
    const s = sessions[req.params.id];
    if (!s) return res.status(404).json({ error: { message: 'No such session' } });
    res.json({ ...s, payment_intent: { payment_method: { type: s.pm || 'card' } } });
  });
  const url = await new Promise((r) => {
    fake = f.listen(0, () => r(`http://localhost:${fake.address().port}`));
  });
  Object.assign(process.env, { STRIPE_API_URL: url, APP_URL: 'https://app.example.com' });
  t = await startApp({ autoSync: false });
  a = await t.signup('Paid Motors', 'paid@example.com');
  b = await t.signup('Unpaid Motors', 'unpaid@example.com');
  await a.post('/customers', { name: 'Penny Pay', email: 'penny@example.com', v_rego: 'PAY001' });
  const v = await a.db.get(`SELECT id FROM vehicles WHERE rego = 'PAY001'`);
  invoiceId = idFrom(await a.post('/documents', { type: 'invoice', vehicle_id: v.id }));
  await a.post(`/documents/${invoiceId}`, {
    issue_date: '2026-10-20', due_date: '2026-10-27', notes: '',
    'lines[0][kind]': 'labour', 'lines[0][description]': 'Service', 'lines[0][qty]': '1', 'lines[0][price]': '200', 'lines[0][gst]': '1',
  });
  token = (await a.get(`/documents/${invoiceId}`)).text.match(/\/share\/([a-f0-9]{32})/)[1];
});

after(async () => {
  for (const k of ['STRIPE_API_URL', 'APP_URL']) delete process.env[k];
  if (t) await t.stop();
  if (fake) fake.close();
});

test('no Pay now button until the workshop turns payments on', async () => {
  const pub = await t.client().get(`/share/${token}`);
  assert.equal(pub.status, 200);
  assert.doesNotMatch(pub.text, /Pay \$220\.00 now/);
  const res = await t.client().post(`/share/${token}/pay`);
  assert.equal(res.status, 400);
});

test('the key is checked and never shown back in full', async () => {
  let res = await a.post('/settings/payments', { pay_provider: 'stripe', pay_stripe_key: 'hello' });
  assert.match(res.headers.get('location'), /error=/);
  res = await a.post('/settings/payments', { pay_provider: 'stripe', pay_stripe_key: '' });
  assert.match(res.headers.get('location'), /error=Paste/);
  res = await a.post('/settings/payments', { pay_provider: 'stripe', pay_stripe_key: 'sk_test_abcdefghijklmnop1234' });
  assert.equal(res.headers.get('location'), '/settings/payments?saved=1');
  const page = await a.get('/settings/payments');
  assert.match(page.text, /sk_test_…1234/);
  assert.doesNotMatch(page.text, /abcdefghijklmnop/);
  // Saving again without a key keeps it.
  await a.post('/settings/payments', { pay_provider: 'stripe', pay_stripe_key: '' });
  assert.equal((await a.db.get('SELECT pay_stripe_key FROM settings')).pay_stripe_key, 'sk_test_abcdefghijklmnop1234');
});

test('a customer pays by Stripe and it lands on the invoice once', async () => {
  const anon = t.client();
  let pub = await anon.get(`/share/${token}`);
  assert.match(pub.text, /Pay \$220\.00 now/);
  let res = await anon.post(`/share/${token}/pay`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://checkout.stripe.test/cs_test_1');
  const c = created[0];
  assert.equal(c.auth, 'Bearer sk_test_abcdefghijklmnop1234');
  assert.equal(c['line_items[0][price_data][unit_amount]'], '22000');
  assert.equal(c['line_items[0][price_data][currency]'], 'aud');
  assert.equal(c.customer_email, 'penny@example.com');
  assert.equal(c.success_url, `https://app.example.com/share/${token}?session={CHECKOUT_SESSION_ID}`);
  assert.equal(c.payment_method_types, undefined, 'Stripe picks the methods, so Afterpay and Zip show when switched on');

  // Coming back before it's paid records nothing.
  res = await anon.get(`/share/${token}?session=cs_test_1`);
  assert.equal(res.location, `/share/${token}?paid=0`);
  assert.equal((await a.db.all('SELECT * FROM payments')).length, 0);

  Object.assign(sessions.cs_test_1, { status: 'complete', payment_status: 'paid', pm: 'afterpay_clearpay' });
  res = await anon.get(`/share/${token}?session=cs_test_1`);
  assert.equal(res.location, `/share/${token}?paid=1`);
  await anon.get(`/share/${token}?session=cs_test_1`);
  const paid = await a.db.all('SELECT * FROM payments');
  assert.equal(paid.length, 1);
  assert.equal(paid[0].amount_cents, 22000);
  assert.equal(paid[0].method, 'Afterpay online (Stripe)');
  pub = await anon.get(`/share/${token}?paid=1`);
  assert.match(pub.text, /Payment received/);
  assert.doesNotMatch(pub.text, /Pay \$[\d.]+ now/, 'nothing left to pay');
  assert.equal((await anon.post(`/share/${token}/pay`)).status, 400);
});

test('a customer who closes the tab is picked up when the invoice is opened', async () => {
  await a.db.run('DELETE FROM payments');
  await a.db.run(`UPDATE online_payments SET status = 'pending', payment_id = NULL`);
  // A fresh unpaid checkout, then paid without coming back.
  await t.client().post(`/share/${token}/pay`);
  Object.assign(sessions.cs_test_1, { status: 'expired', payment_status: 'unpaid' });
  Object.assign(sessions.cs_test_2, { status: 'complete', payment_status: 'paid' });
  const page = await a.get(`/documents/${invoiceId}`);
  assert.match(page.text, /Card online \(Stripe\)/);
  assert.equal((await a.db.all('SELECT * FROM payments')).length, 1);
  assert.equal((await a.db.get(`SELECT status FROM online_payments WHERE session_id = 'cs_test_1'`)).status, 'expired');
  assert.equal((await b.db.all('SELECT * FROM online_payments')).length, 0);
});

test('test mode takes a pretend payment', async () => {
  await a.db.run('DELETE FROM payments');
  await a.post('/settings/payments', { pay_provider: 'test' });
  const anon = t.client();
  const res = await anon.post(`/share/${token}/pay`);
  const loc = res.headers.get('location');
  assert.match(loc, new RegExp(`^https://app.example.com/share/${token}/pay/test\\?session=test_`));
  const session = decodeURIComponent(loc.split('session=')[1]);
  const page = await anon.get(`/share/${token}/pay/test?session=${encodeURIComponent(session)}`);
  assert.match(page.text, /Test mode: no money moves/);
  let r = await anon.post(`/share/${token}/pay/test`, { session, outcome: 'failed' });
  assert.equal(r.headers.get('location'), `/share/${token}?paid=0`);
  r = await anon.post(`/share/${token}/pay/test`, { session, outcome: 'paid' });
  assert.equal(r.headers.get('location'), `/share/${token}?paid=1`);
  const p = await a.db.get('SELECT * FROM payments');
  assert.equal(p.method, 'Card online (test)');
  assert.equal(p.amount_cents, 22000);
});
