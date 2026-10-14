// Share links: customers open quotes and invoices without a login, accept quotes, and get emails.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { startApp, idFrom } = require('./helpers');

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
  Object.assign(process.env, { RESEND_API_KEY: 're_test', EMAIL_FROM: 'Workshop <invoices@example.com>', RESEND_API_URL: url, APP_URL: 'https://app.example.com' });
  t = await startApp({ autoSync: false });
  owner = await t.signup('Share Co', 'share@example.com');
});

after(async () => {
  for (const k of ['RESEND_API_KEY', 'EMAIL_FROM', 'RESEND_API_URL', 'APP_URL']) delete process.env[k];
  if (t) await t.stop();
  if (fake) fake.close();
});

test('a quote is shared by link, accepted by the customer, and emailed', async () => {
  await owner.post('/customers', { name: 'Shari Link', email: 'shari@example.com', phone: '0400 999 888', v_rego: 'SHR001' });
  const v = await owner.db.get(`SELECT id FROM vehicles WHERE rego = 'SHR001'`);
  const quoteId = idFrom(await owner.post('/documents', { type: 'quote', vehicle_id: v.id }));
  await owner.post(`/documents/${quoteId}`, {
    issue_date: '2026-10-14', due_date: '2026-11-14', status: 'draft', notes: 'Front brakes',
    'lines[0][kind]': 'labour', 'lines[0][description]': 'Labour', 'lines[0][qty]': '1', 'lines[0][price]': '150', 'lines[0][gst]': '1',
  });
  const page = await owner.get(`/documents/${quoteId}`);
  const link = page.text.match(/https:\/\/app\.example\.com\/share\/([a-f0-9]{32})/);
  assert.ok(link, 'share link shown');
  const token = link[1];
  assert.equal(page.text.match(new RegExp(token, 'g')).length >= 1, true);

  // Public page, no login.
  const anon = t.client();
  let pub = await anon.get(`/share/${token}`);
  assert.equal(pub.status, 200);
  assert.match(pub.text, /QUOTE/);
  assert.match(pub.text, /Shari Link/);
  assert.match(pub.text, /\$165\.00/);
  assert.match(pub.text, /Accept this quote/);
  assert.equal((await anon.get('/share/0000000000000000000000000000ffff')).status, 404);
  assert.equal((await anon.get('/share/nope')).status, 404);

  // Email it: the quote becomes "sent".
  let res = await owner.post(`/documents/${quoteId}/send`, { via: 'email', to: 'shari@example.com' });
  assert.equal(res.headers.get('location'), `/documents/${quoteId}?sent=1`);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to[0], 'shari@example.com');
  assert.match(sent[0].subject, /Quote Q1001 from Share Co/);
  assert.match(sent[0].text, new RegExp(`/share/${token}`));
  let q = await owner.db.get('SELECT * FROM documents WHERE id = $1', [quoteId]);
  assert.equal(q.status, 'sent');
  assert.equal(q.sent_via, 'email');
  assert.match((await owner.get(`/documents/${quoteId}`)).text, /Last sent by email to shari@example.com/);

  // Customer accepts.
  res = await anon.post(`/share/${token}/accept`);
  assert.equal(res.status, 302);
  q = await owner.db.get('SELECT * FROM documents WHERE id = $1', [quoteId]);
  assert.equal(q.status, 'accepted');
  assert.ok(q.customer_accepted_at);
  pub = await anon.get(`/share/${token}?accepted=1`);
  assert.match(pub.text, /Quote accepted\. Thanks!/);
  assert.match((await owner.get(`/documents/${quoteId}`)).text, /Accepted online by the customer/);

  // Invoices share too, and a bad address is refused.
  const invId = idFrom(await owner.post(`/documents/${quoteId}/invoice`));
  res = await owner.post(`/documents/${invId}/send`, { via: 'email', to: 'not-an-email' });
  assert.match(res.headers.get('location'), /error=/);
  await owner.post(`/documents/${invId}/send`, { via: 'sms' });
  const inv = await owner.db.get('SELECT * FROM documents WHERE id = $1', [invId]);
  assert.equal(inv.sent_via, 'sms');
  assert.equal(inv.sent_to, '0400 999 888');
  const invPage = await owner.get(`/documents/${invId}`);
  const invToken = invPage.text.match(/\/share\/([a-f0-9]{32})/)[1];
  assert.notEqual(invToken, token);
  assert.match((await anon.get(`/share/${invToken}`)).text, /TAX INVOICE/);
  assert.equal((await anon.post(`/share/${invToken}/accept`)).status, 404);
});
