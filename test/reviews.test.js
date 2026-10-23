// Google review requests: the setting, asking from an invoice, and the email sent when an invoice is paid.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { startApp, idFrom } = require('./helpers');
const reviews = require('../lib/reviews');

let t;
let owner;
let fake;
const sent = [];

before(async () => {
  const f = express();
  f.use(express.json());
  f.post('/emails', (req, res) => {
    sent.push(req.body);
    res.json({ id: 'em_1' });
  });
  const url = await new Promise((r) => {
    fake = f.listen(0, () => r(`http://localhost:${fake.address().port}`));
  });
  Object.assign(process.env, { RESEND_API_KEY: 're_test', EMAIL_FROM: 'Workshop <invoices@example.com>', RESEND_API_URL: url });
  t = await startApp({ autoSync: false });
  owner = await t.signup('Star Motors', 'stars@example.com');
});

after(async () => {
  for (const k of ['RESEND_API_KEY', 'EMAIL_FROM', 'RESEND_API_URL']) delete process.env[k];
  if (t) await t.stop();
  if (fake) fake.close();
});

async function invoiceFor(rego, dollars) {
  const v = await owner.db.get('SELECT id FROM vehicles WHERE rego = $1', [rego]);
  const id = idFrom(await owner.post('/documents', { type: 'invoice', vehicle_id: v.id }));
  await owner.post(`/documents/${id}`, {
    'lines[0][kind]': 'labour', 'lines[0][description]': 'Service', 'lines[0][qty]': '1', 'lines[0][price]': String(dollars), 'lines[0][gst]': '1',
  });
  return id;
}

test('review links and the message', () => {
  assert.equal(reviews.reviewLink(''), '');
  assert.equal(reviews.reviewLink('https://g.page/r/CabcDEF/review'), 'https://g.page/r/CabcDEF/review');
  assert.equal(reviews.reviewLink('ChIJN1t_tDeuEmsRUsoyG83frY4'), 'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4');
  assert.equal(reviews.reviewLink('http://example.com'), null);
  assert.equal(reviews.reviewLink('not a link'), null);
  const settings = { business_name: 'Star Motors', review_url: 'https://g.page/r/x/review', review_message: '' };
  assert.equal(
    reviews.message(settings, { customer_name: 'Rita Stars', make: 'Ford', model: 'Ranger' }),
    'Hi Rita, thanks for choosing Star Motors. If you were happy with the work on your Ford Ranger, a quick Google review would really help us out: https://g.page/r/x/review'
  );
  assert.equal(reviews.smsHref('0400 111 222', 'Hi & bye'), 'sms:0400111222?&body=Hi%20%26%20bye');
});

test('settings: a bad link is refused, a good one saved, and the invoice offers to ask', async () => {
  assert.match((await owner.get('/settings')).text, /href="\/settings\/reviews"/);
  let res = await owner.post('/settings/reviews', { review_url: 'http://nope.example', review_auto: '1' });
  assert.equal(res.headers.get('location'), '/settings/reviews?error=link');

  await owner.post('/customers', { name: 'Rita Stars', email: 'rita@example.com', phone: '0400 111 222', v_rego: 'STAR01', v_make: 'Ford', v_model: 'Ranger' });
  const inv = await invoiceFor('STAR01', 200);
  assert.match((await owner.get(`/documents/${inv}`)).text, /Add your Google review link under/);

  res = await owner.post('/settings/reviews', { review_url: 'https://g.page/r/star/review', review_message: 'Hi {first}, rate us: {link}' });
  assert.equal(res.headers.get('location'), '/settings/reviews?saved=1');
  const page = (await owner.get('/settings/reviews')).text;
  assert.match(page, /Preview: Hi Sam, rate us: https:\/\/g.page\/r\/star\/review/);

  const html = (await owner.get(`/documents/${inv}`)).text;
  assert.match(html, /Ask for a review by email/);
  assert.match(html, /href="sms:0400111222\?&amp;body=Hi%20Rita%2C%20rate%20us%3A%20https%3A%2F%2Fg.page%2Fr%2Fstar%2Freview" data-then-submit>Ask by text/);

  // By text: just recorded. By email: sent and recorded.
  await owner.post(`/documents/${inv}/review`, { via: 'sms' });
  assert.equal((await owner.db.get('SELECT review_via FROM documents WHERE id = $1', [inv])).review_via, 'sms');
  await owner.post(`/documents/${inv}/review`, { via: 'email' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to[0], 'rita@example.com');
  assert.equal(sent[0].text.split('\n')[0], 'Hi Rita, rate us: https://g.page/r/star/review');
  assert.match(sent[0].html, /<a href="https:\/\/g.page\/r\/star\/review">/);
  assert.match((await owner.get(`/documents/${inv}`)).text, /Asked by email on/);
  assert.match((await owner.get('/settings/reviews')).text, /1 in the last 30 days, 1 in all/);
});

test('paid in full: one email on its own when switched on, not twice, and not for part payments', async () => {
  await owner.post('/settings/reviews', { review_url: 'https://g.page/r/star/review', review_auto: '1', review_message: '' });
  await owner.post('/customers', { name: 'Paul Payer', email: 'paul@example.com', v_rego: 'STAR02', v_make: 'Kia', v_model: 'Rio' });
  const inv = await invoiceFor('STAR02', 100); // $110 inc GST
  const before = sent.length;

  await owner.post(`/documents/${inv}/payments`, { amount: '50', method: 'Cash' });
  assert.equal(sent.length, before, 'not paid yet');
  await owner.post(`/documents/${inv}/payments`, { amount: '60', method: 'Cash' });
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).to[0], 'paul@example.com');
  assert.match(sent.at(-1).text, /^Hi Paul, thanks for choosing Star Motors\. If you were happy with the work on your Kia Rio/);
  assert.equal((await owner.db.get('SELECT review_via FROM documents WHERE id = $1', [inv])).review_via, 'auto');

  // Paid on a link page too: the share page shows the review button.
  const share = (await owner.get(`/documents/${inv}`)).text.match(/\/share\/([a-f0-9]{32})/)[1];
  assert.match((await t.client().get(`/share/${share}`)).text, /href="https:\/\/g.page\/r\/star\/review"[^>]*>Happy with the job\?/);

  // The same customer's next invoice, paid soon after: not asked again.
  const second = await invoiceFor('STAR02', 50);
  await owner.post(`/documents/${second}/payments`, { amount: '55', method: 'Card' });
  assert.equal(sent.length, before + 1);

  // Switched off: nothing.
  await owner.post('/settings/reviews', { review_url: 'https://g.page/r/star/review' });
  await owner.post('/customers', { name: 'Quiet Quinn', email: 'quinn@example.com', v_rego: 'STAR03' });
  const third = await invoiceFor('STAR03', 100);
  await owner.post(`/documents/${third}/payments`, { amount: '110', method: 'Card' });
  assert.equal(sent.length, before + 1);
});

test('paid online through the invoice link: the review email goes too', async () => {
  await owner.post('/settings/reviews', { review_url: 'https://g.page/r/star/review', review_auto: '1' });
  await owner.post('/settings/payments', { pay_provider: 'test' });
  await owner.post('/customers', { name: 'Olive Online', email: 'olive@example.com', v_rego: 'STAR04', v_make: 'Honda', v_model: 'Jazz' });
  const inv = await invoiceFor('STAR04', 100);
  const token = (await owner.get(`/documents/${inv}`)).text.match(/\/share\/([a-f0-9]{32})/)[1];
  const anon = t.client();
  const session = decodeURIComponent((await anon.post(`/share/${token}/pay`)).headers.get('location').split('session=')[1]);
  const before = sent.length;
  await anon.post(`/share/${token}/pay/test`, { session, outcome: 'paid' });
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).to[0], 'olive@example.com');
});
