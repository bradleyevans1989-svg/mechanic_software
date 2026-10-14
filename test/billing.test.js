// Subscription billing against a fake Stripe: trial, checkout, webhooks, lock-out.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { startApp } = require('./helpers');
const { signPayload, standing } = require('../lib/stripe');

const WEBHOOK_SECRET = 'whsec_test';
let t;
let fake;
let owner;
let staff;
const stripeState = { checkouts: [], portals: [], subscriptions: {} };

function startFake() {
  const f = express();
  f.use(express.urlencoded({ extended: true }));
  f.post('/v1/checkout/sessions', (req, res) => {
    stripeState.checkouts.push(req.body);
    res.json({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
  });
  f.post('/v1/billing_portal/sessions', (req, res) => {
    stripeState.portals.push(req.body);
    res.json({ url: 'https://portal.stripe.test/' + req.body.customer });
  });
  f.get('/v1/subscriptions/:id', (req, res) => {
    const s = stripeState.subscriptions[req.params.id];
    if (!s) return res.status(404).json({ error: { message: 'No such subscription' } });
    res.json(s);
  });
  return new Promise((r) => {
    fake = f.listen(0, () => r(`http://localhost:${fake.address().port}`));
  });
}

async function sendEvent(event, { sign = true, secret = WEBHOOK_SECRET } = {}) {
  const body = JSON.stringify(event);
  const res = await fetch(`${t.base}/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sign ? { 'stripe-signature': signPayload(body, secret) } : {}) },
    body,
  });
  return res.status;
}

let eventNo = 0;
const event = (type, object) => ({ id: `evt_${++eventNo}`, type, data: { object } });

before(async () => {
  const url = await startFake();
  Object.assign(process.env, {
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_PRICE_ID: 'price_monthly',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_API_URL: url,
    PLAN_PRICE_LABEL: '$49/month',
  });
  t = await startApp({ autoSync: false });
  owner = await t.signup('Trial Tyres', 'owner@trial.example');
  await owner.post('/staff', { name: 'Tess', email: 'tess@trial.example', role: 'staff', password: 'wheel-brace' });
  staff = t.client();
  const res = await staff.post('/login', { email: 'tess@trial.example', password: 'wheel-brace' });
  staff.cookie = res.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_API_URL', 'PLAN_PRICE_LABEL']) delete process.env[k];
  if (t) await t.stop();
  if (fake) fake.close();
});

test('standing rules', () => {
  const soon = new Date(Date.now() + 3 * 864e5);
  const past = new Date(Date.now() - 864e5);
  assert.equal(standing({ status: 'trial', subscription_status: '', trial_ends_at: soon }).reason, 'trial');
  assert.equal(standing({ status: 'trial', subscription_status: '', trial_ends_at: soon }).trialDaysLeft, 3);
  assert.equal(standing({ status: 'trial', subscription_status: '', trial_ends_at: past }).ok, false);
  assert.equal(standing({ status: 'trial', subscription_status: 'active', trial_ends_at: past }).ok, true);
  assert.equal(standing({ status: 'trial', subscription_status: 'canceled', trial_ends_at: past }).ok, false);
  assert.equal(standing({ status: 'trial', subscription_status: 'past_due', trial_ends_at: past, current_period_end: past }).ok, true);
  assert.equal(standing({ status: 'trial', subscription_status: 'past_due', trial_ends_at: past, current_period_end: new Date(Date.now() - 10 * 864e5) }).ok, false);
  assert.equal(standing({ status: 'comped', subscription_status: '', trial_ends_at: past }).ok, true);
  assert.equal(standing({ status: 'closed', subscription_status: 'active', trial_ends_at: soon }).ok, false);
});

test('new workshop is on a 14 day trial and can reach the app', async () => {
  const page = await owner.get('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /Free trial: 14 days left/);
  const billing = await owner.get('/billing');
  assert.match(billing.text, /14 days.*left/);
  assert.match(billing.text, /Subscribe · \$49\/month/);
  assert.equal((await staff.get('/billing')).status, 403);
});

test('subscribe sends the owner to Stripe Checkout with the trial carried over', async () => {
  const res = await owner.post('/billing/checkout');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://checkout.stripe.test/cs_1');
  const c = stripeState.checkouts[0];
  assert.equal(c.mode, 'subscription');
  assert.equal(c.client_reference_id, String(owner.workshopId));
  assert.equal(c.customer_email, 'owner@trial.example');
  assert.equal(c.line_items[0].price, 'price_monthly');
  assert.equal(c.subscription_data.trial_period_days, '13');
  assert.equal(c.subscription_data.metadata.workshop_id, String(owner.workshopId));
  assert.match(c.success_url, /\/billing\?checkout=success$/);
});

test('webhooks need a valid signature and are not applied twice', async () => {
  assert.equal(await sendEvent(event('customer.subscription.updated', {}), { sign: false }), 400);
  assert.equal(await sendEvent(event('customer.subscription.updated', {}), { secret: 'wrong' }), 400);
  const e = event('ping', {});
  assert.equal(await sendEvent(e), 200);
  assert.equal(await sendEvent(e), 200);
  assert.equal((await t.store.system.all('SELECT * FROM stripe_events WHERE id = $1', [e.id])).length, 1);
});

test('checkout completes: workshop gets its Stripe customer and subscription', async () => {
  stripeState.subscriptions.sub_1 = {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'trialing',
    current_period_end: Math.floor(Date.now() / 1000) + 13 * 86400,
    cancel_at_period_end: false,
    metadata: { workshop_id: String(owner.workshopId) },
  };
  assert.equal(
    await sendEvent(event('checkout.session.completed', { client_reference_id: String(owner.workshopId), customer: 'cus_1', subscription: 'sub_1' })),
    200
  );
  const ws = await t.store.system.get('SELECT * FROM workshops WHERE id = $1', [owner.workshopId]);
  assert.equal(ws.stripe_customer_id, 'cus_1');
  assert.equal(ws.stripe_subscription_id, 'sub_1');
  assert.equal(ws.subscription_status, 'trialing');
  const page = await owner.get('/billing');
  assert.match(page.text, /Subscribed/);
  assert.match(page.text, /Manage card, receipts or cancel/);
  assert.doesNotMatch(page.text, /Free trial:/);

  const portal = await owner.post('/billing/portal');
  assert.equal(portal.headers.get('location'), 'https://portal.stripe.test/cus_1');
});

test('subscription events update status; a cancelled workshop is locked for staff and sent to billing for owners', async () => {
  await sendEvent(event('customer.subscription.updated', { ...stripeState.subscriptions.sub_1, status: 'active', cancel_at_period_end: true }));
  let ws = await t.store.system.get('SELECT * FROM workshops WHERE id = $1', [owner.workshopId]);
  assert.equal(ws.subscription_status, 'active');
  assert.equal(ws.cancel_at_period_end, true);
  assert.match((await owner.get('/billing')).text, /set to cancel/);

  await sendEvent(event('invoice.payment_failed', { customer: 'cus_1' }));
  ws = await t.store.system.get('SELECT * FROM workshops WHERE id = $1', [owner.workshopId]);
  assert.equal(ws.subscription_status, 'past_due');
  assert.equal((await owner.get('/customers')).status, 200); // grace period
  assert.match((await owner.get('/')).text, /last payment failed/);

  await sendEvent(event('customer.subscription.deleted', { ...stripeState.subscriptions.sub_1, status: 'canceled' }));
  assert.equal((await owner.get('/customers')).location, '/billing');
  assert.equal((await owner.get('/billing')).status, 200);
  assert.equal((await owner.get('/account')).status, 200);
  const blocked = await staff.get('/customers');
  assert.equal(blocked.status, 402);
  assert.match(blocked.text, /Ask the workshop owner/);

  // Subscribing again from the billing page reuses the Stripe customer.
  await owner.post('/billing/checkout');
  const c = stripeState.checkouts.at(-1);
  assert.equal(c.customer, 'cus_1');
  assert.equal(c.customer_email, undefined);
});

test('an expired trial with no subscription is locked too, and a comped workshop never is', async () => {
  const other = await t.signup('Old Trial', 'old@trial.example');
  await t.store.system.run(`UPDATE workshops SET trial_ends_at = now() - interval '1 day' WHERE id = $1`, [other.workshopId]);
  assert.equal((await other.get('/jobs')).location, '/billing');
  assert.match((await other.get('/billing')).text, /trial has ended/);
  await t.store.system.run(`UPDATE workshops SET status = 'comped' WHERE id = $1`, [other.workshopId]);
  assert.equal((await other.get('/jobs')).status, 200);
});
