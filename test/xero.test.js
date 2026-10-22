// Runs the Xero sync against a fake Xero, to check what gets sent and when.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const util = require('../lib/util');
const { getDoc } = require('../lib/docs');
const { startApp } = require('./helpers');

let fake;
let t;
let base;
let db;
let app;
let owner;
let cookie = '';

// A tiny stand-in for Xero's identity and accounting APIs.
const xeroState = { calls: [], contacts: [], invoices: {}, payments: {}, paymentListings: [], refreshes: 0, failNextInvoice: null };

// A payment entered in Xero itself, or matched from the bank feed.
function payInXero(invoiceId, amount, date, reference) {
  const id = `xero-payment-${Object.keys(xeroState.payments).length + 1}`;
  xeroState.payments[id] = { InvoiceID: invoiceId, Amount: amount, Account: '090', Status: 'AUTHORISED', Date: date, Reference: reference, Updated: Date.now() };
  return id;
}

function startFake() {
  const f = express();
  f.use(express.json());
  f.use(express.urlencoded({ extended: false }));
  const log = (req, _res, next) => {
    xeroState.calls.push(`${req.method} ${req.path}`);
    next();
  };
  f.use(log);
  f.post('/connect/token', (req, res) => {
    if (req.body.grant_type === 'refresh_token') xeroState.refreshes++;
    res.json({ access_token: `at-${Date.now()}`, refresh_token: `rt-${Math.random()}`, expires_in: 1800 });
  });
  f.get('/connections', (req, res) => res.json([{ id: 'conn-1', tenantId: 'tenant-1', tenantName: 'Demo Motors Pty Ltd', tenantType: 'ORGANISATION' }]));
  f.delete('/connections/:id', (req, res) => res.status(204).end());
  f.use('/api.xro/2.0', (req, res, next) => {
    if (req.get('xero-tenant-id') !== 'tenant-1' || !/^Bearer at-/.test(req.get('authorization') || '')) {
      return res.status(401).json({ Detail: 'Unauthorised' });
    }
    next();
  });
  f.get('/api.xro/2.0/Contacts', (req, res) => {
    const m = /Name=="(.*)"/.exec(req.query.where || '');
    res.json({ Contacts: xeroState.contacts.filter((c) => m && c.Name === m[1]) });
  });
  f.post('/api.xro/2.0/Contacts', (req, res) => {
    const c = req.body.Contacts[0];
    let existing = c.ContactID && xeroState.contacts.find((x) => x.ContactID === c.ContactID);
    if (existing) Object.assign(existing, c);
    else xeroState.contacts.push((existing = { ...c, ContactID: `contact-${xeroState.contacts.length + 1}` }));
    res.json({ Contacts: [existing] });
  });
  f.post('/api.xro/2.0/Invoices', (req, res) => {
    if (xeroState.failNextInvoice) {
      const msg = xeroState.failNextInvoice;
      xeroState.failNextInvoice = null;
      return res.status(400).json({ Elements: [{ ValidationErrors: [{ Message: msg }] }] });
    }
    const inv = req.body.Invoices[0];
    const id = inv.InvoiceID || `invoice-${Object.keys(xeroState.invoices).length + 1}`;
    if (inv.InvoiceID && Object.values(xeroState.payments).some((p) => p.InvoiceID === id && p.Status !== 'DELETED')) {
      return res.status(400).json({ Elements: [{ ValidationErrors: [{ Message: 'Invoice has payments' }] }] });
    }
    xeroState.invoices[id] = { ...(xeroState.invoices[id] || {}), ...inv, InvoiceID: id };
    res.json({ Invoices: [xeroState.invoices[id]] });
  });
  f.put('/api.xro/2.0/Payments', (req, res) => {
    const p = req.body.Payments[0];
    const id = `payment-${Object.keys(xeroState.payments).length + 1}`;
    xeroState.payments[id] = { InvoiceID: p.Invoice.InvoiceID, Amount: p.Amount, Account: p.Account.Code, Status: 'AUTHORISED', Date: p.Date, Updated: Date.now() };
    res.json({ Payments: [{ PaymentID: id }] });
  });
  f.post('/api.xro/2.0/Payments/:id', (req, res) => {
    Object.assign(xeroState.payments[req.params.id], { Status: req.body.Status, Updated: Date.now() });
    res.json({ Payments: [{ PaymentID: req.params.id }] });
  });
  // Lists payments the way Xero does: changed since If-Modified-Since, 100 to a page, with JSON dates.
  f.get('/api.xro/2.0/Payments', (req, res) => {
    xeroState.paymentListings.push({ since: req.get('if-modified-since'), where: req.query.where });
    const since = req.get('if-modified-since') ? Date.parse(req.get('if-modified-since')) : 0;
    const page = Number(req.query.page) || 1;
    const all = Object.entries(xeroState.payments)
      .filter(([, p]) => p.Updated >= since)
      .map(([id, p]) => ({
        PaymentID: id,
        Invoice: { InvoiceID: p.InvoiceID },
        Amount: p.Amount,
        Status: p.Status,
        Reference: p.Reference,
        PaymentType: 'ACCRECPAYMENT',
        Date: `/Date(${Date.parse(p.Date)}+0000)/`,
      }));
    res.json({ Payments: all.slice((page - 1) * 100, page * 100) });
  });
  return new Promise((r) => {
    fake = f.listen(0, () => r(`http://localhost:${fake.address().port}`));
  });
}

const livePayments = (invoiceId) =>
  Object.values(xeroState.payments).filter((p) => p.InvoiceID === invoiceId && p.Status !== 'DELETED');

function post(path, fields) {
  return fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(fields).toString(),
  });
}

async function get(path) {
  const res = await fetch(base + path, { headers: { cookie }, redirect: 'manual' });
  return { status: res.status, text: await res.text(), location: res.headers.get('location'), res };
}

before(async () => {
  const fakeUrl = await startFake();
  Object.assign(process.env, {
    XERO_CLIENT_ID: 'client',
    XERO_CLIENT_SECRET: 'secret',
    XERO_LOGIN_URL: fakeUrl,
    XERO_IDENTITY_URL: fakeUrl,
    XERO_API_URL: fakeUrl,
  });
  t = await startApp({ autoSync: false });
  app = t.app;
  base = t.base;
  owner = await t.signup('Demo Motors', 'brad@example.com');
  cookie = owner.cookie;
  db = owner.db;
});

after(async () => {
  await t.stop();
  fake.close();
});

test('connect to Xero with OAuth and pick up the organisation', async () => {
  const start = await get('/xero/connect');
  const url = new URL(start.location);
  assert.equal(url.pathname, '/identity/connect/authorize');
  assert.match(url.searchParams.get('scope'), /accounting\.invoices accounting\.payments accounting\.contacts/);
  assert.equal(url.searchParams.get('redirect_uri'), `${base}/xero/callback`);
  const state = url.searchParams.get('state');
  const stateCookie = start.res.headers.get('set-cookie').split(';')[0];

  // Wrong state is refused.
  let cb = await fetch(`${base}/xero/callback?code=abc&state=wrong`, { headers: { cookie: `${cookie}; ${stateCookie}` }, redirect: 'manual' });
  assert.match(cb.headers.get('location'), /error=/);

  cb = await fetch(`${base}/xero/callback?code=abc&state=${state}`, { headers: { cookie: `${cookie}; ${stateCookie}` }, redirect: 'manual' });
  assert.match(decodeURIComponent(cb.headers.get('location')), /Connected to Demo Motors Pty Ltd/);
  assert.equal(await app.locals.xero.isConnected(db), true);

  const page = await get('/integrations');
  assert.match(page.text, /Connected to <strong>Demo Motors Pty Ltd/);
  await post('/xero/settings', { labour_account: '210', parts_account: '200', other_account: '200', payment_account: '' });
});

test('invoice, contact and payment go to Xero; edits and voids follow', async () => {
  const xero = app.locals.xero;
  const cid = (await db.get(`INSERT INTO customers (name, email, phone, created_at) VALUES ('Sam "Sparky" Taylor', 'sam@example.com', '0412 345 678', $1) RETURNING id`, [util.now()])).id;
  let res = await post('/documents', { type: 'invoice', customer_id: cid });
  const docId = Number(res.headers.get('location').split('/').pop());

  // Empty invoice isn't sent.
  await post(`/documents/${docId}`, { issue_date: '2026-10-14', due_date: '2026-10-21' });
  await xero.runPending(db);
  assert.equal(Object.keys(xeroState.invoices).length, 0);

  await post(`/documents/${docId}`, {
    issue_date: '2026-10-14',
    due_date: '2026-10-21',
    'lines[0][kind]': 'labour', 'lines[0][description]': 'Labour', 'lines[0][qty]': '1.5', 'lines[0][price]': '120', 'lines[0][gst]': '1',
    'lines[1][kind]': 'part', 'lines[1][description]': 'Oil filter', 'lines[1][qty]': '1', 'lines[1][price]': '18.15', 'lines[1][gst]': '1',
    'lines[2][kind]': 'other', 'lines[2][description]': 'Rego check', 'lines[2][qty]': '1', 'lines[2][price]': '10', 'lines[2][gst]': '0',
  });
  let r = await xero.runPending(db);
  assert.equal(r.synced, 1);
  assert.equal(xeroState.contacts.length, 1);
  assert.equal(xeroState.contacts[0].Name, 'Sam "Sparky" Taylor');
  const invoiceId = Object.keys(xeroState.invoices)[0];
  const xinv = () => xeroState.invoices[invoiceId];
  const inv = xinv();
  assert.equal(inv.InvoiceNumber, 'INV-1001');
  assert.equal(inv.Type, 'ACCREC');
  assert.equal(inv.LineAmountTypes, 'Exclusive');
  assert.deepEqual(
    inv.LineItems.map((l) => [l.AccountCode, l.TaxType, l.UnitAmount, l.TaxAmount]),
    [['210', 'OUTPUT', 120, 18], ['200', 'OUTPUT', 18.15, 1.82], ['200', 'EXEMPTOUTPUT', 10, 0]]
  );
  // App total matches Xero's per-line GST: 180 + 18.15 + 10 = 208.15, GST 18 + 1.82 = 19.82.
  assert.match((await get(`/documents/${docId}`)).text, /\$227\.97/);

  // Nothing changed: nothing re-sent.
  const before = xeroState.calls.length;
  await xero.queueInvoice(db, docId);
  await xero.runPending(db);
  assert.equal(xeroState.calls.filter((c, i) => i >= before && c.startsWith('POST /api.xro/2.0/Invoices')).length, 0);

  // Payment without a bank account code is held back with a clear message.
  await post(`/documents/${docId}/payments`, { amount: '100', method: 'EFTPOS', date: '2026-10-14' });
  await xero.runPending(db);
  assert.equal(livePayments(inv.InvoiceID).length, 0);
  assert.match((await get(`/documents/${docId}`)).text, /Payments not sent/);

  await post('/xero/settings', { labour_account: '210', parts_account: '200', other_account: '200', payment_account: '090' });
  await post(`/documents/${docId}/xero`, {});
  assert.equal(livePayments(inv.InvoiceID).length, 1);
  assert.equal(livePayments(inv.InvoiceID)[0].Account, '090');

  // Editing a paid invoice: payment comes off, invoice updates, payment goes back on.
  await post(`/documents/${docId}`, {
    issue_date: '2026-10-14', due_date: '2026-10-21',
    'lines[0][kind]': 'labour', 'lines[0][description]': 'Labour', 'lines[0][qty]': '2', 'lines[0][price]': '120', 'lines[0][gst]': '1',
  });
  r = await xero.runPending(db);
  assert.equal(r.failed, 0);
  assert.equal(Object.keys(xeroState.invoices).length, 1);
  assert.equal(xinv().LineItems.length, 1);
  assert.equal(livePayments(inv.InvoiceID).length, 1);

  // Removing the payment here removes it in Xero.
  const pay = await db.get('SELECT id FROM payments WHERE document_id = $1', [docId]);
  await post(`/documents/${docId}/payments/${pay.id}/delete`, {});
  await xero.runPending(db);
  assert.equal(livePayments(inv.InvoiceID).length, 0);

  // Customer edit updates the Xero contact.
  await post(`/customers/${cid}`, { name: 'Sam "Sparky" Taylor', phone: '0499 999 999', email: 'sam@example.com' });
  await xero.runPending(db);
  assert.equal(xeroState.contacts[0].Phones[0].PhoneNumber, '0499 999 999');

  // Void.
  await post(`/documents/${docId}/void`, {});
  await xero.runPending(db);
  assert.equal(xinv().Status, 'VOIDED');
});

test('a Xero error is shown on the invoice and retried on request', async () => {
  const xero = app.locals.xero;
  const c = await db.get(`SELECT id FROM customers LIMIT 1`);
  const res = await post('/documents', { type: 'invoice', customer_id: c.id });
  const docId = Number(res.headers.get('location').split('/').pop());
  xeroState.failNextInvoice = 'Account code 999 is not valid';
  await post(`/documents/${docId}`, {
    issue_date: '2026-10-14',
    'lines[0][kind]': 'part', 'lines[0][description]': 'Wiper blades', 'lines[0][qty]': '2', 'lines[0][price]': '15', 'lines[0][gst]': '1',
  });
  const r = await xero.runPending(db);
  assert.equal(r.failed, 1);
  const page = await get(`/documents/${docId}`);
  assert.match(page.text, /Account code 999 is not valid/);
  assert.match((await get('/integrations')).text, /Needs attention/);

  await post(`/documents/${docId}/xero`, {});
  assert.equal((await xero.invoiceStatus(db, docId)).status, 'synced');
});

test('payments made in Xero come back and mark the invoice paid; deleting in Xero takes them off', async () => {
  const xero = app.locals.xero;
  await post('/xero/settings', { labour_account: '210', parts_account: '200', other_account: '200', payment_account: '090', pull_payments: '1' });
  const c = await db.get(`SELECT id FROM customers LIMIT 1`);
  const res = await post('/documents', { type: 'invoice', customer_id: c.id });
  const docId = Number(res.headers.get('location').split('/').pop());
  await post(`/documents/${docId}`, {
    issue_date: '2026-10-15', due_date: '2026-10-22',
    'lines[0][kind]': 'labour', 'lines[0][description]': 'Brake pads fitted', 'lines[0][qty]': '1', 'lines[0][price]': '200', 'lines[0][gst]': '1',
  });
  // A payment entered here goes to Xero and is not brought back as a second one.
  await post(`/documents/${docId}/payments`, { amount: '20', method: 'Cash', date: '2026-10-15' });
  await xero.runPending(db, { pull: true });
  const remoteId = (await xero.invoiceStatus(db, docId)).remote_id;
  assert.equal(livePayments(remoteId).length, 1);
  const paymentsHere = () => db.all('SELECT * FROM payments WHERE document_id = $1 ORDER BY id', [docId]);
  assert.equal((await paymentsHere()).length, 1);

  // The rest is reconciled from the bank feed in Xero.
  const xeroPaymentId = payInXero(remoteId, 200, '2026-10-20', 'Bank transfer SMITH');
  const syncPage = await post('/xero/sync', {});
  assert.match(decodeURIComponent(syncPage.headers.get('location')), /1 payment added from Xero/);
  let pays = await paymentsHere();
  assert.equal(pays.length, 2);
  assert.deepEqual([pays[1].date, pays[1].amount_cents, pays[1].method], ['2026-10-20', 20000, 'Xero: Bank transfer SMITH']);
  assert.equal((await getDoc(db, docId)).state, 'paid');
  // Only receive payments, and only what changed since last time.
  const listing = xeroState.paymentListings.at(-1);
  assert.match(listing.where, /ACCRECPAYMENT/);
  assert.ok(listing.since);

  // Looking again adds nothing twice, and nothing is sent back to Xero.
  const before = Object.keys(xeroState.payments).length;
  await xero.runPending(db, { pull: true });
  await xero.queueInvoice(db, docId);
  await xero.runPending(db, { pull: true });
  assert.equal((await paymentsHere()).length, 2);
  assert.equal(Object.keys(xeroState.payments).length, before);

  // Deleted in Xero: taken off here.
  Object.assign(xeroState.payments[xeroPaymentId], { Status: 'DELETED', Updated: Date.now() });
  await xero.runPending(db, { pull: true });
  pays = await paymentsHere();
  assert.equal(pays.length, 1);
  assert.equal(pays[0].method, 'Cash');

  // Payments on invoices this app never sent are ignored.
  payInXero('someone-elses-invoice', 50, '2026-10-20');
  const r = await xero.runPending(db, { pull: true });
  assert.equal(r.paymentsAdded, 0);

  // Turned off: nothing comes back.
  await post('/xero/settings', { labour_account: '210', parts_account: '200', other_account: '200', payment_account: '090' });
  payInXero(remoteId, 10, '2026-10-21');
  await xero.runPending(db, { pull: true });
  assert.equal((await paymentsHere()).length, 1);
});

test('tax types can be changed per workshop', async () => {
  const xero = app.locals.xero;
  await post('/xero/settings', { labour_account: '200', parts_account: '200', other_account: '200', payment_account: '090', gst_tax_type: 'output2', free_tax_type: 'EXEMPTOUTPUT' });
  const c = await db.get(`SELECT id FROM customers LIMIT 1`);
  const res = await post('/documents', { type: 'invoice', customer_id: c.id });
  const docId = Number(res.headers.get('location').split('/').pop());
  await post(`/documents/${docId}`, {
    issue_date: '2026-10-16',
    'lines[0][kind]': 'part', 'lines[0][description]': 'Battery', 'lines[0][qty]': '1', 'lines[0][price]': '180', 'lines[0][gst]': '1',
  });
  await xero.runPending(db);
  const inv = xeroState.invoices[(await xero.invoiceStatus(db, docId)).remote_id];
  assert.equal(inv.LineItems[0].TaxType, 'OUTPUT2');
});

test('Xero dates are read in either format', () => {
  const { xeroDate } = require('../lib/xero');
  assert.equal(xeroDate('/Date(1760918400000+0000)/'), '2025-10-20');
  assert.equal(xeroDate('2026-10-20T00:00:00'), '2026-10-20');
  assert.equal(xeroDate(''), null);
});

test('expired access token is refreshed and the new refresh token kept', async () => {
  const xero = app.locals.xero;
  await db.run(`UPDATE integrations SET expires_at = 0 WHERE provider = 'xero'`);
  const oldRefresh = (await xero.state(db)).row.refresh_token;
  const before = xeroState.refreshes;
  await xero.pushContact(db, (await db.get('SELECT id FROM customers LIMIT 1')).id);
  assert.equal(xeroState.refreshes, before + 1);
  assert.notEqual((await xero.state(db)).row.refresh_token, oldRefresh);
});

test('disconnect forgets the tokens', async () => {
  await post('/xero/disconnect', {});
  assert.equal(await app.locals.xero.isConnected(db), false);
  assert.match((await get('/integrations')).text, /Connect to Xero/);
});
