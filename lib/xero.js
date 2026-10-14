// Xero connection (OAuth 2) and one-way sync: customers, invoices and payments go
// from the workshop app to Xero. Nothing is pulled back.
//
// Needs XERO_CLIENT_ID and XERO_CLIENT_SECRET from a Xero app (developer.xero.com),
// with redirect URI <APP_URL>/xero/callback.
const crypto = require('crypto');
const { getLines } = require('./db');
const { getDoc } = require('./docs');
const { lineGst, docNumber, vehicleLabel, now } = require('./util');

const PROVIDER = 'xero';
// Granular scopes: required for Xero apps created after 2 March 2026.
const DEFAULT_SCOPES =
  'openid profile email offline_access accounting.invoices accounting.payments accounting.contacts accounting.settings.read';

const DEFAULT_CONFIG = {
  labour_account: '200',
  parts_account: '200',
  other_account: '200',
  payment_account: '',
  connection_id: '',
};

const urls = () => ({
  login: process.env.XERO_LOGIN_URL || 'https://login.xero.com',
  identity: process.env.XERO_IDENTITY_URL || 'https://identity.xero.com',
  api: process.env.XERO_API_URL || 'https://api.xero.com',
});

function configured() {
  return Boolean(process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET);
}

class XeroError extends Error {
  constructor(message, { status, rateLimited, authLost } = {}) {
    super(message);
    this.status = status;
    this.rateLimited = Boolean(rateLimited);
    this.authLost = Boolean(authLost);
  }
}

// Pulls the useful sentence out of Xero's validation error responses.
function describeError(body, status) {
  if (body && typeof body === 'object') {
    const messages = [];
    for (const el of body.Elements || []) {
      for (const v of el.ValidationErrors || []) messages.push(v.Message);
    }
    if (messages.length) return messages.join(' ');
    if (body.Detail) return body.Detail;
    if (body.Message) return body.Message;
    if (body.error) return body.error_description || body.error;
  }
  return `Xero returned ${status}`;
}

function createXero(db) {
  const getRow = () => db.prepare('SELECT * FROM integrations WHERE provider = ?').get(PROVIDER);

  function state() {
    const row = getRow();
    const config = { ...DEFAULT_CONFIG, ...(row ? JSON.parse(row.config || '{}') : {}) };
    return { row, config, connected: Boolean(row && row.refresh_token && row.tenant_id) };
  }

  function saveTokens(tokens) {
    const expiresAt = Date.now() + (Number(tokens.expires_in) || 1800) * 1000;
    db.prepare(
      `INSERT INTO integrations (provider, access_token, refresh_token, expires_at, connected_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (provider) DO UPDATE SET access_token = excluded.access_token,
         refresh_token = excluded.refresh_token, expires_at = excluded.expires_at`
    ).run(PROVIDER, tokens.access_token, tokens.refresh_token || '', expiresAt, now());
  }

  function saveConfig(changes) {
    const { config } = state();
    db.prepare(
      `INSERT INTO integrations (provider, config) VALUES (?, ?)
       ON CONFLICT (provider) DO UPDATE SET config = excluded.config`
    ).run(PROVIDER, JSON.stringify({ ...config, ...changes }));
  }

  function setTenant(tenantId, tenantName, connectionId) {
    db.prepare('UPDATE integrations SET tenant_id = ?, tenant_name = ?, connected_at = ? WHERE provider = ?').run(
      tenantId,
      tenantName,
      now(),
      PROVIDER
    );
    saveConfig({ connection_id: connectionId || '' });
  }

  function forget() {
    db.prepare(
      `UPDATE integrations SET access_token = '', refresh_token = '', expires_at = 0, tenant_id = '', tenant_name = ''
       WHERE provider = ?`
    ).run(PROVIDER);
  }

  async function tokenRequest(fields) {
    const basic = Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString('base64');
    const res = await fetch(`${urls().identity}/connect/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new XeroError(describeError(body, res.status), { status: res.status, authLost: body.error === 'invalid_grant' });
    }
    return body;
  }

  function authorizeUrl(redirectUri, stateToken) {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.XERO_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: process.env.XERO_SCOPES || DEFAULT_SCOPES,
      state: stateToken,
    });
    return `${urls().login}/identity/connect/authorize?${q}`;
  }

  // After the owner approves in Xero: swap the code for tokens and list their organisations.
  async function finishConnect(code, redirectUri) {
    saveTokens(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }));
    const res = await fetch(`${urls().api}/connections`, {
      headers: { authorization: `Bearer ${getRow().access_token}`, accept: 'application/json' },
    });
    const list = await res.json().catch(() => []);
    if (!res.ok) throw new XeroError(describeError(list, res.status), { status: res.status });
    const orgs = list.filter((c) => !c.tenantType || c.tenantType === 'ORGANISATION');
    if (orgs.length === 1) setTenant(orgs[0].tenantId, orgs[0].tenantName, orgs[0].id);
    return orgs;
  }

  async function accessToken() {
    const row = getRow();
    if (!row || !row.refresh_token) throw new XeroError('Xero is not connected.', { authLost: true });
    if (row.access_token && row.expires_at - 60_000 > Date.now()) return row.access_token;
    try {
      // Xero rotates the refresh token on every use, so save the new one straight away.
      saveTokens(await tokenRequest({ grant_type: 'refresh_token', refresh_token: row.refresh_token }));
    } catch (err) {
      if (err.authLost) forget();
      throw err;
    }
    return getRow().access_token;
  }

  async function api(method, path, body) {
    const token = await accessToken();
    const res = await fetch(`${urls().api}/api.xro/2.0/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'xero-tenant-id': getRow().tenant_id,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) throw new XeroError('Xero rate limit reached; will retry.', { status: 429, rateLimited: true });
    if (res.status === 401) throw new XeroError('Xero sign-in expired. Reconnect Xero.', { status: 401, authLost: true });
    if (!res.ok) throw new XeroError(describeError(data, res.status), { status: res.status });
    return data;
  }

  async function disconnect() {
    const { config, connected } = state();
    if (connected && config.connection_id) {
      try {
        const token = await accessToken();
        await fetch(`${urls().api}/connections/${config.connection_id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        });
      } catch {
        // Still forget the tokens locally; the owner can remove the app in Xero too.
      }
    }
    forget();
  }

  // ---- Sync bookkeeping ----

  const getLink = (entity, localId) =>
    db.prepare('SELECT * FROM sync_links WHERE provider = ? AND entity = ? AND local_id = ?').get(PROVIDER, entity, localId);

  function setLink(entity, localId, fields) {
    db.prepare(
      `INSERT INTO sync_links (provider, entity, local_id, parent_id, remote_id, hash, status, error, synced_at)
       VALUES (@provider, @entity, @local_id, @parent_id, @remote_id, @hash, @status, @error, @synced_at)
       ON CONFLICT (provider, entity, local_id) DO UPDATE SET parent_id = excluded.parent_id,
         remote_id = excluded.remote_id, hash = excluded.hash, status = excluded.status,
         error = excluded.error, synced_at = excluded.synced_at`
    ).run({
      provider: PROVIDER,
      entity,
      local_id: localId,
      parent_id: null,
      remote_id: '',
      hash: '',
      status: 'pending',
      error: '',
      synced_at: null,
      ...getLink(entity, localId),
      ...fields,
    });
  }

  function markPending(entity, localId) {
    setLink(entity, localId, { status: 'pending', error: '' });
  }

  // Remember a synced payment that was removed here, so it is removed from Xero too.
  function forgetPayment(paymentId) {
    const link = getLink('payment', paymentId);
    if (link && link.remote_id) setLink('payment', paymentId, { status: 'delete' });
    else if (link) db.prepare('DELETE FROM sync_links WHERE provider = ? AND entity = ? AND local_id = ?').run(PROVIDER, 'payment', paymentId);
  }

  // ---- Pushing records ----

  async function pushContact(customerId) {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    const link = getLink('contact', customerId);
    const contact = {
      Name: c.name,
      EmailAddress: c.email || undefined,
      Phones: c.phone ? [{ PhoneType: 'MOBILE', PhoneNumber: c.phone }] : undefined,
      Addresses: c.address ? [{ AddressType: 'POBOX', AddressLine1: c.address }] : undefined,
    };
    let remoteId = link && link.remote_id;
    if (!remoteId) {
      // Xero contact names are unique, so reuse a contact that already has this name.
      const where = `Name=="${c.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      const found = await api('GET', `Contacts?where=${encodeURIComponent(where)}`);
      remoteId = found.Contacts && found.Contacts[0] ? found.Contacts[0].ContactID : '';
    }
    const res = await api('POST', 'Contacts', { Contacts: [{ ...(remoteId ? { ContactID: remoteId } : {}), ...contact }] });
    remoteId = res.Contacts[0].ContactID;
    setLink('contact', customerId, { remote_id: remoteId, status: 'synced', error: '', synced_at: now() });
    return remoteId;
  }

  function invoicePayload(doc, lines, contactId, config) {
    const account = { labour: config.labour_account, part: config.parts_account, other: config.other_account };
    return {
      Type: 'ACCREC',
      Contact: { ContactID: contactId },
      InvoiceNumber: docNumber(doc),
      Reference: [vehicleLabel(doc), doc.notes].filter(Boolean).join(' · ').slice(0, 255),
      Date: doc.issue_date,
      DueDate: doc.due_date || doc.issue_date,
      LineAmountTypes: 'Exclusive',
      Status: 'AUTHORISED',
      LineItems: lines.map((l) => ({
        Description: l.description || '(no description)',
        Quantity: l.qty,
        UnitAmount: l.unit_cents / 100,
        AccountCode: account[l.kind] || config.other_account,
        TaxType: l.gst ? 'OUTPUT' : 'EXEMPTOUTPUT',
        TaxAmount: lineGst(l) / 100,
      })),
    };
  }

  const hashOf = (obj) => crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex');

  async function deleteRemotePayment(link) {
    await api('POST', `Payments/${link.remote_id}`, { Status: 'DELETED' });
    db.prepare('DELETE FROM sync_links WHERE provider = ? AND entity = ? AND local_id = ?').run(PROVIDER, 'payment', link.local_id);
  }

  async function syncInvoice(docId) {
    const { config } = state();
    const doc = getDoc(db, docId);
    if (!doc || doc.type !== 'invoice') {
      db.prepare('DELETE FROM sync_links WHERE provider = ? AND entity = ? AND local_id = ?').run(PROVIDER, 'invoice', docId);
      return;
    }
    let link = getLink('invoice', docId) || {};
    const paymentLinks = () =>
      db.prepare(`SELECT * FROM sync_links WHERE provider = ? AND entity = 'payment' AND parent_id = ?`).all(PROVIDER, docId);

    // Payments removed here come off in Xero first.
    for (const p of paymentLinks().filter((p) => p.status === 'delete')) await deleteRemotePayment(p);

    if (doc.status === 'void') {
      if (link.remote_id && link.hash !== 'void') {
        // Xero only voids an invoice with no payments on it.
        for (const p of paymentLinks().filter((p) => p.remote_id)) await deleteRemotePayment(p);
        await api('POST', 'Invoices', { Invoices: [{ InvoiceID: link.remote_id, Status: 'VOIDED' }] });
      }
      setLink('invoice', docId, { hash: 'void', status: 'synced', error: '', synced_at: now() });
      return;
    }
    if (link.hash === 'void') {
      // Restored after being voided in Xero: Xero can't un-void, so send it as a new invoice.
      for (const p of paymentLinks()) await deleteRemotePayment(p).catch(() => {});
      link = {};
      setLink('invoice', docId, { remote_id: '', hash: '' });
    }

    if (!link.remote_id && getLines(db, 'document', docId).length === 0) {
      // Nothing to send until it has items; saving it again queues it.
      setLink('invoice', docId, { status: 'skipped', error: '' });
      return;
    }

    const contactLink = getLink('contact', doc.customer_id);
    const contactId = contactLink && contactLink.remote_id && contactLink.status === 'synced'
      ? contactLink.remote_id
      : await pushContact(doc.customer_id);
    const lines = getLines(db, 'document', docId);
    const payload = invoicePayload(doc, lines, contactId, config);
    const hash = hashOf(payload);

    if (!link.remote_id || link.hash !== hash) {
      // Xero won't change an invoice that has payments, so take them off and put them back after.
      const synced = paymentLinks().filter((p) => p.remote_id);
      for (const p of synced) await deleteRemotePayment(p);
      const res = await api('POST', 'Invoices', {
        Invoices: [{ ...(link.remote_id ? { InvoiceID: link.remote_id } : {}), ...payload }],
      });
      setLink('invoice', docId, { remote_id: res.Invoices[0].InvoiceID, hash, status: 'synced', error: '', synced_at: now() });
      link = getLink('invoice', docId);
    }

    // Payments recorded here that Xero doesn't have yet.
    const payments = db.prepare('SELECT * FROM payments WHERE document_id = ? ORDER BY date, id').all(docId);
    const unsent = payments.filter((p) => {
      const pl = getLink('payment', p.id);
      return !pl || !pl.remote_id;
    });
    if (unsent.length && !config.payment_account) {
      setLink('invoice', docId, {
        status: 'synced',
        error: 'Payments not sent: choose the Xero bank account for payments under Settings, Xero.',
      });
      return;
    }
    for (const p of unsent) {
      if (p.amount_cents <= 0) continue; // Refunds are entered in Xero directly.
      const res = await api('PUT', 'Payments', {
        Payments: [
          {
            Invoice: { InvoiceID: link.remote_id },
            Account: { Code: config.payment_account },
            Date: p.date,
            Amount: p.amount_cents / 100,
            Reference: p.method || undefined,
          },
        ],
      });
      setLink('payment', p.id, {
        parent_id: docId,
        remote_id: res.Payments[0].PaymentID,
        status: 'synced',
        error: '',
        synced_at: now(),
      });
    }
  }

  // ---- Queue ----

  let running = null;
  let timer = null;

  async function runPending({ retryErrors = false } = {}) {
    if (running) return running;
    running = (async () => {
      const result = { synced: 0, failed: 0, stopped: '' };
      if (!state().connected) return { ...result, stopped: 'not connected' };
      const statuses = retryErrors ? `('pending', 'error')` : `('pending')`;
      const contacts = db
        .prepare(`SELECT local_id FROM sync_links WHERE provider = ? AND entity = 'contact' AND status IN ${statuses}`)
        .all(PROVIDER);
      const invoices = db
        .prepare(
          `SELECT local_id FROM sync_links WHERE provider = ? AND entity = 'invoice' AND status IN ${statuses} ORDER BY local_id`
        )
        .all(PROVIDER);
      const jobs = [
        ...contacts.map((r) => ['contact', r.local_id, () => pushContact(r.local_id)]),
        ...invoices.map((r) => ['invoice', r.local_id, () => syncInvoice(r.local_id)]),
      ];
      for (const [entity, id, fn] of jobs) {
        try {
          if (entity === 'contact' && !db.prepare('SELECT id FROM customers WHERE id = ?').get(id)) {
            db.prepare(`DELETE FROM sync_links WHERE provider = ? AND entity = 'contact' AND local_id = ?`).run(PROVIDER, id);
            continue;
          }
          await fn();
          result.synced++;
        } catch (err) {
          if (err.rateLimited || err.authLost) {
            result.stopped = err.message;
            break;
          }
          result.failed++;
          setLink(entity, id, { status: 'error', error: err.message });
        }
      }
      return result;
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  // Called after anything changes an invoice; syncs a moment later in the background.
  function queueInvoice(docId) {
    if (!state().connected) return;
    const doc = db.prepare('SELECT type FROM documents WHERE id = ?').get(docId);
    if (!doc || doc.type !== 'invoice') return;
    markPending('invoice', docId);
    schedule();
  }

  function queueContact(customerId) {
    const link = getLink('contact', customerId);
    if (!state().connected || !link || !link.remote_id) return; // New contacts go with their first invoice.
    markPending('contact', customerId);
    schedule();
  }

  function queuePaymentDeleted(paymentId, docId) {
    if (!state().connected) return;
    forgetPayment(paymentId);
    queueInvoice(docId);
  }

  let autoSync = true;
  function schedule() {
    if (!autoSync) return;
    clearTimeout(timer);
    timer = setTimeout(() => runPending().catch((err) => console.error('Xero sync failed:', err)), 1500);
    timer.unref?.();
  }

  // Queue every invoice that has never been sent (used right after connecting).
  function queueAll(sinceDate) {
    const docs = db
      .prepare(
        `SELECT d.id FROM documents d
         WHERE d.type = 'invoice' AND d.issue_date >= ?
           AND NOT EXISTS (SELECT 1 FROM sync_links s WHERE s.provider = ? AND s.entity = 'invoice' AND s.local_id = d.id)`
      )
      .all(sinceDate || '0000-01-01', PROVIDER);
    docs.forEach((d) => markPending('invoice', d.id));
    if (docs.length) schedule();
    return docs.length;
  }

  function invoiceStatus(docId) {
    return getLink('invoice', docId) || null;
  }

  function problems() {
    return db
      .prepare(
        `SELECT s.*, d.number, d.type FROM sync_links s
         LEFT JOIN documents d ON s.entity = 'invoice' AND d.id = s.local_id
         WHERE s.provider = ? AND (s.status = 'error' OR s.error != '') ORDER BY s.local_id DESC LIMIT 50`
      )
      .all(PROVIDER);
  }

  function counts() {
    return db
      .prepare(`SELECT status, COUNT(*) AS n FROM sync_links WHERE provider = ? AND entity = 'invoice' GROUP BY status`)
      .all(PROVIDER)
      .reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});
  }

  return {
    configured,
    state,
    saveConfig,
    authorizeUrl,
    finishConnect,
    setTenant,
    disconnect,
    syncInvoice,
    pushContact,
    runPending,
    queueInvoice,
    queueContact,
    queuePaymentDeleted,
    queueAll,
    invoiceStatus,
    problems,
    counts,
    setAutoSync: (on) => (autoSync = on),
  };
}

module.exports = { createXero, XeroError, DEFAULT_SCOPES };
