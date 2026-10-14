// Subscription billing through Stripe. Each workshop gets a free trial, then pays
// monthly. Stripe Checkout takes the card, the customer portal handles changes and
// cancellations, and webhooks keep the workshop's status up to date.
//
// Needs STRIPE_SECRET_KEY, STRIPE_PRICE_ID (a recurring price) and STRIPE_WEBHOOK_SECRET.
const crypto = require('crypto');

const TRIAL_DAYS = 14;
// Stripe keeps retrying a failed card for a while; the workshop stays open meanwhile.
const PAST_DUE_GRACE_DAYS = 7;

const apiBase = () => process.env.STRIPE_API_URL || 'https://api.stripe.com';

function configured() {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
}

class StripeError extends Error {}

// Flattens {a: {b: 1}, c: [x]} into Stripe's form encoding: a[b]=1, c[0]=x.
function encode(params, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(method, path, params) {
  const res = await fetch(`${apiBase()}/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params ? encode(params).toString() : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new StripeError((data.error && data.error.message) || `Stripe returned ${res.status}`);
  return data;
}

// Checks the Stripe-Signature header on a webhook body.
function verifySignature(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(
    String(header || '')
      .split(',')
      .map((p) => p.split('=').map((s) => s.trim()))
      .filter((p) => p.length === 2)
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Used by tests to build a valid header.
function signPayload(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}

// What a workshop's row says about whether it may use the app.
function standing(ws, now = new Date()) {
  const status = ws.subscription_status;
  const trialLeftMs = new Date(ws.trial_ends_at) - now;
  if (ws.status === 'closed') return { ok: false, reason: 'closed', label: 'Closed' };
  if (ws.status === 'comped') return { ok: true, reason: 'comped', label: 'Free' };
  if (status === 'active' || status === 'trialing') {
    return { ok: true, reason: status, label: ws.cancel_at_period_end ? 'Cancelling' : 'Subscribed' };
  }
  if (status === 'past_due') {
    const since = ws.current_period_end ? new Date(ws.current_period_end) : now;
    const ok = now - since < PAST_DUE_GRACE_DAYS * 864e5;
    return { ok, reason: 'past_due', label: 'Payment failed' };
  }
  if (status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired') {
    return { ok: false, reason: status, label: 'Cancelled' };
  }
  // No subscription yet: the free trial decides.
  if (trialLeftMs > 0) {
    return { ok: true, reason: 'trial', label: 'Free trial', trialDaysLeft: Math.ceil(trialLeftMs / 864e5) };
  }
  return { ok: false, reason: 'trial_ended', label: 'Trial ended' };
}

function createBilling(store) {
  const sys = store.system;
  const getWorkshop = (id) => sys.get('SELECT * FROM workshops WHERE id = $1', [id]);

  // Sends the owner to Stripe Checkout to start paying.
  async function checkoutUrl(ws, user, appUrl) {
    const trialLeftDays = Math.floor((new Date(ws.trial_ends_at) - Date.now()) / 864e5);
    const session = await stripe('POST', 'checkout/sessions', {
      mode: 'subscription',
      client_reference_id: String(ws.id),
      customer: ws.stripe_customer_id || undefined,
      customer_email: ws.stripe_customer_id ? undefined : user.email,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: {
        metadata: { workshop_id: String(ws.id) },
        // Whatever is left of the free trial carries over.
        trial_period_days: trialLeftDays >= 1 ? trialLeftDays : undefined,
      },
      allow_promotion_codes: true,
      success_url: `${appUrl}/billing?checkout=success`,
      cancel_url: `${appUrl}/billing?checkout=cancelled`,
    });
    return session.url;
  }

  // Stripe's own page for changing card, downloading receipts, cancelling.
  async function portalUrl(ws, appUrl) {
    const session = await stripe('POST', 'billing_portal/sessions', {
      customer: ws.stripe_customer_id,
      return_url: `${appUrl}/billing`,
    });
    return session.url;
  }

  async function applySubscription(sub) {
    const workshopId = Number(sub.metadata && sub.metadata.workshop_id);
    const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id;
    const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
    const where = workshopId ? 'id = $5' : 'stripe_customer_id = $5';
    await sys.run(
      `UPDATE workshops SET stripe_subscription_id = $1, subscription_status = $2, current_period_end = $3,
         cancel_at_period_end = $4, stripe_customer_id = COALESCE(NULLIF(stripe_customer_id, ''), $6)
       WHERE ${where}`,
      [sub.id, sub.status, periodEnd, Boolean(sub.cancel_at_period_end), workshopId || customer, customer || '']
    );
  }

  // Handles one verified webhook event. Returns what it did, for logs and tests.
  async function handleEvent(event) {
    const seen = await sys.get('INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id', [
      event.id,
      event.type,
    ]);
    if (!seen) return 'duplicate';
    const obj = event.data && event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': {
        const workshopId = Number(obj.client_reference_id);
        if (workshopId && obj.customer) {
          await sys.run(`UPDATE workshops SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id = ''`, [obj.customer, workshopId]);
        }
        // The subscription's own events carry the status; fetch it now so there's no gap.
        if (obj.subscription) await applySubscription(await stripe('GET', `subscriptions/${obj.subscription}`));
        return 'checkout';
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await applySubscription(obj);
        return 'subscription';
      case 'invoice.payment_failed':
        if (obj.customer) {
          await sys.run(`UPDATE workshops SET subscription_status = 'past_due' WHERE stripe_customer_id = $1 AND subscription_status IN ('active', 'trialing')`, [
            obj.customer,
          ]);
        }
        return 'payment_failed';
      default:
        return 'ignored';
    }
  }

  return { configured, checkoutUrl, portalUrl, handleEvent, getWorkshop, standing, TRIAL_DAYS };
}

module.exports = { createBilling, standing, verifySignature, signPayload, encode, TRIAL_DAYS, PAST_DUE_GRACE_DAYS };
