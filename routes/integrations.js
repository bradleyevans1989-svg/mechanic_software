const crypto = require('crypto');
const { requireOwner } = require('../lib/auth');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function redirectUri(req) {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return `${base}/xero/callback`;
}

const back = (res, key, msg) => res.redirect(`/integrations?${key}=${encodeURIComponent(msg)}`);

module.exports = function (app, { xero }) {
  app.get('/integrations', requireOwner, async (req, res) => {
    const { row, config, connected } = await xero.state(req.db);
    res.render('integrations', {
      xeroConfigured: xero.configured(),
      connected,
      tenantName: row ? row.tenant_name : '',
      config,
      orgs: !connected && config.pending_orgs ? config.pending_orgs : [],
      counts: connected ? await xero.counts(req.db) : {},
      problems: connected ? await xero.problems(req.db) : [],
      redirectUri: redirectUri(req),
      notice: String(req.query.notice || '').slice(0, 300),
      error: String(req.query.error || '').slice(0, 300),
    });
  });

  app.get('/xero/connect', requireOwner, (req, res) => {
    if (!xero.configured()) return res.redirect('/integrations');
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('xero_state', state, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 10 * 60 * 1000 });
    res.redirect(xero.authorizeUrl(redirectUri(req), state));
  });

  app.get('/xero/callback', requireOwner, async (req, res) => {
    const cookieState = (req.headers.cookie || '').match(/(?:^|;\s*)xero_state=([^;]+)/);
    res.clearCookie('xero_state');
    if (req.query.error) return back(res, 'error', String(req.query.error_description || req.query.error));
    if (!cookieState || cookieState[1] !== req.query.state) return back(res, 'error', 'Xero sign-in expired. Try connecting again.');
    try {
      const orgs = await xero.finishConnect(req.db, String(req.query.code || ''), redirectUri(req));
      if (orgs.length === 0) throw new Error('No Xero organisation was shared with the app.');
      if (orgs.length > 1) {
        await xero.saveConfig(req.db, { pending_orgs: orgs.map((o) => ({ id: o.id, tenantId: o.tenantId, tenantName: o.tenantName })) });
        return res.redirect('/integrations');
      }
      back(res, 'notice', `Connected to ${orgs[0].tenantName}.`);
    } catch (err) {
      back(res, 'error', err.message);
    }
  });

  app.post('/xero/tenant', requireOwner, async (req, res) => {
    const { config } = await xero.state(req.db);
    const org = (config.pending_orgs || []).find((o) => o.tenantId === req.body.tenant_id);
    if (!org) return res.redirect('/integrations');
    await xero.setTenant(req.db, org.tenantId, org.tenantName, org.id);
    back(res, 'notice', `Connected to ${org.tenantName}.`);
  });

  app.post('/xero/settings', requireOwner, async (req, res) => {
    const code = (k) => String(req.body[k] || '').trim().slice(0, 10);
    const taxType = (k) => String(req.body[k] || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 30);
    await xero.saveConfig(req.db, {
      labour_account: code('labour_account') || '200',
      parts_account: code('parts_account') || '200',
      other_account: code('other_account') || '200',
      payment_account: code('payment_account'),
      gst_tax_type: taxType('gst_tax_type') || 'OUTPUT',
      free_tax_type: taxType('free_tax_type') || 'EXEMPTOUTPUT',
      pull_payments: req.body.pull_payments === '1',
      send_bills: req.body.send_bills === '1',
      bills_account: code('bills_account') || '300',
      bill_gst_tax_type: taxType('bill_gst_tax_type') || 'INPUT',
      bill_free_tax_type: taxType('bill_free_tax_type') || 'EXEMPTEXPENSES',
      bill_status: req.body.bill_status === 'AUTHORISED' ? 'AUTHORISED' : 'DRAFT',
    });
    back(res, 'notice', 'Xero settings saved.');
  });

  app.post('/xero/send-past', requireOwner, async (req, res) => {
    const since = DATE_RE.test(req.body.since || '') ? req.body.since : res.locals.today;
    const n = await xero.queueAll(req.db, since);
    back(res, 'notice', `${n} invoice${n === 1 ? '' : 's'} queued for Xero.`);
  });

  app.post('/xero/sync', requireOwner, async (req, res) => {
    const r = await xero.runPending(req.db, { retryErrors: true, pull: true });
    if (r.stopped) return back(res, 'notice', `Sync stopped: ${r.stopped}`);
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const fromXero = [
      r.paymentsAdded ? `${plural(r.paymentsAdded, 'payment')} added from Xero` : '',
      r.paymentsRemoved ? `${plural(r.paymentsRemoved, 'payment')} removed in Xero taken off` : '',
    ].filter(Boolean);
    back(res, 'notice', [`Sent ${r.synced} to Xero${r.failed ? `, ${r.failed} failed` : ''}`, ...fromXero].join('; ') + '.');
  });

  app.post('/xero/disconnect', requireOwner, async (req, res) => {
    await xero.disconnect(req.db);
    back(res, 'notice', 'Disconnected from Xero.');
  });

  // "Send to Xero now" on a received parts order.
  app.post('/purchase-orders/:id/xero', async (req, res) => {
    await xero.queueBill(req.db, Number(req.params.id));
    await xero.runPending(req.db, { retryErrors: true });
    res.redirect(`/purchase-orders/${req.params.id}`);
  });

  // "Send to Xero now" on an invoice.
  app.post('/documents/:id/xero', async (req, res) => {
    await xero.queueInvoice(req.db, Number(req.params.id));
    await xero.runPending(req.db, { retryErrors: true });
    res.redirect(`/documents/${req.params.id}`);
  });
};
