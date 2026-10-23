// Customers paying an invoice online from its share link. Each workshop is paid into its
// own account, so each workshop enters its own provider key under Settings -> Online payments.
//   stripe  Stripe Checkout with the workshop's secret key: cards, Apple Pay and Google Pay,
//           plus Afterpay and Zip once switched on in the workshop's Stripe dashboard.
//   test    test mode: a pretend checkout page, no money moves. Only on test sites
//           (SEED_DEMO=1) and in development.
const { money, docNumber, today } = require('./util');

const testAllowed = () => process.env.SEED_DEMO === '1' || process.env.NODE_ENV !== 'production';
const stripeBase = () => process.env.STRIPE_API_URL || 'https://api.stripe.com';

function providerFor(settings) {
  if (settings.pay_provider === 'stripe' && settings.pay_stripe_key) return 'stripe';
  if (settings.pay_provider === 'test' && testAllowed()) return 'test';
  return '';
}

async function stripe(key, method, path, form) {
  const res = await fetch(`${stripeBase()}/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `Stripe error ${res.status}`);
  return data;
}

// Starts a payment for what's owing; returns the address to send the customer to.
async function startCheckout(db, { settings, doc, customerEmail, shareUrl }) {
  const provider = providerFor(settings);
  if (!provider) throw new Error('This workshop does not take payments online.');
  if (doc.type !== 'invoice' || doc.status === 'void' || doc.balance <= 0) throw new Error('Nothing to pay on this invoice.');
  const amount = doc.balance;
  if (provider === 'test') {
    const row = await db.get(
      `INSERT INTO online_payments (document_id, provider, session_id, amount_cents) VALUES ($1, 'test', $2, $3) RETURNING *`,
      [doc.id, `test_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, amount]
    );
    return `${shareUrl}/pay/test?session=${encodeURIComponent(row.session_id)}`;
  }
  const session = await stripe(settings.pay_stripe_key, 'POST', 'checkout/sessions', {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'aud',
    'line_items[0][price_data][unit_amount]': String(amount),
    'line_items[0][price_data][product_data][name]': `Invoice ${docNumber(doc)} from ${settings.business_name}`.slice(0, 250),
    success_url: `${shareUrl}?session={CHECKOUT_SESSION_ID}`,
    cancel_url: shareUrl,
    client_reference_id: String(doc.id),
    'metadata[invoice]': docNumber(doc),
    'payment_intent_data[description]': `Invoice ${docNumber(doc)}`,
    ...(customerEmail ? { customer_email: customerEmail } : {}),
  });
  await db.run(`INSERT INTO online_payments (document_id, provider, session_id, amount_cents) VALUES ($1, 'stripe', $2, $3)`, [doc.id, session.id, amount]);
  return session.url;
}

// Checks a started payment with the provider and, if it went through, records it on the
// invoice. Safe to call more than once: a session is only ever recorded once.
async function settle(db, settings, sessionId, { testPaid = false } = {}) {
  return db.tx(async (tx) => {
    const row = await tx.get(`SELECT * FROM online_payments WHERE session_id = $1 FOR UPDATE`, [String(sessionId || '')]);
    if (!row || row.status !== 'pending') return row;
    let paid = false;
    let amount = row.amount_cents;
    let label = 'Card online';
    if (row.provider === 'test') {
      paid = testPaid;
      label = 'Card online (test)';
    } else if (row.provider === 'stripe') {
      const s = await stripe(settings.pay_stripe_key, 'GET', `checkout/sessions/${encodeURIComponent(row.session_id)}?expand[]=payment_intent.payment_method`);
      if (s.status === 'expired') {
        await tx.run(`UPDATE online_payments SET status = 'expired' WHERE id = $1`, [row.id]);
        return { ...row, status: 'expired' };
      }
      paid = s.payment_status === 'paid';
      amount = s.amount_total || amount;
      const pm = s.payment_intent && s.payment_intent.payment_method;
      const kind = pm && pm.type ? { card: 'Card', afterpay_clearpay: 'Afterpay', zip: 'Zip', link: 'Link' }[pm.type] || pm.type : 'Card';
      label = `${kind} online (Stripe)`;
    }
    if (!paid) return row;
    const p = await tx.get(
      `INSERT INTO payments (document_id, date, amount_cents, method, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [row.document_id, today(settings.timezone), amount, label, require('./util').now(settings.timezone)]
    );
    await tx.run(`UPDATE online_payments SET status = 'paid', paid_at = now(), payment_id = $1, amount_cents = $2 WHERE id = $3`, [p.id, amount, row.id]);
    return { ...row, status: 'paid', amount_cents: amount, label };
  });
}

// Payments started in the last day that haven't come back yet, e.g. a customer who
// paid and closed the tab before returning to the invoice.
async function settlePending(db, settings, documentId) {
  const rows = await db.all(
    `SELECT session_id FROM online_payments WHERE document_id = $1 AND status = 'pending' AND provider = 'stripe' AND created_at > now() - interval '1 day'`,
    [documentId]
  );
  let n = 0;
  for (const r of rows) {
    try {
      if ((await settle(db, settings, r.session_id)).status === 'paid') n++;
    } catch (err) {
      console.error(`Checking online payment ${r.session_id}: ${err.message}`);
    }
  }
  return n;
}

module.exports = { providerFor, testAllowed, startCheckout, settle, settlePending, money };
