// Xero connection (OAuth 2) and one-way sync: customers, invoices and payments go
// from the workshop app to Xero. Nothing is pulled back.
//
// One Xero app (XERO_CLIENT_ID / XERO_CLIENT_SECRET from developer.xero.com) serves
// every workshop; each workshop connects its own Xero organisation. Its redirect URI
// is <APP_URL>/xero/callback.
//
// Every function takes `db`, a per-workshop handle from store.tenant(), so tokens
// and sync records are only ever read and written for that workshop.
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

// Pulls the useful sentence out of Xero's error responses.
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

const hashOf = (obj) => crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex');

function createXero(store) {
  // ---- Connection ----

  const getRow = (db) => db.get('SELECT * FROM integrations WHERE provider = $1', [PROVIDER]);

  async function state(db) {
    const row = await getRow(db);
    const config = { ...DEFAULT_CONFIG, ...(row ? JSON.parse(row.config || '{}') : {}) };
    return { row, config, connected: Boolean(row && row.refresh_token && row.tenant_id) };
  }

  const isConnected = async (db) => (await state(db)).connected;

  async function saveTokens(db, tokens) {
    const expiresAt = Date.now() + (Number(tokens.expires_in) || 1800) * 1000;
    await db.run(
      `INSERT INTO integrations (provider, access_token, refresh_token, expires_at, connected_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workshop_id, provider) DO UPDATE SET access_token = excluded.access_token,
         refresh_token = excluded.refresh_token, expires_at = excluded.expires_at`,
      [PROVIDER, tokens.access_token, tokens.refresh_token || '', expiresAt, now()]
    );
  }

  async function saveConfig(db, changes) {
    const { config } = await state(db);
    await db.run(
      `INSERT INTO integrations (provider, config) VALUES ($1, $2)
       ON CONFLICT (workshop_id, provider) DO UPDATE SET config = excluded.config`,
      [PROVIDER, JSON.stringify({ ...config, ...changes })]
    );
  }

  async function setTenant(db, tenantId, tenantName, connectionId) {
    await db.run('UPDATE integrations SET tenant_id = $1, tenant_name = $2, connected_at = $3 WHERE provider = $4', [
      tenantId,
      tenantName,
      now(),
      PROVIDER,
    ]);
    await saveConfig(db, { connection_id: connectionId || '', pending_orgs: null });
  }

  async function forget(db) {
    await db.run(
      `UPDATE integrations SET access_token = '', refresh_token = '', expires_at = 0, tenant_id = '', tenant_name = ''
       WHERE provider = $1`,
      [PROVIDER]
    );
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
  async function finishConnect(db, code, redirectUri) {
    await saveTokens(db, await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }));
    const res = await fetch(`${urls().api}/connections`, {
      headers: { authorization: `Bearer ${(await getRow(db)).access_token}`, accept: 'application/json' },
    });
    const list = await res.json().catch(() => []);
    if (!res.ok) throw new XeroError(describeError(list, res.status), { status: res.status });
    const orgs = list.filter((c) => !c.tenantType || c.tenantType === 'ORGANISATION');
    if (orgs.length === 1) await setTenant(db, orgs[0].tenantId, orgs[0].tenantName, orgs[0].id);
    return orgs;
  }

  // Refreshes are serialised per workshop: Xero rotates the refresh token on each use,
  // so two refreshes at once would leave one holding a dead token.
  const refreshing = new Map();

  async function accessToken(db) {
    const row = await getRow(db);
    if (!row || !row.refresh_token) throw new XeroError('Xero is not connected.', { authLost: true });
    if (row.access_token && row.expires_at - 60_000 > Date.now()) return row.access_token;
    if (!refreshing.has(db.workshopId)) {
      refreshing.set(
        db.workshopId,
        (async () => {
          try {
            await saveTokens(db, await tokenRequest({ grant_type: 'refresh_token', refresh_token: row.refresh_token }));
          } catch (err) {
            if (err.authLost) await forget(db);
            throw err;
          } finally {
            refreshing.delete(db.workshopId);
          }
        })()
      );
    }
    await refreshing.get(db.workshopId);
    return (await getRow(db)).access_token;
  }

  async function api(db, method, path, body) {
    const token = await accessToken(db);
    const res = await fetch(`${urls().api}/api.xro/2.0/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'xero-tenant-id': (await getRow(db)).tenant_id,
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

  async function disconnect(db) {
    const { config, connected } = await state(db);
    if (connected && config.connection_id) {
      try {
        const token = await accessToken(db);
        await fetch(`${urls().api}/connections/${config.connection_id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        });
      } catch {
        // Still forget the tokens here; the owner can remove the app in Xero too.
      }
    }
    await forget(db);
  }

  // ---- Sync bookkeeping ----

  const getLink = (db, entity, localId) =>
    db.get('SELECT * FROM sync_links WHERE provider = $1 AND entity = $2 AND local_id = $3', [PROVIDER, entity, localId]);

  const dropLink = (db, entity, localId) =>
    db.run('DELETE FROM sync_links WHERE provider = $1 AND entity = $2 AND local_id = $3', [PROVIDER, entity, localId]);

  async function setLink(db, entity, localId, fields) {
    const l = {
      parent_id: null,
      remote_id: '',
      hash: '',
      status: 'pending',
      error: '',
      synced_at: null,
      ...(await getLink(db, entity, localId)),
      ...fields,
    };
    await db.run(
      `INSERT INTO sync_links (provider, entity, local_id, parent_id, remote_id, hash, status, error, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (workshop_id, provider, entity, local_id) DO UPDATE SET parent_id = excluded.parent_id,
         remote_id = excluded.remote_id, hash = excluded.hash, status = excluded.status,
         error = excluded.error, synced_at = excluded.synced_at`,
      [PROVIDER, entity, localId, l.parent_id, l.remote_id, l.hash, l.status, String(l.error).slice(0, 1000), l.synced_at]
    );
  }

  // ---- Pushing records ----

  async function pushContact(db, customerId) {
    const c = await db.get('SELECT * FROM customers WHERE id = $1', [customerId]);
    if (!c) return dropLink(db, 'contact', customerId);
    const link = await getLink(db, 'contact', customerId);
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
      const found = await api(db, 'GET', `Contacts?where=${encodeURIComponent(where)}`);
      remoteId = found.Contacts && found.Contacts[0] ? found.Contacts[0].ContactID : '';
    }
    const res = await api(db, 'POST', 'Contacts', { Contacts: [{ ...(remoteId ? { ContactID: remoteId } : {}), ...contact }] });
    remoteId = res.Contacts[0].ContactID;
    await setLink(db, 'contact', customerId, { remote_id: remoteId, status: 'synced', error: '', synced_at: now() });
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

  async function deleteRemotePayment(db, link) {
    await api(db, 'POST', `Payments/${link.remote_id}`, { Status: 'DELETED' });
    await dropLink(db, 'payment', link.local_id);
  }

  async function syncInvoice(db, docId) {
    const { config } = await state(db);
    const doc = await getDoc(db, docId);
    if (!doc || doc.type !== 'invoice') return dropLink(db, 'invoice', docId);
    let link = (await getLink(db, 'invoice', docId)) || {};
    const paymentLinks = () =>
      db.all(`SELECT * FROM sync_links WHERE provider = $1 AND entity = 'payment' AND parent_id = $2`, [PROVIDER, docId]);

    // Payments removed here come off in Xero first.
    for (const p of (await paymentLinks()).filter((p) => p.status === 'delete')) await deleteRemotePayment(db, p);

    if (doc.status === 'void') {
      if (link.remote_id && link.hash !== 'void') {
        // Xero only voids an invoice with no payments on it.
        for (const p of (await paymentLinks()).filter((p) => p.remote_id)) await deleteRemotePayment(db, p);
        await api(db, 'POST', 'Invoices', { Invoices: [{ InvoiceID: link.remote_id, Status: 'VOIDED' }] });
      }
      await setLink(db, 'invoice', docId, { hash: 'void', status: 'synced', error: '', synced_at: now() });
      return;
    }
    if (link.hash === 'void') {
      // Restored after being voided in Xero: Xero can't un-void, so send it as a new invoice.
      for (const p of await paymentLinks()) await dropLink(db, 'payment', p.local_id);
      await setLink(db, 'invoice', docId, { remote_id: '', hash: '' });
      link = {};
    }

    const lines = await getLines(db, 'document', docId);
    if (!link.remote_id && lines.length === 0) {
      // Nothing to send until it has items; saving it again queues it.
      await setLink(db, 'invoice', docId, { status: 'skipped', error: '' });
      return;
    }

    const contactLink = await getLink(db, 'contact', doc.customer_id);
    const contactId =
      contactLink && contactLink.remote_id && contactLink.status === 'synced' ? contactLink.remote_id : await pushContact(db, doc.customer_id);
    const payload = invoicePayload(doc, lines, contactId, config);
    const hash = hashOf(payload);

    if (!link.remote_id || link.hash !== hash) {
      // Xero won't change an invoice that has payments, so take them off and put them back after.
      for (const p of (await paymentLinks()).filter((p) => p.remote_id)) await deleteRemotePayment(db, p);
      const res = await api(db, 'POST', 'Invoices', {
        Invoices: [{ ...(link.remote_id ? { InvoiceID: link.remote_id } : {}), ...payload }],
      });
      await setLink(db, 'invoice', docId, { remote_id: res.Invoices[0].InvoiceID, hash, status: 'synced', error: '', synced_at: now() });
      link = await getLink(db, 'invoice', docId);
    }

    // Payments recorded here that Xero doesn't have yet.
    const payments = await db.all('SELECT * FROM payments WHERE document_id = $1 ORDER BY date, id', [docId]);
    const unsent = [];
    for (const p of payments) {
      const pl = await getLink(db, 'payment', p.id);
      if ((!pl || !pl.remote_id) && p.amount_cents > 0) unsent.push(p); // refunds are entered in Xero directly
    }
    if (unsent.length && !config.payment_account) {
      await setLink(db, 'invoice', docId, {
        status: 'synced',
        error: 'Payments not sent: choose the Xero bank account for payments under Settings, Xero.',
      });
      return;
    }
    for (const p of unsent) {
      const res = await api(db, 'PUT', 'Payments', {
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
      await setLink(db, 'payment', p.id, { parent_id: docId, remote_id: res.Payments[0].PaymentID, status: 'synced', error: '', synced_at: now() });
    }
    if (link.error) await setLink(db, 'invoice', docId, { error: '' });
  }

  // ---- Queue ----

  const running = new Map(); // workshopId -> promise
  const timers = new Map(); // workshopId -> timeout
  let autoSync = true;

  async function runPending(db, { retryErrors = false } = {}) {
    const id = db.workshopId;
    if (running.has(id)) return running.get(id);
    const work = (async () => {
      const result = { synced: 0, failed: 0, stopped: '' };
      if (!(await isConnected(db))) return { ...result, stopped: 'not connected' };
      const statuses = retryErrors ? ['pending', 'error'] : ['pending'];
      const rows = await db.all(
        `SELECT entity, local_id FROM sync_links
         WHERE provider = $1 AND entity IN ('contact', 'invoice') AND status = ANY($2)
         ORDER BY entity = 'invoice', local_id`,
        [PROVIDER, statuses]
      );
      for (const r of rows) {
        try {
          if (r.entity === 'contact') await pushContact(db, r.local_id);
          else await syncInvoice(db, r.local_id);
          result.synced++;
        } catch (err) {
          if (err.rateLimited || err.authLost) {
            result.stopped = err.message;
            break;
          }
          result.failed++;
          await setLink(db, r.entity, r.local_id, { status: 'error', error: err.message });
        }
      }
      return result;
    })();
    running.set(id, work);
    try {
      return await work;
    } finally {
      running.delete(id);
    }
  }

  function schedule(workshopId) {
    if (!autoSync) return;
    clearTimeout(timers.get(workshopId));
    const t = setTimeout(() => {
      timers.delete(workshopId);
      runPending(store.tenant(workshopId)).catch((err) => console.error(`Xero sync failed for workshop ${workshopId}:`, err));
    }, 1500);
    t.unref?.();
    timers.set(workshopId, t);
  }

  // Called after anything changes an invoice; syncs a moment later in the background.
  async function queueInvoice(db, docId) {
    if (!(await isConnected(db))) return;
    const doc = await db.get('SELECT type FROM documents WHERE id = $1', [docId]);
    if (!doc || doc.type !== 'invoice') return;
    await setLink(db, 'invoice', docId, { status: 'pending', error: '' });
    schedule(db.workshopId);
  }

  async function queueContact(db, customerId) {
    const link = await getLink(db, 'contact', customerId);
    if (!link || !link.remote_id || !(await isConnected(db))) return; // new contacts go with their first invoice
    await setLink(db, 'contact', customerId, { status: 'pending', error: '' });
    schedule(db.workshopId);
  }

  // Remember a synced payment that is being removed here, so it is removed from Xero too.
  async function queuePaymentDeleted(db, paymentId, docId) {
    const link = await getLink(db, 'payment', paymentId);
    if (link && link.remote_id) await setLink(db, 'payment', paymentId, { status: 'delete' });
    else if (link) await dropLink(db, 'payment', paymentId);
    await queueInvoice(db, docId);
  }

  // Queue invoices that have never been sent (for invoices made before connecting).
  async function queueAll(db, sinceDate) {
    const docs = await db.all(
      `SELECT d.id FROM documents d
       WHERE d.type = 'invoice' AND d.issue_date >= $1
         AND NOT EXISTS (SELECT 1 FROM sync_links s WHERE s.provider = $2 AND s.entity = 'invoice' AND s.local_id = d.id)`,
      [sinceDate || '0000-01-01', PROVIDER]
    );
    for (const d of docs) await setLink(db, 'invoice', d.id, { status: 'pending' });
    if (docs.length) schedule(db.workshopId);
    return docs.length;
  }

  // Every few minutes, retry anything still pending (after a rate limit or a restart).
  function startSweep(intervalMs = 5 * 60 * 1000) {
    const t = setInterval(async () => {
      try {
        const workshops = await store.system.all('SELECT id FROM workshops');
        for (const w of workshops) {
          const db = store.tenant(w.id);
          const pending = await db.get(`SELECT 1 FROM sync_links WHERE provider = $1 AND status IN ('pending', 'delete') LIMIT 1`, [PROVIDER]);
          if (pending) await runPending(db);
        }
      } catch (err) {
        console.error('Xero sweep failed:', err);
      }
    }, intervalMs);
    t.unref?.();
    return t;
  }

  const invoiceStatus = (db, docId) => getLink(db, 'invoice', docId);

  function problems(db) {
    return db.all(
      `SELECT s.*, d.number, d.type FROM sync_links s
       LEFT JOIN documents d ON s.entity = 'invoice' AND d.id = s.local_id
       WHERE s.provider = $1 AND (s.status = 'error' OR s.error != '') ORDER BY s.local_id DESC LIMIT 50`,
      [PROVIDER]
    );
  }

  async function counts(db) {
    const rows = await db.all(`SELECT status, COUNT(*) AS n FROM sync_links WHERE provider = $1 AND entity = 'invoice' GROUP BY status`, [PROVIDER]);
    return rows.reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});
  }

  return {
    configured,
    state,
    isConnected,
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
    startSweep,
    invoiceStatus,
    problems,
    counts,
    setAutoSync: (on) => (autoSync = on),
  };
}

module.exports = { createXero, XeroError, DEFAULT_SCOPES };
