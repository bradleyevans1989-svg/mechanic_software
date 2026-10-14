// Runs the Xero sync against a fake Xero, to check what gets sent and when.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { open } = require('../lib/db');
const { createApp } = require('../app');
const util = require('../lib/util');

let fake;
let server;
let base;
let db;
let app;
let cookie = '';

// A tiny stand-in for Xero's identity and accounting APIs.
const xeroState = { calls: [], contacts: [], invoices: {}, payments: {}, refreshes: 0, failNextInvoice: null };

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
    xeroState.payments[id] = { InvoiceID: p.Invoice.InvoiceID, Amount: p.Amount, Account: p.Account.Code, Status: 'AUTHORISED' };
    res.json({ Payments: [{ PaymentID: id }] });
  });
  f.post('/api.xro/2.0/Payments/:id', (req, res) => {
    xeroState.payments[req.params.id].Status = req.body.Status;
    res.json({ Payments: [{ PaymentID: req.params.id }] });
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
    SETUP_CODE: 'x',
    XERO_CLIENT_ID: 'client',
    XERO_CLIENT_SECRET: 'secret',
    XERO_LOGIN_URL: fakeUrl,
    XERO_IDENTITY_URL: fakeUrl,
    XERO_API_URL: fakeUrl,
  });
  db = open(':memory:');
  app = createApp(db, { autoSync: false });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
  const res = await post('/setup', { code: 'x', name: 'Brad', email: 'brad@example.com', password: 'spanner-123' });
  cookie = res.headers.get('set-cookie').split(';')[0];
});

after(() => {
  server.close();
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
  assert.equal(app.locals.xero.state().connected, true);

  const page = await get('/integrations');
  assert.match(page.text, /Connected to <strong>Demo Motors Pty Ltd/);
  await post('/xero/settings', { labour_account: '210', parts_account: '200', other_account: '200', payment_account: '' });
});

test('invoice, contact and payment go to Xero; edits and voids follow', async () => {
  const xero = app.locals.xero;
  const cid = db.prepare(`INSERT INTO customers (name, email, phone, created_at) VALUES ('Sam "Sparky" Taylor', 'sam@example.com', '0412 345 678', ?)`).run(util.now()).lastInsertRowid;
  let res = await post('/documents', { type: 'invoice', customer_id: cid });
  const docId = Number(res.headers.get('location').split('/').pop());

  // Empty invoice isn't sent.
  await post(`/documents/${docId}`, { issue_date: '2026-10-14', due_date: '2026-10-21' });
  await xero.runPending();
  assert.equal(Object.keys(xeroState.invoices).length, 0);

  await post(`/documents/${docId}`, {
    issue_date: '2026-10-14',
    due_date: '2026-10-21',
    'lines[0][kind]': 'labour', 'lines[0][description]': 'Labour', 'lines[0][qty]': '1.5', 'lines[0][price]': '120', 'lines[0][gst]': '1',
    'lines[1][kind]': 'part', 'lines[1][description]': 'Oil filter', 'lines[1][qty]': '1', 'lines[1][price]': '18.15', 'lines[1][gst]': '1',
    'lines[2][kind]': 'other', 'lines[2][description]': 'Rego check', 'lines[2][qty]': '1', 'lines[2][price]': '10', 'lines[2][gst]': '0',
  });
  let r = await xero.runPending();
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
  xero.queueInvoice(docId);
  await xero.runPending();
  assert.equal(xeroState.calls.filter((c, i) => i >= before && c.startsWith('POST /api.xro/2.0/Invoices')).length, 0);

  // Payment without a bank account code is held back with a clear message.
  await post(`/documents/${docId}/payments`, { amount: '100', method: 'EFTPOS', date: '2026-10-14' });
  await xero.runPending();
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
  r = await xero.runPending();
  assert.equal(r.failed, 0);
  assert.equal(Object.keys(xeroState.invoices).length, 1);
  assert.equal(xinv().LineItems.length, 1);
  assert.equal(livePayments(inv.InvoiceID).length, 1);

  // Removing the payment here removes it in Xero.
  const pay = db.prepare('SELECT id FROM payments WHERE document_id = ?').get(docId);
  await post(`/documents/${docId}/payments/${pay.id}/delete`, {});
  await xero.runPending();
  assert.equal(livePayments(inv.InvoiceID).length, 0);

  // Customer edit updates the Xero contact.
  await post(`/customers/${cid}`, { name: 'Sam "Sparky" Taylor', phone: '0499 999 999', email: 'sam@example.com' });
  await xero.runPending();
  assert.equal(xeroState.contacts[0].Phones[0].PhoneNumber, '0499 999 999');

  // Void.
  await post(`/documents/${docId}/void`, {});
  await xero.runPending();
  assert.equal(xinv().Status, 'VOIDED');
});

test('a Xero error is shown on the invoice and retried on request', async () => {
  const xero = app.locals.xero;
  const c = db.prepare(`SELECT id FROM customers LIMIT 1`).get();
  const res = await post('/documents', { type: 'invoice', customer_id: c.id });
  const docId = Number(res.headers.get('location').split('/').pop());
  xeroState.failNextInvoice = 'Account code 999 is not valid';
  await post(`/documents/${docId}`, {
    issue_date: '2026-10-14',
    'lines[0][kind]': 'part', 'lines[0][description]': 'Wiper blades', 'lines[0][qty]': '2', 'lines[0][price]': '15', 'lines[0][gst]': '1',
  });
  const r = await xero.runPending();
  assert.equal(r.failed, 1);
  const page = await get(`/documents/${docId}`);
  assert.match(page.text, /Account code 999 is not valid/);
  assert.match((await get('/integrations')).text, /Needs attention/);

  await post(`/documents/${docId}/xero`, {});
  assert.equal(xero.invoiceStatus(docId).status, 'synced');
});

test('expired access token is refreshed and the new refresh token kept', async () => {
  const xero = app.locals.xero;
  db.prepare(`UPDATE integrations SET expires_at = 0 WHERE provider = 'xero'`).run();
  const oldRefresh = xero.state().row.refresh_token;
  const before = xeroState.refreshes;
  await xero.pushContact(db.prepare('SELECT id FROM customers LIMIT 1').get().id);
  assert.equal(xeroState.refreshes, before + 1);
  assert.notEqual(xero.state().row.refresh_token, oldRefresh);
});

test('disconnect forgets the tokens', async () => {
  await post('/xero/disconnect', {});
  assert.equal(app.locals.xero.state().connected, false);
  assert.match((await get('/integrations')).text, /Connect to Xero/);
});
